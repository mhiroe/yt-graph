// replication の persistence (Slice D)。
// `docs/candidate/workflow-v4/persistence.md` の「Remote event transaction」「Journal publish」
// 「Change feed と replication cursor」を実装する。
//
// **local event だけを outbox へ入れ、received event は outbox へ入れない。**
// **repository ID で namespace した committed diff だけを送る。** snapshot、heartbeat、
// transcript、SQLite file を送らない。

import { err, ok, type Result } from "../result.ts";
import {
  type ComponentId,
  type DeviceId,
  type EventId,
  parseComponentId,
  parseDeviceId,
  parseEventId,
} from "../ids.ts";
import type { Revision } from "../components.ts";
import { parseOperationName } from "../commands.ts";
import type { RepoCursor } from "../changes.ts";
import {
  advanceContiguous,
  type CommittedDiff,
  type InboxDisposition,
  inboxDispositionOf,
  type JournalRecord,
  parseCommittedDiff,
  type PublicationState,
  type RemoteApplyOutcome,
  type RemoteApplyResult,
} from "../replication.ts";
import { rowInteger, rowString, type SqlRow } from "./driver.ts";
import type { SqliteWorkflowStore } from "./store.ts";

/** 1 度に claim する outbox の既定件数。batch payload 量の実測で動かす。 */
export const DEFAULT_PUBLISH_BATCH = 64;

// --- Journal publish -------------------------------------------------------

/**
 * publish 待ちの local event を claim する。
 *
 * `pending` と `failed` を対象にし、**claim した時点で `publishing` にする**。ここで
 * `published` にしないのは、Journal へ書き終える前に process が落ちると event を失うため。
 * 確定は `markPublished()` が行う (`interfaces.md` の `exchange.mark_published`)。
 */
export function claimOutboxBatch(
  store: SqliteWorkflowStore,
  limit: number = DEFAULT_PUBLISH_BATCH,
): Result<readonly JournalRecord[]> {
  const driver = store.driver;
  const now = store.clock();
  driver.exec("BEGIN IMMEDIATE");
  try {
    const rows = driver
      .prepare(
        "SELECT e.event_id AS event_id, e.causation_operation_id AS causation_operation_id," +
          " e.aggregate_id AS aggregate_id, e.event_type AS event_type," +
          " e.base_revision AS base_revision, e.aggregate_revision AS aggregate_revision," +
          " e.source_device_id AS source_device_id, e.source_sequence AS source_sequence," +
          " e.payload_json AS payload_json, e.committed_at AS committed_at" +
          " FROM event_outbox o JOIN domain_events e ON e.event_id = o.event_id" +
          " WHERE o.publication_state IN ('pending', 'failed')" +
          " ORDER BY e.source_sequence LIMIT ?",
      )
      .all(limit);

    const records: JournalRecord[] = [];
    for (const row of rows) {
      const record = toJournalRecord(store, row);
      if (!record.ok) {
        driver.exec("ROLLBACK");
        return record;
      }
      records.push(record.value);
      driver
        .prepare(
          "UPDATE event_outbox SET publication_state = 'publishing'," +
            " attempt_count = attempt_count + 1, last_attempt_at = ? WHERE event_id = ?",
        )
        .run(now, record.value.event_id);
    }
    driver.exec("COMMIT");
    return ok(records);
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `outbox の claim に失敗した: ${String(cause)}`,
      "event_outbox",
    );
  }
}

/** Journal へ書き終えた event を確定する。initial version は peer 全員の ack を待たない。 */
export function markPublished(
  store: SqliteWorkflowStore,
  eventIds: readonly EventId[],
): Result<number> {
  return updatePublicationState(store, eventIds, "published", true);
}

/** 送信に失敗した event を再 claim 可能へ戻す。attempt_count は claim 側が進めている。 */
export function markPublishFailed(
  store: SqliteWorkflowStore,
  eventIds: readonly EventId[],
): Result<number> {
  return updatePublicationState(store, eventIds, "failed", false);
}

/**
 * outbox の指定 `publication_state` の event id を列挙する。
 * `publishing` に残ったままの行 (claim 後に落ちた stuck claim) を拾う sweeper 側の読み口。
 */
export function listOutboxEventIds(
  store: SqliteWorkflowStore,
  state: PublicationState,
): Result<readonly EventId[]> {
  const rows = store.driver
    .prepare("SELECT event_id FROM event_outbox WHERE publication_state = ? ORDER BY event_id")
    .all(state);
  const ids: EventId[] = [];
  for (const row of rows) {
    const parsed = parseEventId(rowString(row, "event_id"), "event_id");
    if (!parsed.ok) return parsed;
    ids.push(parsed.value);
  }
  return ok(ids);
}

function updatePublicationState(
  store: SqliteWorkflowStore,
  eventIds: readonly EventId[],
  state: "published" | "failed",
  stampPublishedAt: boolean,
): Result<number> {
  const driver = store.driver;
  const now = store.clock();
  driver.exec("BEGIN IMMEDIATE");
  try {
    let updated = 0;
    for (const eventId of eventIds) {
      const exists = driver
        .prepare("SELECT event_id FROM event_outbox WHERE event_id = ?")
        .get(eventId);
      if (exists === undefined) continue;
      driver
        .prepare(
          "UPDATE event_outbox SET publication_state = ?, published_at = ? WHERE event_id = ?",
        )
        .run(state, stampPublishedAt ? now : null, eventId);
      updated += 1;
    }
    driver.exec("COMMIT");
    return ok(updated);
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `outbox の publication_state 更新に失敗した: ${String(cause)}`,
      "event_outbox",
    );
  }
}

/** 未 publish の件数。実測と CLI status が使う。 */
export function pendingPublishCount(store: SqliteWorkflowStore): number {
  const row = store.driver
    .prepare(
      "SELECT COUNT(*) AS n FROM event_outbox WHERE publication_state != 'published'",
    )
    .get();
  return row === undefined ? 0 : rowInteger(row, "n") ?? 0;
}

// --- Remote event transaction ----------------------------------------------

/**
 * remote event 1 件を 1 transaction で適用する。
 *
 * persistence.md の順序に対し、Slice B の OPERATIONS claim と同じ種類の実装側確定が 2 つある。
 *
 * 1. **`DOMAIN_EVENTS` を `EVENT_INBOX` より先に書く。** `EVENT_INBOX.event_id` が
 *    `DOMAIN_EVENTS` への FK なので、materialize を先にすると inbox 側が書けない。docs の
 *    「EVENT_INBOX へ materialize」は「この event を受け取った事実を残す」意味のまま変わらず、
 *    動くのは row を作る順序だけ。
 * 2. **aggregate が local に無い event は materialize できない。** `DOMAIN_EVENTS.aggregate_id`
 *    が `COMPONENTS` への FK なので、component を作る event 以外は row を置く場所が無い。
 *    この場合だけ `deferred` を **durable=false** で返し、DB へ何も書かない。sender の再送が要る
 *    (`event_id` の dedupe があるので二重適用にはならない)。placeholder component を作って
 *    埋めることはしない。ID だけの draft row を推測で作ることになる。
 */
export function applyRemoteEvent(
  store: SqliteWorkflowStore,
  record: JournalRecord,
): Result<RemoteApplyResult> {
  if (record.repository_id !== store.context.repository_id) {
    return err(
      "repository_id_mismatch",
      `journal record の repository_id ${record.repository_id} が store と一致しない`,
      "repository_id",
    );
  }
  if (record.source_device_id === store.context.device_id) {
    // 自分が出した event が戻ってきている。適用すると自分の sequence 空間を壊す。
    return err(
      "replication_source_is_local",
      `source_device_id ${record.source_device_id} は local device である`,
      "source_device_id",
    );
  }

  const driver = store.driver;
  const now = store.clock();
  driver.exec("BEGIN IMMEDIATE");
  try {
    // 1. event_id と (source device, sequence) の両方で dedupe する。
    const known = driver
      .prepare("SELECT event_id FROM domain_events WHERE event_id = ?")
      .get(record.event_id);
    if (known !== undefined) {
      driver.exec("ROLLBACK");
      return ok(result(record, "duplicate", true, { reason: "同じ event_id を受信済み" }));
    }
    const occupied = driver
      .prepare(
        "SELECT event_id FROM domain_events WHERE source_device_id = ? AND source_sequence = ?",
      )
      .get(record.source_device_id, record.source_sequence);
    if (occupied !== undefined) {
      driver.exec("ROLLBACK");
      return err(
        "journal_sequence_reused",
        `${record.source_device_id}:${record.source_sequence} は event ${
          String(rowString(occupied, "event_id"))
        } が使っている`,
        "source_sequence",
      );
    }

    // 2. remote device と cursor row を用意する。device_id は再利用されない前提で足すだけ。
    ensureRemoteDevice(store, record.source_device_id, now);
    driver
      .prepare(
        "UPDATE replication_cursors SET last_seen_sequence = MAX(last_seen_sequence, ?)," +
          " updated_at = ? WHERE source_device_id = ?",
      )
      .run(record.source_sequence, now, record.source_device_id);

    const outcome = materializeAndApply(store, record, now);
    if (!outcome.ok) {
      driver.exec("ROLLBACK");
      return outcome;
    }
    if (!outcome.value.durable) {
      // 何も書いていないので cursor も進めない。last_seen も戻す必要は無いが、
      // 書き込みごと捨てて再送に任せる方が状態が 1 つで済む。
      driver.exec("ROLLBACK");
      return outcome;
    }

    advanceCursor(store, record.source_device_id, now);
    driver.exec("COMMIT");
    return outcome;
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `remote event transaction が失敗した: ${String(cause)}`,
      record.event_id,
    );
  }
}

function materializeAndApply(
  store: SqliteWorkflowStore,
  record: JournalRecord,
  now: string,
): Result<RemoteApplyResult> {
  const driver = store.driver;
  const current = store.lookup(record.aggregate_id);
  const creates = record.diff.created.some(
    (entry) => entry.component_id === record.aggregate_id,
  );

  if (current === undefined && !creates) {
    // FK の都合で durable に保留できない。再送に任せる。
    return ok(result(record, "deferred", false, {
      reason:
        `aggregate ${record.aggregate_id} が local に無く、この event は component を作らない`,
    }));
  }

  let disposition: InboxDisposition;
  let outcome: RemoteApplyOutcome;
  let appliedRevision: Revision | undefined;

  if (current !== undefined && creates) {
    // 同じ component ID を 2 device が別々に作った。identity の衝突なので自動では選べない。
    disposition = "conflict";
    outcome = "conflict";
  } else if (current === undefined) {
    insertCreatedComponents(store, record.diff, now);
    disposition = "applied";
    outcome = "applied";
    appliedRevision = record.aggregate_revision;
  } else if (record.base_revision > current.state_revision) {
    // 途中の event が未着。materialize して保留し、cursor を越えさせない。
    disposition = "received";
    outcome = "deferred";
  } else if (record.base_revision < current.state_revision) {
    // 同じ base から双方が進んだ。automatic merge は初期 scope 外なので conflict で残す。
    disposition = "conflict";
    outcome = "conflict";
  } else {
    disposition = "applied";
    outcome = "applied";
    appliedRevision = record.aggregate_revision;
  }

  // DOMAIN_EVENTS を先に書く。EVENT_INBOX がここへの FK を持つ。
  driver
    .prepare(
      "INSERT INTO domain_events (event_id, causation_operation_id, aggregate_id, event_type," +
        " base_revision, aggregate_revision, source_device_id, source_sequence, payload_json," +
        " committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      record.event_id,
      record.causation_operation_id ?? null,
      record.aggregate_id,
      record.event_type,
      record.base_revision,
      record.aggregate_revision,
      record.source_device_id,
      record.source_sequence,
      JSON.stringify(record.diff),
      record.committed_at,
    );

  if (disposition === "applied") {
    applyDiff(store, record, now);
  }

  driver
    .prepare(
      "INSERT INTO event_inbox (event_id, source_device_id, source_sequence, disposition," +
        " journal_locator, received_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      record.event_id,
      record.source_device_id,
      record.source_sequence,
      disposition,
      // conflict の元 Journal 位置を残す。payload は DOMAIN_EVENTS 側に残っている。
      `${record.repository_id}/${record.source_device_id}/${record.source_sequence}`,
      now,
      disposition === "received" ? null : now,
    );

  return ok(result(record, outcome, true, {
    ...(appliedRevision === undefined ? {} : { state_revision: appliedRevision }),
    ...(outcome === "conflict"
      ? { reason: `base_revision ${record.base_revision} が local state と一致しない` }
      : {}),
  }));
}

function insertCreatedComponents(
  store: SqliteWorkflowStore,
  diff: CommittedDiff,
  now: string,
): void {
  for (const created of diff.created) {
    if (store.lookup(created.component_id) !== undefined) continue;
    // **title_projection は入れない。** document projection は replicate されない
    // (`interfaces.md` DocumentProjectionPort)。remote 生成 component の title は
    // その device の VaultFileObserver が観測するまで NULL のままになる。
    store.driver
      .prepare(
        "INSERT INTO components (component_id, kind, status, state_revision," +
          " document_projection_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        created.component_id,
        created.kind,
        created.status ?? null,
        created.state_revision,
        now,
        now,
      );
  }
}

function applyDiff(store: SqliteWorkflowStore, record: JournalRecord, now: string): void {
  const driver = store.driver;
  const diff = record.diff;

  // aggregate 以外の created (task.create_planned が作る Task) もここで入る。
  insertCreatedComponents(store, diff, now);

  if (diff.next_state !== undefined) {
    driver
      .prepare(
        "UPDATE components SET status = ?, state_revision = ?, updated_at = ?" +
          " WHERE component_id = ?",
      )
      .run(
        diff.next_state.status ?? null,
        diff.next_state.state_revision,
        now,
        diff.next_state.component_id,
      );
  }

  for (const relation of diff.removed_relations ?? []) {
    driver
      .prepare(
        "DELETE FROM component_relations WHERE from_component_id = ?" +
          " AND to_repository_id = ? AND to_component_id = ? AND relation_type = ?",
      )
      .run(
        record.aggregate_id,
        relation.to_repository_id,
        relation.to_component_id,
        relation.relation_type,
      );
  }

  for (const relation of diff.added_relations) {
    const present = driver
      .prepare(
        "SELECT 1 AS present FROM component_relations WHERE from_component_id = ?" +
          " AND to_repository_id = ? AND to_component_id = ? AND relation_type = ?",
      )
      .get(
        record.aggregate_id,
        relation.to_repository_id,
        relation.to_component_id,
        relation.relation_type,
      );
    if (present !== undefined) continue;
    driver
      .prepare(
        "INSERT INTO component_relations (from_component_id, to_repository_id, to_component_id," +
          " relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        record.aggregate_id,
        relation.to_repository_id,
        relation.to_component_id,
        relation.relation_type,
        now,
      );
  }

  // 解決記録の伝播。**applied な event でだけ行う。** conflict のまま残った event が、
  // 相手側の marker を消すことはない。
  for (const resolved of diff.resolved_event_ids ?? []) {
    driver
      .prepare(
        "UPDATE event_inbox SET resolved_by_operation_id = ?, processed_at = ?" +
          " WHERE event_id = ? AND resolved_by_operation_id IS NULL",
      )
      .run(record.causation_operation_id ?? record.event_id, now, resolved);
  }

  if (diff.activity !== undefined) {
    // remote 適用なので causing_operation_id は NULL。local の OPERATIONS を指せない。
    driver
      .prepare(
        "INSERT INTO activities (activity_id, component_id, activity_type, actor_ref," +
          " component_revision, causing_event_id, detail_json, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `act-${record.event_id}`,
        record.aggregate_id,
        diff.activity.activity_type,
        diff.activity.actor_ref,
        record.aggregate_revision,
        record.event_id,
        diff.activity.detail === undefined ? null : JSON.stringify(diff.activity.detail),
        now,
      );
  }
}

function ensureRemoteDevice(
  store: SqliteWorkflowStore,
  deviceId: DeviceId,
  now: string,
): void {
  const driver = store.driver;
  const known = driver.prepare("SELECT device_id FROM devices WHERE device_id = ?").get(deviceId);
  if (known === undefined) {
    driver
      .prepare("INSERT INTO devices (device_id, local_flag, next_event_sequence) VALUES (?, 0, 1)")
      .run(deviceId);
  }
  const cursor = driver
    .prepare("SELECT source_device_id FROM replication_cursors WHERE source_device_id = ?")
    .get(deviceId);
  if (cursor === undefined) {
    driver
      .prepare(
        "INSERT INTO replication_cursors (source_device_id, last_seen_sequence," +
          " last_contiguous_processed_sequence, updated_at) VALUES (?, 0, 0, ?)",
      )
      .run(deviceId, now);
  }
}

/** terminal な inbox row が連続している範囲だけ cursor を進める。 */
function advanceCursor(store: SqliteWorkflowStore, deviceId: DeviceId, now: string): void {
  const driver = store.driver;
  const row = driver
    .prepare(
      "SELECT last_contiguous_processed_sequence FROM replication_cursors WHERE source_device_id = ?",
    )
    .get(deviceId);
  const current = row === undefined
    ? 0
    : rowInteger(row, "last_contiguous_processed_sequence") ?? 0;
  const terminal = new Set(
    driver
      .prepare(
        "SELECT source_sequence FROM event_inbox WHERE source_device_id = ?" +
          " AND disposition IN ('applied', 'rejected', 'conflict')",
      )
      .all(deviceId)
      .map((entry) => rowInteger(entry, "source_sequence"))
      .filter((value): value is number => value !== undefined),
  );
  const next = advanceContiguous(current, terminal);
  if (next === current) return;
  driver
    .prepare(
      "UPDATE replication_cursors SET last_contiguous_processed_sequence = ?, updated_at = ?" +
        " WHERE source_device_id = ?",
    )
    .run(next, now, deviceId);
}

/**
 * materialize 済みで未適用 (`received`) の event を、進めるものが無くなるまで再評価する。
 *
 * 穴が埋まった時に保留分が続けて applied になるのは、**この関数が呼ばれた時だけ**。
 * `applyRemoteEvent()` は 1 件だけを見るので、batch の末尾でこれを呼ぶ。
 */
export function drainDeferredEvents(
  store: SqliteWorkflowStore,
): Result<readonly RemoteApplyResult[]> {
  const settled: RemoteApplyResult[] = [];
  for (;;) {
    const pending = store.driver
      .prepare(
        "SELECT i.event_id AS event_id, e.causation_operation_id AS causation_operation_id," +
          " e.aggregate_id AS aggregate_id, e.event_type AS event_type," +
          " e.base_revision AS base_revision, e.aggregate_revision AS aggregate_revision," +
          " e.source_device_id AS source_device_id, e.source_sequence AS source_sequence," +
          " e.payload_json AS payload_json, e.committed_at AS committed_at" +
          " FROM event_inbox i JOIN domain_events e ON e.event_id = i.event_id" +
          " WHERE i.disposition = 'received'" +
          " ORDER BY e.source_device_id, e.source_sequence",
      )
      .all();
    if (pending.length === 0) return ok(settled);

    let progressed = false;
    for (const row of pending) {
      const record = toJournalRecord(store, row);
      if (!record.ok) return record;
      const outcome = reapplyDeferred(store, record.value);
      if (!outcome.ok) return outcome;
      if (outcome.value.outcome === "deferred") continue;
      settled.push(outcome.value);
      progressed = true;
    }
    if (!progressed) return ok(settled);
  }
}

/** 保留 row を再評価する。`DOMAIN_EVENTS` は既にあるので disposition と state だけを動かす。 */
function reapplyDeferred(
  store: SqliteWorkflowStore,
  record: JournalRecord,
): Result<RemoteApplyResult> {
  const driver = store.driver;
  const now = store.clock();
  driver.exec("BEGIN IMMEDIATE");
  try {
    const current = store.lookup(record.aggregate_id);
    if (current === undefined) {
      driver.exec("ROLLBACK");
      return ok(result(record, "deferred", true, { reason: "aggregate がまだ無い" }));
    }
    if (record.base_revision > current.state_revision) {
      driver.exec("ROLLBACK");
      return ok(result(record, "deferred", true, { reason: "途中の event が未着" }));
    }
    const conflicting = record.base_revision < current.state_revision;
    if (!conflicting) applyDiff(store, record, now);

    const disposition: InboxDisposition = conflicting ? "conflict" : "applied";
    driver
      .prepare("UPDATE event_inbox SET disposition = ?, processed_at = ? WHERE event_id = ?")
      .run(disposition, now, record.event_id);
    advanceCursor(store, record.source_device_id, now);
    driver.exec("COMMIT");
    return ok(result(record, conflicting ? "conflict" : "applied", true, {
      ...(conflicting ? {} : { state_revision: record.aggregate_revision }),
    }));
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `保留 event の再評価に失敗した: ${String(cause)}`,
      record.event_id,
    );
  }
}

export type JournalApplyReport = {
  readonly results: readonly RemoteApplyResult[];
  readonly applied: number;
  readonly duplicate: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly conflict: number;
};

/** batch 適用。1 件ずつ transaction を切り、最後に保留分を drain する。 */
export function applyJournalBatch(
  store: SqliteWorkflowStore,
  records: readonly JournalRecord[],
): Result<JournalApplyReport> {
  const results: RemoteApplyResult[] = [];
  for (const record of records) {
    const applied = applyRemoteEvent(store, record);
    if (!applied.ok) return applied;
    results.push(applied.value);
  }
  const drained = drainDeferredEvents(store);
  if (!drained.ok) return drained;

  // drain で settle した event は、batch 内の deferred を置き換える形で数える。
  const settledIds = new Set(drained.value.map((entry) => entry.event_id));
  const merged = results
    .filter((entry) => !settledIds.has(entry.event_id))
    .concat(drained.value);
  return ok({
    results: merged,
    applied: merged.filter((entry) => entry.outcome === "applied").length,
    duplicate: merged.filter((entry) => entry.outcome === "duplicate").length,
    deferred: merged.filter((entry) => entry.outcome === "deferred").length,
    rejected: merged.filter((entry) => entry.outcome === "rejected").length,
    conflict: merged.filter((entry) => entry.outcome === "conflict").length,
  });
}

// --- conflict と cursor の読み出し ------------------------------------------

/** 未解決の conflict。`ChangeNotification.conflict_ids` はここから作る。 */
export function listOpenConflicts(store: SqliteWorkflowStore): readonly EventId[] {
  return store.driver
    .prepare(
      "SELECT event_id FROM event_inbox WHERE disposition = 'conflict'" +
        " AND resolved_by_operation_id IS NULL ORDER BY source_device_id, source_sequence",
    )
    .all()
    .map((row) => parseEventId(rowString(row, "event_id")))
    .filter((parsed): parsed is { ok: true; value: EventId } => parsed.ok)
    .map((parsed) => parsed.value);
}

export type ReplicationCursorRow = {
  readonly source_device_id: DeviceId;
  readonly last_seen_sequence: number;
  readonly last_contiguous_processed_sequence: number;
};

export function listReplicationCursors(
  store: SqliteWorkflowStore,
): readonly ReplicationCursorRow[] {
  return store.driver
    .prepare(
      "SELECT source_device_id, last_seen_sequence, last_contiguous_processed_sequence" +
        " FROM replication_cursors ORDER BY source_device_id",
    )
    .all()
    .flatMap((row) => {
      const deviceId = parseDeviceId(rowString(row, "source_device_id"));
      if (!deviceId.ok) return [];
      return [{
        source_device_id: deviceId.value,
        last_seen_sequence: rowInteger(row, "last_seen_sequence") ?? 0,
        last_contiguous_processed_sequence: rowInteger(row, "last_contiguous_processed_sequence") ??
          0,
      }];
    });
}

/**
 * repo-local change feed cursor の token (Slice D)。
 *
 * **裁定 (Slice D): `repo_cursor` は永続 sequence ではなく失効可能 token とする。**
 *
 * - 永続 sequence には repo-local な全順序が要る。schema にあるのは device ごとの
 *   `source_sequence` と contiguous cursor だけで、local command と accepted remote event は
 *   別々の sequence 空間にいる。ER 図も「repo-local UI change cursor は WorkflowPort の関心事で
 *   あって `REPLICATION_CURSORS` ではない」と明記しており、列を足す前提を置いていない。
 * - 失効は既に contract の一部である (`SubscribeChangesResult` の `cursor_expired`)。
 *   永続 sequence を名乗ると「失効しない」という約束が増え、`cursor_expired` と食い違う。
 * - token の内部形式は contract にしない (`persistence.md`)。**device 別位置の vector** を
 *   opaque 文字列にしただけで、client は source device sequence として解釈しない。
 * - 位置が読めない token (device 集合が変わった、DB を作り直した) は `cursor_expired` にし、
 *   その repo だけ page rescan させる。
 */
export function currentRepoCursorToken(store: SqliteWorkflowStore): RepoCursor {
  const local = store.driver
    .prepare("SELECT next_event_sequence FROM devices WHERE local_flag = 1")
    .get();
  const localSequence = local === undefined ? 1 : rowInteger(local, "next_event_sequence") ?? 1;
  const parts = [`${store.context.device_id}=${localSequence - 1}`];
  for (const cursor of listReplicationCursors(store)) {
    parts.push(`${cursor.source_device_id}=${cursor.last_contiguous_processed_sequence}`);
  }
  return `v1.${parts.join(",")}` as RepoCursor;
}

/**
 * token がこの DB の現在の device 集合で読めるか。
 * 読めない token は `cursor_expired` として扱い、勝手に 0 から再生しない。
 */
export function isRepoCursorReadable(store: SqliteWorkflowStore, cursor: RepoCursor): boolean {
  if (!cursor.startsWith("v1.")) return false;
  const known = new Set<string>([store.context.device_id as string]);
  for (const row of listReplicationCursors(store)) known.add(row.source_device_id as string);
  const parts = cursor.slice(3).split(",").filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return false;
    const position = Number(part.slice(index + 1));
    return known.has(part.slice(0, index)) && Number.isInteger(position) && position >= 0;
  });
}

// --- row -> JournalRecord ---------------------------------------------------

function toJournalRecord(store: SqliteWorkflowStore, row: SqlRow): Result<JournalRecord> {
  const eventId = parseEventId(rowString(row, "event_id"), "event_id");
  if (!eventId.ok) return eventId;
  const aggregateId = parseComponentId(rowString(row, "aggregate_id"), "aggregate_id");
  if (!aggregateId.ok) return aggregateId;
  const eventType = parseOperationName(rowString(row, "event_type"), "event_type");
  if (!eventType.ok) return eventType;
  const sourceDeviceId = parseDeviceId(rowString(row, "source_device_id"), "source_device_id");
  if (!sourceDeviceId.ok) return sourceDeviceId;
  const sequence = rowInteger(row, "source_sequence");
  if (sequence === undefined) {
    return err("invalid_sequence", "source_sequence が読めない", "source_sequence");
  }
  const baseRevision = rowInteger(row, "base_revision") ?? 0;
  const aggregateRevision = rowInteger(row, "aggregate_revision") ?? 0;
  const payloadJson = rowString(row, "payload_json") ?? "{}";
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch (cause) {
    return err("invalid_field_type", `payload_json が読めない: ${String(cause)}`, "payload_json");
  }
  const diff = parseCommittedDiff(parsedPayload, "diff", {
    kind_of: (componentId: ComponentId) => store.lookup(componentId)?.kind,
  });
  if (!diff.ok) return diff;
  const causation = rowString(row, "causation_operation_id");

  return ok({
    event_id: eventId.value,
    repository_id: store.context.repository_id,
    source_device_id: sourceDeviceId.value,
    source_sequence: sequence,
    aggregate_id: aggregateId.value,
    event_type: eventType.value,
    base_revision: baseRevision,
    aggregate_revision: aggregateRevision,
    ...(causation === undefined ? {} : { causation_operation_id: causation as never }),
    committed_at: rowString(row, "committed_at") ?? "",
    diff: diff.value,
  });
}

function result(
  record: JournalRecord,
  outcome: RemoteApplyOutcome,
  durable: boolean,
  detail: { reason?: string; state_revision?: Revision },
): RemoteApplyResult {
  return {
    event_id: record.event_id,
    source_device_id: record.source_device_id,
    source_sequence: record.source_sequence,
    outcome,
    durable,
    component_id: record.aggregate_id,
    ...(detail.state_revision === undefined ? {} : { state_revision: detail.state_revision }),
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
  };
}

export { inboxDispositionOf };
