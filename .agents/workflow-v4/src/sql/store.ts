// repo-local SQLite store。schema の適用、repository metadata の照合、lookup、receipt を持つ。
// 依存ゼロを保つため、runtime の SQLite binding は `SqlDriver` の後ろに置く。

import { err, ok, type Result } from "../result.ts";
import {
  componentAddress,
  type ComponentId,
  type DeviceId,
  type EventId,
  parseComponentId,
  parseDeviceId,
  parseEventId,
  parseRepositoryId,
  type RepositoryId,
} from "../ids.ts";
import {
  type ComponentKind,
  type ComponentState,
  parseComponentKind,
  parseRevision,
  parseStatusForKind,
} from "../components.ts";
import type {
  ComponentLookup,
  EventLookup,
  RelationLookup,
  StoredEventSummary,
} from "../decide.ts";
import { parseCommittedDiff } from "../replication.ts";
import { formatComponentAddress } from "../ids.ts";
import { parseRelationType, type RelationKey, relationKeyString } from "../relations.ts";
import type { RepositoryContext } from "../repository.ts";
import { type CommandResponse, parseCommandResponse } from "../responses.ts";
import type { OperationId } from "../ids.ts";
import { rowInteger, rowString, type SqlDriver, type SqlValue } from "./driver.ts";
import { migrateSchema } from "./migrate.ts";
import {
  CONNECTION_PRAGMAS,
  DURABILITY_PRAGMAS,
  SCHEMA_STATEMENTS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_TABLE_NAMES,
} from "./schema.ts";

/** 時刻は注入する。test が実時計に依存せず、transaction 内の順序も固定できる。 */
export type Clock = () => string;

export type OpenStoreOptions = {
  readonly driver: SqlDriver;
  readonly repository_id: unknown;
  readonly device_id: unknown;
  readonly clock?: Clock;
  /** file DB でだけ意味を持つ PRAGMA を流すか。`:memory:` では省いてよい。 */
  readonly durable?: boolean;
  /**
   * 古い schema_version の DB に forward migration を適用して開くか (CLI `--migrate`)。
   * 既定は false で、古い DB は `protocol_incompatible` で拒否する。downward は無い。
   */
  readonly migrate?: boolean;
};

function defaultClock(): string {
  return new Date().toISOString();
}

/** DB に無い initial minimum table。open 時と test の両方から使う。 */
function missingTableNames(driver: SqlDriver): readonly string[] {
  const present = new Set(
    driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => rowString(row, "name"))
      .filter((name): name is string => name !== undefined),
  );
  return WORKFLOW_TABLE_NAMES.filter((name) => !present.has(name));
}

/**
 * schema、repository metadata、local device を 1 transaction で作る。
 * 途中で失敗したら rollback し、部分初期化の DB を残さない。
 */
function initializeSchema(
  driver: SqlDriver,
  repositoryId: RepositoryId,
  deviceId: DeviceId,
  clock: Clock,
): Result<true> {
  driver.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) driver.exec(statement);
    driver
      .prepare(
        "INSERT INTO repository (singleton, repository_id, schema_version, created_at)" +
          " VALUES (1, ?, ?, ?)",
      )
      .run(repositoryId, WORKFLOW_SCHEMA_VERSION, clock());
    driver
      .prepare("INSERT INTO devices (device_id, local_flag, next_event_sequence) VALUES (?, 1, 1)")
      .run(deviceId);
    driver.exec("COMMIT");
    return ok(true);
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err("missing_field", `schema の初期化に失敗した: ${String(cause)}`, "schema");
  }
}

/**
 * repo-local store。1 instance が 1 repository に対応する。
 * 複数 repo を 1 つの DB に同居させない。
 */
/**
 * `operation.list` の絞り込み (裁定 7b gap 2 2026-09-20)。
 *
 * **すべて optional。**client は「何を送ったか」を覚えていない前提なので、絞り込み無しでも
 * 新しい順に引ける必要がある。
 */
export type OperationListFilter = {
  /** その component を target にした operation だけ。 */
  readonly component_id?: string;
  /** cross-repo の追跡 key。step を跨いで同じ値を持つ。 */
  readonly correlation_id?: string;
  /** response をまだ持たない operation だけ。 */
  readonly unsettled_only?: boolean;
  /** 1 回で返す上限。既定 50、最大 500。 */
  readonly limit?: number;
};

/** 列挙 1 件。**receipt 全文ではなく、receipt へ戻るための識別子を返す。** */
export type ListedOperation = {
  readonly operation_id: string;
  readonly operation: string;
  /** response を持っているか。**`disposition` の有無から推測させない。** */
  readonly settled: boolean;
  readonly target_component_id?: string;
  readonly correlation_id?: string;
  readonly disposition?: string;
  readonly result_component_id?: string;
  readonly created_at: string;
  readonly processed_at?: string;
};

export type OperationListPage = {
  readonly operations: readonly ListedOperation[];
  /** 実際に使われた上限。要求値と違うことがある。 */
  readonly limit: number;
  /** **上限で切れたか。**false を「これで全部」と読んでよい。 */
  readonly has_more: boolean;
};

export const LISTED_COMPONENT_TITLE_MAX = 240;
export const LISTED_COMPONENT_LOCATOR_MAX = 512;

/** `component.list` / wish-query が共有する、bounded な projection row。 */
export type ListedComponent = {
  readonly component_id: ComponentId;
  readonly kind: ComponentKind;
  readonly status?: ComponentState["status"];
  readonly state_revision: ComponentState["state_revision"];
  readonly title_projection?: string;
  readonly title_truncated: boolean;
  readonly document_locator?: string;
  readonly locator_truncated: boolean;
  readonly birth_iteration?: string;
  readonly updated_at: string;
};

export type ComponentListFilter = {
  readonly component_id?: ComponentId;
  readonly component_kinds?: readonly ComponentKind[];
  readonly status?: string;
  readonly iteration_id?: string;
  /** Workflow state row の更新時刻。document observation の時刻ではない。 */
  readonly state_changed_since?: string;
  /** 1 回で返す上限。caller ごとの上限は dispatch 側がさらに狭める。 */
  readonly limit?: number;
};

export type ComponentListPage = {
  readonly components: readonly ListedComponent[];
  readonly limit: number;
  readonly has_more: boolean;
};

export class SqliteWorkflowStore {
  readonly context: RepositoryContext;
  readonly #driver: SqlDriver;
  readonly #clock: Clock;

  private constructor(driver: SqlDriver, context: RepositoryContext, clock: Clock) {
    this.#driver = driver;
    this.context = context;
    this.#clock = clock;
  }

  get driver(): SqlDriver {
    return this.#driver;
  }

  get clock(): Clock {
    return this.#clock;
  }

  /**
   * DB を開く。空なら schema を作り、既存なら repository_id と schema_version を照合する。
   * repo path は locator であって identity ではないので、identity は必ず row と突き合わせる。
   *
   * **新規初期化は 1 transaction で確定する。** DDL の途中で失敗したとき、`repository` table
   * だけが残ると次回の open が「初期化済み」と誤認して部分 schema のまま動き出す。
   * SQLite は DDL も transaction に入るので、schema、repository metadata、local device を
   * まとめて確定し、失敗したら何も残さない。
   *
   * 既存 DB でも table の欠落を open 時に拒否する。過去に partial な状態で残った DB を
   * そのまま使い始めない。
   */
  static open(options: OpenStoreOptions): Result<SqliteWorkflowStore> {
    const repositoryId = parseRepositoryId(options.repository_id, "repository_id");
    if (!repositoryId.ok) return repositoryId;
    const deviceId = parseDeviceId(options.device_id, "device_id");
    if (!deviceId.ok) return deviceId;

    const driver = options.driver;
    const clock = options.clock ?? defaultClock;
    // PRAGMA は transaction の外で流す。`foreign_keys` は transaction 内では変えられない。
    for (const pragma of CONNECTION_PRAGMAS) driver.exec(pragma);
    if (options.durable === true) {
      for (const pragma of DURABILITY_PRAGMAS) driver.exec(pragma);
    }

    const initialized = driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repository'")
      .get();
    if (initialized === undefined) {
      const created = initializeSchema(driver, repositoryId.value, deviceId.value, clock);
      if (!created.ok) return created;
    }

    // metadata row は table 欠落 check より先に読む。古い version の DB は migration が足す
    // table を持たないのが正常なので、version を確定させる前に欠落を数えると誤診する。
    const metadata = driver
      .prepare("SELECT repository_id, schema_version FROM repository WHERE singleton = 1")
      .get();
    if (metadata === undefined) {
      return err("missing_field", "repository metadata の row が無い", "repository");
    }
    const actualRepositoryId = rowString(metadata, "repository_id");
    if (actualRepositoryId !== repositoryId.value) {
      return err(
        "repository_id_mismatch",
        `DB が持つ repository_id ${
          String(actualRepositoryId)
        } が指定 ${repositoryId.value} と一致しない`,
        "repository_id",
      );
    }
    const schemaVersion = rowInteger(metadata, "schema_version");
    if (schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
      // 実装より新しい DB と、version が整数として読めない DB は migration の対象にしない。
      if (schemaVersion === undefined || schemaVersion > WORKFLOW_SCHEMA_VERSION) {
        return err(
          "protocol_incompatible",
          `schema_version ${
            String(schemaVersion)
          } は実装の ${WORKFLOW_SCHEMA_VERSION} と一致しない`,
          "schema_version",
        );
      }
      if (options.migrate !== true) {
        return err(
          "protocol_incompatible",
          `schema_version ${schemaVersion} は実装の ${WORKFLOW_SCHEMA_VERSION} より古い。` +
            "forward migration が必要。許可するには open option `migrate: true` / CLI `--migrate` を使う",
          "schema_version",
        );
      }
      const migrated = migrateSchema(driver, clock);
      if (!migrated.ok) return migrated;
    }

    const missing = missingTableNames(driver);
    if (missing.length > 0) {
      return err(
        "missing_field",
        `schema が不完全である。欠落している table: ${missing.join(", ")}`,
        "schema",
      );
    }

    // local device row。local_flag=1 は部分 unique index が最大 1 行に保つ。
    const localDevice = driver
      .prepare("SELECT device_id FROM devices WHERE local_flag = 1")
      .get();
    if (localDevice === undefined) {
      return err("missing_field", "local device の row が無い", "devices");
    }
    if (rowString(localDevice, "device_id") !== deviceId.value) {
      return err(
        "invalid_id",
        `DB の local device ${
          String(rowString(localDevice, "device_id"))
        } が指定 ${deviceId.value} と一致しない`,
        "device_id",
      );
    }

    return ok(
      new SqliteWorkflowStore(driver, {
        repository_id: repositoryId.value,
        device_id: deviceId.value,
      }, clock),
    );
  }

  /** ER 図の initial minimum が全て存在するか。schema の取りこぼしを検出する。 */
  tableNames(): readonly string[] {
    return this.#driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => rowString(row, "name"))
      .filter((name): name is string => name !== undefined && !name.startsWith("sqlite_"));
  }

  missingTables(): readonly string[] {
    return missingTableNames(this.#driver);
  }

  /** stable ID で component を引く。無ければ undefined。推測して近いものを返さない。 */
  readonly lookup: ComponentLookup = (componentId: ComponentId) => {
    const row = this.#driver
      .prepare(
        "SELECT component_id, kind, status, state_revision FROM components WHERE component_id = ?",
      )
      .get(componentId);
    if (row === undefined) return undefined;
    const state = this.#toComponentState(row);
    return state.ok ? state.value : undefined;
  };

  /** outgoing relation の存在。`decideCommand()` の duplicate 判定に渡す。 */
  readonly relationLookup: RelationLookup = (key: RelationKey) => {
    const row = this.#driver
      .prepare(
        "SELECT 1 AS present FROM component_relations" +
          " WHERE from_component_id = ? AND to_repository_id = ? AND to_component_id = ?" +
          " AND relation_type = ?",
      )
      .get(
        key.source.component_id,
        key.target.repository_id,
        key.target.component_id,
        key.relation_type,
      );
    return row !== undefined;
  };

  /**
   * committed DomainEvent を event ID で引く (Slice D)。
   *
   * `replication.resolve_conflict` が「採用した event の committed diff」を必要とする。
   * 未解決 conflict かどうかは `EVENT_INBOX` 側にしか無いので、ここで join して返す。
   * local event は inbox row を持たないので `open_conflict` は false になる。
   */
  readonly eventLookup: EventLookup = (eventId: EventId) => {
    const row = this.#driver
      .prepare(
        "SELECT e.event_id AS event_id, e.aggregate_id AS aggregate_id," +
          " e.base_revision AS base_revision, e.aggregate_revision AS aggregate_revision," +
          " e.payload_json AS payload_json, i.disposition AS inbox_disposition," +
          " i.resolved_by_operation_id AS resolved_by_operation_id" +
          " FROM domain_events e LEFT JOIN event_inbox i ON i.event_id = e.event_id" +
          " WHERE e.event_id = ?",
      )
      .get(eventId);
    if (row === undefined) return undefined;
    const aggregateId = parseComponentId(rowString(row, "aggregate_id"));
    if (!aggregateId.ok) return undefined;
    const parsedId = parseEventId(rowString(row, "event_id"));
    if (!parsedId.ok) return undefined;

    let payload: unknown;
    try {
      payload = JSON.parse(rowString(row, "payload_json") ?? "{}");
    } catch {
      return undefined;
    }
    const diff = parseCommittedDiff(payload, "diff", {
      kind_of: (componentId: ComponentId) => this.lookup(componentId)?.kind,
    });
    if (!diff.ok) return undefined;

    const status = diff.value.next_state?.status ??
      diff.value.created.find((entry) => entry.component_id === aggregateId.value)?.status;
    const summary: StoredEventSummary = {
      event_id: parsedId.value,
      aggregate_id: aggregateId.value,
      base_revision: rowInteger(row, "base_revision") ?? 0,
      aggregate_revision: rowInteger(row, "aggregate_revision") ?? 0,
      ...(status === undefined ? {} : { resulting_status: status }),
      added_relations: diff.value.added_relations.map((relation) => ({
        source: componentAddress(this.context.repository_id, aggregateId.value),
        target: componentAddress(relation.to_repository_id, relation.to_component_id),
        relation_type: relation.relation_type,
      })),
      ...((diff.value.removed_relations ?? []).length === 0 ? {} : {
        removed_relations: (diff.value.removed_relations ?? []).map((relation) => ({
          source: componentAddress(this.context.repository_id, aggregateId.value),
          target: componentAddress(relation.to_repository_id, relation.to_component_id),
          relation_type: relation.relation_type,
        })),
      }),
      open_conflict: rowString(row, "inbox_disposition") === "conflict" &&
        rowString(row, "resolved_by_operation_id") === undefined,
    };
    return summary;
  };

  /** 保存済み receipt。未処理の operation では undefined を返す。 */
  getReceipt(operationId: OperationId): CommandResponse | undefined {
    const row = this.#driver
      .prepare("SELECT response_json FROM operations WHERE operation_id = ?")
      .get(operationId);
    if (row === undefined) return undefined;
    const json = rowString(row, "response_json");
    if (json === undefined) return undefined;
    const parsed = parseCommandResponse(JSON.parse(json));
    return parsed.ok ? parsed.value : undefined;
  }

  /**
   * operation ledger の列挙 (裁定 7b gap 2 2026-09-20)。
   *
   * **`operation.list` query の実体。**`getReceipt(operation_id)` は 1 件を引く口なので、
   * **operation_id を失った client は receipt へ戻れない。**client 側へ ID を永続化させると
   * operation の正本が 2 つになるので、repo 側に列挙を置く。
   *
   * 新しい順に返す。`limit` を必ず持ち、**足りなかったことを `has_more` で示す。**黙って
   * 切り詰めると、client が「これで全部」と読む。
   *
   * **`settled` を別 field で持つ。**`disposition` の null と「まだ結果が無い」を、読む側が
   * 推測で結びつけないようにする。
   */
  listOperations(filter: OperationListFilter = {}): OperationListPage {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (filter.component_id !== undefined) {
      where.push("target_component_id = ?");
      args.push(filter.component_id);
    }
    if (filter.correlation_id !== undefined) {
      where.push("correlation_id = ?");
      args.push(filter.correlation_id);
    }
    if (filter.unsettled_only === true) where.push("response_json IS NULL");
    const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    // limit + 1 件引いて、次があるかを件数で判定する。cursor 形は read model と一緒に決める
    // ものなので、ここで page token を作らない。
    const rows = this.#driver
      .prepare(
        "SELECT operation_id, operation_type, target_component_id, correlation_id," +
          " disposition, result_component_id, response_json, created_at, processed_at" +
          ` FROM operations${clause} ORDER BY created_at DESC, operation_id DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    const listed = rows.slice(0, limit).map((row): ListedOperation => {
      const disposition = rowString(row, "disposition");
      return {
        operation_id: rowString(row, "operation_id") ?? "",
        operation: rowString(row, "operation_type") ?? "",
        settled: rowString(row, "response_json") !== undefined,
        ...(rowString(row, "target_component_id") === undefined
          ? {}
          : { target_component_id: rowString(row, "target_component_id") as string }),
        ...(rowString(row, "correlation_id") === undefined
          ? {}
          : { correlation_id: rowString(row, "correlation_id") as string }),
        ...(disposition === undefined ? {} : { disposition }),
        ...(rowString(row, "result_component_id") === undefined
          ? {}
          : { result_component_id: rowString(row, "result_component_id") as string }),
        created_at: rowString(row, "created_at") ?? "",
        ...(rowString(row, "processed_at") === undefined
          ? {}
          : { processed_at: rowString(row, "processed_at") as string }),
      };
    });
    return { operations: listed, limit, has_more: rows.length > limit };
  }

  /**
   * 既存 `components_overview` projection の bounded read。新しい search table は作らない。
   * `limit + 1` で切断を見える化し、updated_at + component_id で決定的に並べる。
   */
  listComponents(filter: ComponentListFilter = {}): ComponentListPage {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (filter.component_id !== undefined) {
      where.push("c.component_id = ?");
      args.push(filter.component_id);
    }
    if (filter.component_kinds !== undefined && filter.component_kinds.length > 0) {
      where.push(`c.kind IN (${filter.component_kinds.map(() => "?").join(", ")})`);
      args.push(...filter.component_kinds);
    }
    if (filter.status !== undefined) {
      where.push("c.status = ?");
      args.push(filter.status);
    }
    if (filter.state_changed_since !== undefined) {
      where.push("c.updated_at >= ?");
      args.push(filter.state_changed_since);
    }
    if (filter.iteration_id !== undefined) {
      where.push(
        "(c.birth_iteration = ? OR EXISTS (SELECT 1 FROM iteration_members im" +
          " WHERE im.component_id = c.component_id AND im.iteration_id = ?))",
      );
      args.push(filter.iteration_id, filter.iteration_id);
    }
    const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    const rows = this.#driver
      .prepare(
        "SELECT c.component_id, c.kind, c.status, c.state_revision," +
          ` substr(c.title_projection, 1, ${LISTED_COMPONENT_TITLE_MAX}) AS title_projection,` +
          ` length(c.title_projection) > ${LISTED_COMPONENT_TITLE_MAX} AS title_truncated,` +
          ` substr(c.document_locator, 1, ${LISTED_COMPONENT_LOCATOR_MAX}) AS document_locator,` +
          ` length(c.document_locator) > ${LISTED_COMPONENT_LOCATOR_MAX} AS locator_truncated,` +
          " c.birth_iteration, c.updated_at" +
          ` FROM components c${clause}` +
          " ORDER BY c.updated_at DESC, c.component_id ASC LIMIT ?",
      )
      .all(...args, limit + 1);
    return {
      components: rows.slice(0, limit).map((row) => this.#toListedComponent(row)),
      limit,
      has_more: rows.length > limit,
    };
  }

  /**
   * 複数の read を同じ SQLite snapshot で評価する。BEGIN DEFERRED は row/file を変更しない。
   * wish-query の subject revision と candidate projection の read race をここで閉じる。
   */
  readSnapshot<T>(read: () => T): T {
    this.#driver.exec("BEGIN DEFERRED");
    try {
      const value = read();
      this.#driver.exec("COMMIT");
      return value;
    } catch (cause) {
      this.#driver.exec("ROLLBACK");
      throw cause;
    }
  }

  /** relation の一覧。表示ではなく test と transaction の検証に使う。 */
  /**
   * outgoing relation を parse 済みの `RelationKey` で返す (裁定 root PM 2026-09-15、Slice F1 の O2-1)。
   *
   * **`relation.list_outgoing` query の実体。** これが無かったので、CLI から relation を確認する
   * 経路が 1 つも無く、F1 harness は SQLite を直読みしていた。
   */
  outgoingRelations(from: ComponentId): readonly RelationKey[] {
    const rows = this.#driver
      .prepare(
        "SELECT to_repository_id, to_component_id, relation_type" +
          " FROM component_relations WHERE from_component_id = ?" +
          " ORDER BY to_repository_id, to_component_id, relation_type",
      )
      .all(from);
    const keys: RelationKey[] = [];
    for (const row of rows) {
      const repositoryId = parseRepositoryId(
        rowString(row, "to_repository_id"),
        "to_repository_id",
      );
      const componentId = parseComponentId(rowString(row, "to_component_id"), "to_component_id");
      const relationType = parseRelationType(rowString(row, "relation_type"), "relation_type");
      // **読めない row を落として「無い」にしない。** 書き込み側が parse 済みの値しか入れないので、
      // ここで落ちるのは DB が壊れている時だけ。その時は件数を減らさず、そのまま throw させる。
      if (!repositoryId.ok || !componentId.ok || !relationType.ok) {
        throw new Error(`component_relations の row を parse できない: from=${from}`);
      }
      keys.push({
        source: componentAddress(this.context.repository_id, from),
        target: componentAddress(repositoryId.value, componentId.value),
        relation_type: relationType.value,
      });
    }
    return keys;
  }

  outgoingRelationKeys(from: ComponentId): readonly string[] {
    return this.#driver
      .prepare(
        "SELECT from_component_id, to_repository_id, to_component_id, relation_type" +
          " FROM component_relations WHERE from_component_id = ?" +
          " ORDER BY to_repository_id, to_component_id, relation_type",
      )
      .all(from)
      .map((row) =>
        [
          formatComponentAddress(
            componentAddress(this.context.repository_id, from),
          ),
          String(rowString(row, "relation_type")),
          `${String(rowString(row, "to_repository_id"))}:${
            String(rowString(row, "to_component_id"))
          }`,
        ].join("|")
      );
  }

  countRows(table: string): number {
    if (!(WORKFLOW_TABLE_NAMES as readonly string[]).includes(table)) {
      throw new Error(`未知の table: ${table}`);
    }
    const row = this.#driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row === undefined ? 0 : rowInteger(row, "n") ?? 0;
  }

  close(): void {
    this.#driver.close();
  }

  #toComponentState(row: Record<string, unknown>): Result<ComponentState> {
    const componentId = parseComponentId(row["component_id"], "component_id");
    if (!componentId.ok) return componentId;
    const kind = parseComponentKind(row["kind"], "kind");
    if (!kind.ok) return kind;
    const status = parseStatusForKind(
      kind.value as ComponentKind,
      row["status"] ?? undefined,
      "status",
    );
    if (!status.ok) return status;
    const revision = parseRevision(rowInteger(row, "state_revision"), "state_revision");
    if (!revision.ok) return revision;
    return ok({
      address: componentAddress(this.context.repository_id, componentId.value),
      kind: kind.value,
      status: status.value,
      state_revision: revision.value,
    });
  }

  #toListedComponent(row: Record<string, unknown>): ListedComponent {
    const state = this.#toComponentState(row);
    const updatedAt = rowString(row, "updated_at");
    if (!state.ok || updatedAt === undefined) {
      throw new Error(`components の row を parse できない: ${JSON.stringify(row)}`);
    }
    const title = rowString(row, "title_projection");
    const locator = rowString(row, "document_locator");
    const birthIteration = rowString(row, "birth_iteration");
    return {
      component_id: state.value.address.component_id,
      kind: state.value.kind,
      ...(state.value.status === undefined ? {} : { status: state.value.status }),
      state_revision: state.value.state_revision,
      ...(title === undefined ? {} : { title_projection: title }),
      title_truncated: (rowInteger(row, "title_truncated") ?? 0) !== 0,
      ...(locator === undefined ? {} : { document_locator: locator }),
      locator_truncated: (rowInteger(row, "locator_truncated") ?? 0) !== 0,
      ...(birthIteration === undefined ? {} : { birth_iteration: birthIteration }),
      updated_at: updatedAt,
    };
  }
}

export { relationKeyString };
export type { DeviceId, EventId, RepositoryId };
