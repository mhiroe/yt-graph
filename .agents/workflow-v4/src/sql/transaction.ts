// local command transaction。
// `docs/candidate/workflow-v4/persistence.md` の「Local command transaction」を 1 つの SQL
// transaction として実装する。state、idempotency の operation record、activity、
// DomainEvent、outbox がこの transaction の中でだけ確定する。

import { err, ok, type Result } from "../result.ts";
import type { ComponentId, DeviceId, OperationId } from "../ids.ts";
import {
  COMPONENT_KINDS,
  type ComponentKind,
  type ComponentState,
  type Revision,
} from "../components.ts";
import {
  allocateSprintId,
  allocateVaultComponentId,
  parseVaultComponentIdForKind,
} from "../vault_ids.ts";
import { WORKFLOW_PROTOCOL_VERSION } from "../protocol.ts";
import type { Command } from "../commands.ts";
import { type CommandDecision, decideCommandWithSprints } from "../decide.ts";
import { parseComponentId } from "../ids.ts";
import { requestDigest } from "../idempotency.ts";
import type { RelationKey } from "../relations.ts";
import type { CommandResponse } from "../responses.ts";
import { rowString } from "./driver.ts";
import { applyIterationEffect, iterationLookupOf, stampBirthIteration } from "./iterations.ts";
import { applySprintEffect, sprintById, sprintLookupOf } from "./sprints.ts";
import { locatorResolverOf } from "./document_projection.ts";
import type { SqliteWorkflowStore } from "./store.ts";

/** component ID の採番。既定は operation_id から決まるので、crash 後の再送でも同じ ID になる。 */
export type ComponentIdAllocator = (command: Command) => Result<ComponentId>;

export type RunCommandOptions = {
  readonly allocate_component_id?: ComponentIdAllocator;
};

/** 既定の採番。外部依存を足さず、同じ operation_id なら必ず同じ ID を返す。 */
export const allocateFromOperationId: ComponentIdAllocator = (command) =>
  parseComponentId(`c-${command.operation_id}`, "allocated_component_id");

/**
 * 実 vault へ書く ID の採番 (裁定 root PM 2026-09-15)。
 *
 * `my-wish-data.md` の `id` 節が定める `<prefix>-<Crockford base32 10 桁>` を作る。
 * **内部 DB / fixture / 自動 test は `allocateFromOperationId` のままでよい。** 1 つの vault で
 * 2 つの形を混ぜないために、実 vault を触る入口だけがこちらを使う。
 *
 * **`allocateFromOperationId` と違って決定的ではない** (timestamp 由来)。replay の同一性は
 * idempotency ledger が持っており、同じ `operation_id` の再送は採番前に最初の response を
 * 返すので、ここが決定的である必要は無い。
 */
export function vaultComponentIdAllocator(
  store: SqliteWorkflowStore,
  clock: () => number = () => Date.now(),
): ComponentIdAllocator {
  return (command: Command) => {
    const kind = allocatedKind(command);
    if (kind === undefined) {
      return err(
        "unknown_component_kind",
        `${command.operation} が作る component の kind を決められない`,
        "payload.kind",
      );
    }
    return allocateVaultComponentId(
      kind,
      clock(),
      (candidate) => store.lookup(candidate) !== undefined,
    );
  };
}

/** 採番対象の kind。register は payload、planned Task は operation が決める。 */
function allocatedKind(command: Command): ComponentKind | undefined {
  if (command.operation === "task.create_planned") return "task";
  if (command.operation !== "component.register") return undefined;
  const kind = command.payload["kind"];
  return COMPONENT_KINDS.find((candidate) => candidate === kind);
}

/** `registerExistingVaultComponent` の入力。`component_id` は vault 形の既存 ID を文字列で渡す。 */
export type RegisterExistingVaultComponentInput = {
  readonly operation_id: OperationId;
  /** 既存の vault ID (`<m|w|t>-<Crockford base32 10 桁>`)。形と kind/prefix の一致はこの口が検査する。 */
  readonly component_id: string;
  readonly kind: ComponentKind;
  readonly actor_ref: string;
  /** 省略時は store の local device。 */
  readonly source_device_id?: DeviceId;
  readonly title?: string;
  readonly locator?: string;
  readonly correlation_id?: string;
};

/**
 * 既存の vault ID を持つ component の登録 (bugfix 6、2026-09-22)。
 *
 * 実 vault の copy のように、Markdown 側に先に `m-` / `w-` / `t-` の ID が在る場合に、その ID を
 * **採番ではなく指定**して COMPONENTS へ載せる口。`component.register` の allocator 経路では
 * ID を指定できず、この口が無いと copy 上の mind -> wish は全件 `wish_not_registered` になる。
 *
 * 返す挙動:
 *
 * - ID の形と kind/prefix の一致は `parseVaultComponentIdForKind` が検査し、食い違いは
 *   `component_id_kind_mismatch`、vault 形でない値は `invalid_id` の `err` を返す (disposition でなく)。
 * - 同じ ID・同じ kind の再登録は `noop` (duplicate relation attach と同じ規則。decide が決める)。
 * - 同じ ID・別 kind との衝突は `rejected`。
 * - 同じ `operation_id` の再送は idempotency ledger が最初の response をそのまま返す。
 */
export function registerExistingVaultComponent(
  store: SqliteWorkflowStore,
  input: RegisterExistingVaultComponentInput,
): Result<CommandResponse> {
  const componentId = parseVaultComponentIdForKind(
    input.kind,
    input.component_id,
    "component_id",
  );
  if (!componentId.ok) return componentId;
  const actorRef = input.actor_ref;
  if (actorRef.length === 0 || actorRef.length > 128) {
    return err(
      "invalid_field_type",
      "actor_ref は 1..128 文字の string である必要がある",
      "actor_ref",
    );
  }
  const command: Command = {
    protocol_version: WORKFLOW_PROTOCOL_VERSION,
    repository_id: store.context.repository_id,
    operation_id: input.operation_id,
    operation: "component.register",
    actor_ref: actorRef,
    source_device_id: input.source_device_id ?? store.context.device_id,
    payload: {
      kind: input.kind,
      // 指定 ID は allocator 経由だけでなく payload にも入れる。request digest は
      // 正規形の payload を含むので、ここに無いと「同じ operation_id で違う
      // component_id の再送」が digest 一致になり、1 回目の response を replay して
      // 未登録のまま成功に見える。
      component_id: componentId.value,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.locator === undefined ? {} : { locator: input.locator }),
      ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
    },
  };
  // allocator は指定された ID をそのまま返すだけ。**採番ではなく結合。** 既登録 ID の
  // noop / rejected は decide が決めるので、ここでは lookup しない。
  return runLocalCommand(store, command, {
    allocate_component_id: () => ok(componentId.value),
  });
}

/**
 * 一つの typed command を一 SQL transaction で処理する。
 *
 * `persistence.md` の順序に対し 1 点だけ実装側で確定させたことがある。OPERATIONS の row を
 * 最後に INSERT するのではなく、**先頭で claim row として INSERT し、末尾で disposition と
 * response を UPDATE する**。ACTIVITIES.causing_operation_id が OPERATIONS への FK なので、
 * 最後に INSERT すると activity 側が先に書けない。claim を先に置くと operation_id の一意性も
 * DB 側で同時に取れる。docs の「OPERATIONS へ disposition / response を保存」は末尾のままで、
 * 変わるのは row を作る位置だけ。
 */
export function runLocalCommand(
  store: SqliteWorkflowStore,
  command: Command,
  options: RunCommandOptions = {},
): Result<CommandResponse> {
  if (command.repository_id !== store.context.repository_id) {
    return err(
      "repository_id_mismatch",
      `command の repository_id ${command.repository_id} が store と一致しない`,
      "repository_id",
    );
  }

  const driver = store.driver;
  const now = store.clock();
  const digest = requestDigest(command);

  driver.exec("BEGIN IMMEDIATE");
  try {
    // 1. operation_id / request_digest の dedupe。
    const existing = driver
      .prepare("SELECT request_digest, response_json FROM operations WHERE operation_id = ?")
      .get(command.operation_id);
    if (existing !== undefined) {
      driver.exec("ROLLBACK");
      if (rowString(existing, "request_digest") !== digest) {
        return err(
          "operation_id_reused",
          `operation_id ${command.operation_id} が異なる request digest で再利用された`,
          "operation_id",
        );
      }
      const stored = store.getReceipt(command.operation_id);
      if (stored === undefined) {
        return err(
          "missing_field",
          `operation ${command.operation_id} が response を持たない`,
          "response_json",
        );
      }
      // 同じ command の再送。最初の response をそのまま返す。register replay も同じ ID を返す。
      return ok(stored);
    }

    const correlationId = stringField(command, "correlation_id");
    driver
      .prepare(
        "INSERT INTO operations (operation_id, target_component_id, operation_type," +
          " expected_revision, actor_ref, source_device_id, correlation_id, request_digest," +
          " payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        command.operation_id,
        command.target_id ?? null,
        command.operation,
        command.expected_revision ?? null,
        command.actor_ref,
        command.source_device_id,
        correlationId,
        digest,
        JSON.stringify(command.payload),
        now,
      );

    // 2. expected state_revision と domain invariant の検証。
    const allocator = options.allocate_component_id ?? allocateFromOperationId;
    // **component id を採番するのは component を作る 2 op だけ。**`iteration.*` も
    // `target_id: forbidden` だが component を作らないので採番しない (iteration_id は
    // decide が `it-<operation_id>` で決定的に置く)。
    const needsAllocation = command.operation === "component.register" ||
      command.operation === "task.create_planned";
    let allocated: ComponentId | undefined;
    if (needsAllocation) {
      const result = allocator(command);
      if (!result.ok) {
        driver.exec("ROLLBACK");
        return result;
      }
      allocated = result.value;
    }
    // sprint id は component ID の採番経路とは別。`sp-<Crockford 10>` を衝突スキップで
    // 採る。replay の同一性は operation ledger が持つ (component ID と同じ裁定)。
    let allocatedSprintId: string | undefined;
    if (command.operation === "sprint.issue") {
      const result = allocateSprintId(
        Date.now(),
        (candidate) => sprintById(driver, candidate) !== undefined,
      );
      if (!result.ok) {
        driver.exec("ROLLBACK");
        return result;
      }
      allocatedSprintId = result.value;
    }

    // storage を持つ経路なので relation / event / iteration / sprint を認識する入口を
    // 必ず使う。duplicate attach の noop も conflict resolve も iteration の seq 採番も
    // この adapter の保証であり、呼び出し側の選択にしない。
    const decided = decideCommandWithSprints({
      command,
      context: store.context,
      lookup: store.lookup,
      relationLookup: store.relationLookup,
      eventLookup: store.eventLookup,
      iterationLookup: iterationLookupOf(driver),
      documentLocatorLookup: locatorResolverOf(store),
      sprintLookup: sprintLookupOf(driver),
      now,
      ...(allocated === undefined ? {} : { allocated_component_id: allocated }),
      ...(allocatedSprintId === undefined ? {} : { allocated_sprint_id: allocatedSprintId }),
    });
    if (!decided.ok) {
      driver.exec("ROLLBACK");
      return decided;
    }
    const decision = decided.value;

    // 3-7. state / relation / activity / event / outbox を同じ transaction で確定する。
    const written = applyDecision(store, command, decision, now);
    if (!written.ok) {
      driver.exec("ROLLBACK");
      return written;
    }

    // 8. disposition と response を確定する。
    driver
      .prepare(
        "UPDATE operations SET disposition = ?, result_component_id = ?, response_json = ?," +
          " applied_revision = ?, processed_at = ? WHERE operation_id = ?",
      )
      .run(
        decision.response.disposition,
        decision.response.created_ids[0]?.component_id ?? null,
        JSON.stringify(decision.response),
        decision.response.state_revision ?? null,
        now,
        command.operation_id,
      );

    driver.exec("COMMIT");
    return ok(decision.response);
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `local command transaction が失敗した: ${String(cause)}`,
      command.operation,
    );
  }
}

type WriteOutcome = {
  /** DomainEvent を出したか。state も履歴も動かない disposition では出さない。 */
  readonly emitted_event: boolean;
};

function applyDecision(
  store: SqliteWorkflowStore,
  command: Command,
  decision: CommandDecision,
  now: string,
): Result<WriteOutcome> {
  const driver = store.driver;

  // 3. COMPONENTS。作成が先。relation と event の FK がここに依存する。
  for (const created of decision.created_states ?? []) {
    driver
      .prepare(
        "INSERT INTO components (component_id, kind, title_projection, status, state_revision," +
          " document_projection_revision, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        created.address.component_id,
        created.kind,
        stringField(command, "title"),
        created.status ?? null,
        created.state_revision,
        now,
        now,
      );
    // schema 7: locator が iteration dir (`<dir>/{docs|spec|app}/`) を指すなら
    // birth_iteration を写す。membership の行き先は payload の `iteration_id` (明示)
    // → scope の default の順。default が無く active が在る scope では decide が
    // 先に fail closed するので、ここに来るまでに解決済み。
    stampBirthIteration(
      driver,
      created.address.component_id,
      stringField(command, "locator"),
      now,
      stringField(command, "iteration_id") ?? undefined,
    );
  }
  const next = decision.next_state;
  if (next !== undefined) {
    driver
      .prepare(
        "UPDATE components SET status = ?, state_revision = ?, updated_at = ? WHERE component_id = ?",
      )
      .run(next.status ?? null, next.state_revision, now, next.address.component_id);
  }

  // 4. COMPONENT_RELATIONS。duplicate は decide 側で noop になっているのでここには来ない。
  for (const relation of decision.added_relations ?? []) {
    driver
      .prepare(
        "INSERT INTO component_relations (from_component_id, to_repository_id, to_component_id," +
          " relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        relation.source.component_id,
        relation.target.repository_id,
        relation.target.component_id,
        relation.relation_type,
        now,
      );
  }

  // 4b. relation の除去 (`relation.detach`)。存在しない relation は decide 側で noop になる。
  for (const relation of decision.removed_relations ?? []) {
    driver
      .prepare(
        "DELETE FROM component_relations WHERE from_component_id = ?" +
          " AND to_repository_id = ? AND to_component_id = ? AND relation_type = ?",
      )
      .run(
        relation.source.component_id,
        relation.target.repository_id,
        relation.target.component_id,
        relation.relation_type,
      );
  }

  // 4c. iteration (schema 7)。component state ではないので anchor/event とは別に書く。
  // **domain_events へは流れない** — iteration op はこの cut では replicate しない
  // (裁定: open/activate/deactivate/set_default/switch/carry/dispose は
  // `iteration_effect` で確定し event を持たない)。
  if (decision.iteration_effect !== undefined) {
    const applied = applyIterationEffect(driver, command, decision.iteration_effect, now);
    if (!applied.ok) return applied;
  }

  // 4d. sprint (schema 8)。iteration と同じく domain_events へは流れない。
  if (decision.sprint_effect !== undefined) {
    const applied = applySprintEffect(driver, decision.sprint_effect, now);
    if (!applied.ok) return applied;
  }

  // manual conflict resolve が解決した inbox row に、解決した operation を刻む。
  // disposition は `conflict` のまま残す。**何が起きたかの記録を消さない。**
  // 「未解決の conflict」は disposition だけでなく resolved_by_operation_id で決まる。
  // 競合 set には local event (inbox row を持たない) も混ざるので、当たらない ID は素通りする。
  for (const eventId of decision.resolved_event_ids ?? []) {
    driver
      .prepare(
        "UPDATE event_inbox SET resolved_by_operation_id = ?, processed_at = ?" +
          " WHERE event_id = ? AND resolved_by_operation_id IS NULL",
      )
      .run(command.operation_id, now, eventId);
  }

  const anchor = anchorComponent(decision, command);
  if (anchor === undefined) {
    // state も履歴も動かない disposition (noop / rejected / conflict / not_found)。
    return ok({ emitted_event: false });
  }

  // 5. ACTIVITIES。local command が起点なので causing_event_id は NULL のままにする。
  if (decision.appends_activity) {
    driver
      .prepare(
        "INSERT INTO activities (activity_id, component_id, activity_type, actor_ref," +
          " correlation_id, component_revision, causing_operation_id, detail_json, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `act-${command.operation_id}`,
        anchor.component_id,
        activityType(command),
        command.actor_ref,
        stringField(command, "correlation_id"),
        anchor.revision,
        command.operation_id,
        activityDetail(command),
        now,
      );
  }

  // 6. DEVICES.next_event_sequence の採番。BEGIN IMMEDIATE を持っているので read-modify-write でよい。
  const deviceRow = driver
    .prepare("SELECT next_event_sequence FROM devices WHERE device_id = ?")
    .get(store.context.device_id);
  if (deviceRow === undefined) {
    return err("invalid_id", `local device ${store.context.device_id} の row が無い`, "device_id");
  }
  const sequence = Number(deviceRow["next_event_sequence"]);
  driver
    .prepare("UPDATE devices SET next_event_sequence = ? WHERE device_id = ?")
    .run(sequence + 1, store.context.device_id);

  // 7. DOMAIN_EVENTS と EVENT_OUTBOX。received event は outbox へ入れないので、ここは local だけ。
  const eventId = `ev-${command.operation_id}`;
  driver
    .prepare(
      "INSERT INTO domain_events (event_id, causation_operation_id, aggregate_id, event_type," +
        " base_revision, aggregate_revision, source_device_id, source_sequence, payload_json," +
        " committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      eventId,
      command.operation_id,
      anchor.component_id,
      command.operation,
      anchor.base_revision,
      anchor.revision,
      store.context.device_id,
      sequence,
      JSON.stringify(committedDiff(decision, command)),
      now,
    );
  driver
    .prepare(
      "INSERT INTO event_outbox (event_id, publication_state, attempt_count) VALUES (?, 'pending', 0)",
    )
    .run(eventId);

  return ok({ emitted_event: true });
}

type Anchor = {
  readonly component_id: ComponentId;
  readonly base_revision: Revision;
  readonly revision: Revision;
};

/**
 * event と activity が指す component。
 * `applied` でないか、state も履歴も動かない decision では undefined を返す。
 */
function anchorComponent(decision: CommandDecision, command: Command): Anchor | undefined {
  if (decision.response.disposition !== "applied") return undefined;
  const created = decision.created_states ?? [];
  const next = decision.next_state;
  if (next !== undefined) {
    return {
      component_id: next.address.component_id,
      base_revision: next.state_revision - 1,
      revision: next.state_revision,
    };
  }
  const first = created[0];
  if (first !== undefined) {
    return {
      component_id: first.address.component_id,
      base_revision: first.state_revision,
      revision: first.state_revision,
    };
  }
  // 裁定 (Slice B): activity.append は state_revision を消費しない。
  // それでも repo 所有の durable な行が増えるので、observable な committed 変更として event は出す。
  // base_revision と aggregate_revision は等しくなり、revision を消費しないことが event 側にも出る。
  if (decision.appends_activity && command.target_id !== undefined) {
    const revision = decision.response.state_revision ?? 0;
    return { component_id: command.target_id, base_revision: revision, revision };
  }
  return undefined;
}

/**
 * event payload に載せる committed diff (Slice D で形を確定)。
 *
 * **remote 側がこの diff だけで同じ state を作れる形にする。** Slice B の形は `created_ids` を
 * address だけで持っていたので、remote は `COMPONENTS` の `kind` を決められなかった。
 * `kind` と `status` と `state_revision` をここで載せる。
 *
 * **document projection (title / locator / observed_hash) は載せない。** 観測は device ごとの
 * local projection であり、workflow event として配信しないと `interfaces.md` が決めている。
 *
 * 形の定義と parse は `src/replication.ts` の `CommittedDiff` が正本。
 */
function committedDiff(decision: CommandDecision, command: Command): Record<string, unknown> {
  const activityDetailValue = command.payload["detail"];
  return {
    created: (decision.created_states ?? []).map((state) => ({
      component_id: state.address.component_id,
      kind: state.kind,
      ...(state.status === undefined ? {} : { status: state.status }),
      state_revision: state.state_revision,
    })),
    ...(decision.next_state === undefined ? {} : {
      next_state: {
        component_id: decision.next_state.address.component_id,
        ...(decision.next_state.status === undefined ? {} : { status: decision.next_state.status }),
        state_revision: decision.next_state.state_revision,
      },
    }),
    added_relations: (decision.added_relations ?? []).map((relation: RelationKey) => ({
      to_repository_id: relation.target.repository_id,
      to_component_id: relation.target.component_id,
      relation_type: relation.relation_type,
    })),
    // **空なら field ごと出さない。** `DIFF_FIELDS` は whitelist なので、常に出すと
    // `0.5.0` を pin した受信側が全 record を `unexpected_field` で落とす。
    ...(decision.removed_relations === undefined || decision.removed_relations.length === 0 ? {} : {
      removed_relations: decision.removed_relations.map((relation: RelationKey) => ({
        to_repository_id: relation.target.repository_id,
        to_component_id: relation.target.component_id,
        relation_type: relation.relation_type,
      })),
    }),
    ...(decision.resolved_event_ids === undefined || decision.resolved_event_ids.length === 0
      ? {}
      : { resolved_event_ids: decision.resolved_event_ids }),
    ...(decision.appends_activity
      ? {
        activity: {
          activity_type: activityType(command),
          actor_ref: command.actor_ref,
          ...(typeof activityDetailValue === "object" && activityDetailValue !== null &&
              !Array.isArray(activityDetailValue)
            ? { detail: activityDetailValue }
            : {}),
        },
      }
      : {}),
  };
}

function activityType(command: Command): string {
  const declared = command.payload["activity_type"];
  return typeof declared === "string" ? declared : command.operation;
}

function activityDetail(command: Command): string | null {
  const detail = command.payload["detail"];
  return detail === undefined ? null : JSON.stringify(detail);
}

function stringField(command: Command, name: string): string | null {
  const value = command.payload[name];
  return typeof value === "string" ? value : null;
}

export type { ComponentState };
