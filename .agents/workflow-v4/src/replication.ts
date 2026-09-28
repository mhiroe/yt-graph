// committed DomainEvent の Journal 形と、contiguous cursor の純粋な進め方 (Slice D)。
//
// この file は依存ゼロで、DB も transport も触らない。`sql/replication.ts` が persistence を持ち、
// FileExchange / CLI は bytes を運ぶだけで payload を解釈しない。
//
// **Journal に載るのは committed diff だけ。** snapshot、heartbeat、transcript、SQLite file を
// 送らない (`docs/candidate/workflow-v4/persistence.md` の「Journal publish」)。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentId,
  type DeviceId,
  type EventId,
  joinPath,
  type OperationId,
  parseComponentId,
  parseDeviceId,
  parseEventId,
  parseOperationId,
  parseRepositoryId,
  type RepositoryId,
} from "./ids.ts";
import {
  type ComponentKind,
  type ComponentStatus,
  parseComponentKind,
  parseRevision,
  parseStatusForKind,
  type Revision,
} from "./components.ts";
import { type OperationName, parseOperationName } from "./commands.ts";
import { parseRelationType, type RelationType } from "./relations.ts";

/**
 * `EVENT_OUTBOX.publication_state`。
 * initial version は peer 全員の ack を待たないので、`published` は「Journal へ書き終えた」を表す。
 */
export const PUBLICATION_STATES = ["pending", "publishing", "published", "failed"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

/**
 * `EVENT_INBOX.disposition`。
 *
 * `received` は「materialize したがまだ適用していない」であり、**非 terminal**。
 * cursor はこの状態の row を越えて進まない。`applied` / `rejected` / `conflict` が terminal で、
 * conflict も terminal に含める。conflict で配送を止め続けないことは persistence.md が決めている。
 */
export const INBOX_DISPOSITIONS = ["received", "applied", "rejected", "conflict"] as const;
export type InboxDisposition = (typeof INBOX_DISPOSITIONS)[number];

/** cursor を進められる inbox disposition。`received` だけが進めない。 */
export const TERMINAL_INBOX_DISPOSITIONS: readonly InboxDisposition[] = [
  "applied",
  "rejected",
  "conflict",
];

export function isTerminalInboxDisposition(disposition: InboxDisposition): boolean {
  return TERMINAL_INBOX_DISPOSITIONS.includes(disposition);
}

/** event が作った component。remote 側で `COMPONENTS` を作るのに必要な最小限。 */
export type CreatedComponentDiff = {
  readonly component_id: ComponentId;
  readonly kind: ComponentKind;
  readonly status?: ComponentStatus;
  readonly state_revision: Revision;
};

/** event が進めた target state。 */
export type NextStateDiff = {
  readonly component_id: ComponentId;
  readonly status?: ComponentStatus;
  readonly state_revision: Revision;
};

/** event が足した outgoing relation。source は必ず event の aggregate。 */
export type AddedRelationDiff = {
  readonly to_repository_id: RepositoryId;
  readonly to_component_id: ComponentId;
  readonly relation_type: RelationType;
};

/** event が足した activity。remote 適用時に `ACTIVITIES` を再現するために運ぶ。 */
export type ActivityDiff = {
  readonly activity_type: string;
  readonly actor_ref: string;
  readonly detail?: Record<string, unknown>;
};

/**
 * committed diff。**document projection を含めない。**
 *
 * title / locator / observed_hash は VaultFileObserver 由来の local projection であり、
 * `docs/candidate/workflow-v4/interfaces.md` の DocumentProjectionPort が
 * 「workflow event として配信しない」と決めている。結果として、remote 側で作られた component の
 * `title_projection` は NULL のままになる。これは欠落ではなく所有境界そのもの。
 */
export type CommittedDiff = {
  readonly created: readonly CreatedComponentDiff[];
  readonly next_state?: NextStateDiff;
  readonly added_relations: readonly AddedRelationDiff[];
  /**
   * この event が外した relation (裁定 root PM 2026-09-15、`relation.detach` だけが持つ)。
   *
   * **空のときは field ごと出さない。**`DIFF_FIELDS` は whitelist なので、常に出すと
   * `0.5.0` を pin した受信側が**すべての record を** `unexpected_field` で落とす。
   * detach event だけが追随を要求する形にする。
   */
  readonly removed_relations?: readonly AddedRelationDiff[];
  readonly activity?: ActivityDiff;
  /**
   * この event が解決した conflict の event ID (`replication.resolve_conflict` だけが持つ)。
   *
   * event ID は device をまたいで一意なので、受信側は自分の `EVENT_INBOX` にある同じ row を
   * 解決済みにできる。**これは automatic merge ではない。** state をどう merge するかは
   * 送信側の人間が決めており、ここで運ぶのは「その決定が下された」という記録だけ。
   * 運ばないと、解決した側だけ conflict が消え、相手側に消せない marker が残る。
   */
  readonly resolved_event_ids?: readonly EventId[];
};

/**
 * Journal 上の committed DomainEvent 1 件。
 *
 * `repository_id` は envelope 側に持つ。channel は repository ID で namespace するが、
 * 受信側が channel の名前を信じずに record 自身と照合できる形にしておく。
 */
export type JournalRecord = {
  readonly event_id: EventId;
  readonly repository_id: RepositoryId;
  readonly source_device_id: DeviceId;
  readonly source_sequence: number;
  readonly aggregate_id: ComponentId;
  readonly event_type: OperationName;
  readonly base_revision: Revision;
  readonly aggregate_revision: Revision;
  readonly causation_operation_id?: OperationId;
  readonly committed_at: string;
  readonly diff: CommittedDiff;
};

const RECORD_FIELDS = [
  "event_id",
  "repository_id",
  "source_device_id",
  "source_sequence",
  "aggregate_id",
  "event_type",
  "base_revision",
  "aggregate_revision",
  "causation_operation_id",
  "committed_at",
  "diff",
] as const;

const DIFF_FIELDS = [
  "created",
  "next_state",
  "added_relations",
  "removed_relations",
  "activity",
  "resolved_event_ids",
] as const;

/** Journal が載せてはいけない field。載せた record は content ごと拒否する。 */
const FORBIDDEN_RECORD_FIELDS = [
  "snapshot",
  "database",
  "transcript",
  "document_body",
  "raw_markdown",
];

function parseSequence(value: unknown, path: string): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return err("invalid_sequence", `${path} は 1 以上の整数である必要がある`, path);
  }
  return ok(value);
}

function parseTimestamp(value: unknown, path: string): Result<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return err("invalid_field_type", `${path} は 1..64 文字の string である必要がある`, path);
  }
  return ok(value);
}

function parseObject(value: unknown, path: string): Result<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", `${path} は object である必要がある`, path);
  }
  return ok(value as Record<string, unknown>);
}

function parseCreated(value: unknown, path: string): Result<CreatedComponentDiff> {
  const raw = parseObject(value, path);
  if (!raw.ok) return raw;
  const componentId = parseComponentId(raw.value["component_id"], joinPath(path, "component_id"));
  if (!componentId.ok) return componentId;
  const kind = parseComponentKind(raw.value["kind"], joinPath(path, "kind"));
  if (!kind.ok) return kind;
  const status = parseStatusForKind(
    kind.value,
    raw.value["status"] ?? undefined,
    joinPath(path, "status"),
  );
  if (!status.ok) return status;
  const revision = parseRevision(raw.value["state_revision"], joinPath(path, "state_revision"));
  if (!revision.ok) return revision;
  return ok({
    component_id: componentId.value,
    kind: kind.value,
    ...(status.value === undefined ? {} : { status: status.value }),
    state_revision: revision.value,
  });
}

function parseNextState(
  value: unknown,
  kindOf: (componentId: ComponentId) => ComponentKind | undefined,
  path: string,
): Result<NextStateDiff> {
  const raw = parseObject(value, path);
  if (!raw.ok) return raw;
  const componentId = parseComponentId(raw.value["component_id"], joinPath(path, "component_id"));
  if (!componentId.ok) return componentId;
  const revision = parseRevision(raw.value["state_revision"], joinPath(path, "state_revision"));
  if (!revision.ok) return revision;
  const statusRaw = raw.value["status"] ?? undefined;
  // kind が分かる時だけ status を kind に照らす。分からない時は union の member であることだけ見る。
  const kind = kindOf(componentId.value);
  const status = kind === undefined
    ? parseLooseStatus(statusRaw, joinPath(path, "status"))
    : parseStatusForKind(kind, statusRaw, joinPath(path, "status"));
  if (!status.ok) return status;
  return ok({
    component_id: componentId.value,
    ...(status.value === undefined ? {} : { status: status.value }),
    state_revision: revision.value,
  });
}

/** kind が分からない位置での status 検査。未知値を既定値へ落とさず失敗にするのは同じ。 */
function parseLooseStatus(value: unknown, path: string): Result<ComponentStatus | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  const wish = parseStatusForKind("wish", value, path);
  if (wish.ok) return wish;
  return parseStatusForKind("task", value, path);
}

function parseAddedRelation(value: unknown, path: string): Result<AddedRelationDiff> {
  const raw = parseObject(value, path);
  if (!raw.ok) return raw;
  const repositoryId = parseRepositoryId(
    raw.value["to_repository_id"],
    joinPath(path, "to_repository_id"),
  );
  if (!repositoryId.ok) return repositoryId;
  const componentId = parseComponentId(
    raw.value["to_component_id"],
    joinPath(path, "to_component_id"),
  );
  if (!componentId.ok) return componentId;
  const relationType = parseRelationType(
    raw.value["relation_type"],
    joinPath(path, "relation_type"),
  );
  if (!relationType.ok) return relationType;
  return ok({
    to_repository_id: repositoryId.value,
    to_component_id: componentId.value,
    relation_type: relationType.value,
  });
}

function parseActivity(value: unknown, path: string): Result<ActivityDiff> {
  const raw = parseObject(value, path);
  if (!raw.ok) return raw;
  const activityType = raw.value["activity_type"];
  if (typeof activityType !== "string" || activityType.length === 0) {
    return err("invalid_field_type", `${path}.activity_type が空でない string でない`, path);
  }
  const actorRef = raw.value["actor_ref"];
  if (typeof actorRef !== "string" || actorRef.length === 0) {
    return err("invalid_field_type", `${path}.actor_ref が空でない string でない`, path);
  }
  const detailRaw = raw.value["detail"];
  if (detailRaw === undefined || detailRaw === null) {
    return ok({ activity_type: activityType, actor_ref: actorRef });
  }
  const detail = parseObject(detailRaw, joinPath(path, "detail"));
  if (!detail.ok) return detail;
  return ok({ activity_type: activityType, actor_ref: actorRef, detail: detail.value });
}

export type ParseDiffOptions = {
  /** 既知 component の kind。next_state の status を kind に照らすのに使う。 */
  readonly kind_of?: (componentId: ComponentId) => ComponentKind | undefined;
};

export function parseCommittedDiff(
  value: unknown,
  path = "diff",
  options: ParseDiffOptions = {},
): Result<CommittedDiff> {
  const raw = parseObject(value, path);
  if (!raw.ok) return raw;
  for (const key of Object.keys(raw.value)) {
    if (!(DIFF_FIELDS as readonly string[]).includes(key)) {
      return err("unexpected_field", `${path} に未知の field がある: ${key}`, joinPath(path, key));
    }
  }

  const createdRaw = raw.value["created"] ?? [];
  if (!Array.isArray(createdRaw)) {
    return err("invalid_field_type", `${path}.created は array である必要がある`, path);
  }
  const created: CreatedComponentDiff[] = [];
  for (const [index, item] of createdRaw.entries()) {
    const parsed = parseCreated(item, joinPath(joinPath(path, "created"), String(index)));
    if (!parsed.ok) return parsed;
    created.push(parsed.value);
  }

  const kindOf = options.kind_of ??
    ((componentId: ComponentId) =>
      created.find((entry) => entry.component_id === componentId)?.kind);

  const relationsRaw = raw.value["added_relations"] ?? [];
  if (!Array.isArray(relationsRaw)) {
    return err("invalid_field_type", `${path}.added_relations は array である必要がある`, path);
  }
  const addedRelations: AddedRelationDiff[] = [];
  for (const [index, item] of relationsRaw.entries()) {
    const parsed = parseAddedRelation(
      item,
      joinPath(joinPath(path, "added_relations"), String(index)),
    );
    if (!parsed.ok) return parsed;
    addedRelations.push(parsed.value);
  }

  const removedRaw = raw.value["removed_relations"];
  let removedRelations: AddedRelationDiff[] | undefined;
  if (removedRaw !== undefined && removedRaw !== null) {
    if (!Array.isArray(removedRaw)) {
      return err("invalid_field_type", `${path}.removed_relations は array である必要がある`, path);
    }
    removedRelations = [];
    for (const [index, item] of removedRaw.entries()) {
      const parsed = parseAddedRelation(
        item,
        joinPath(joinPath(path, "removed_relations"), String(index)),
      );
      if (!parsed.ok) return parsed;
      removedRelations.push(parsed.value);
    }
  }

  const nextStateRaw = raw.value["next_state"];
  let nextState: NextStateDiff | undefined;
  if (nextStateRaw !== undefined && nextStateRaw !== null) {
    const parsed = parseNextState(nextStateRaw, kindOf, joinPath(path, "next_state"));
    if (!parsed.ok) return parsed;
    nextState = parsed.value;
  }

  const activityRaw = raw.value["activity"];
  let activity: ActivityDiff | undefined;
  if (activityRaw !== undefined && activityRaw !== null) {
    const parsed = parseActivity(activityRaw, joinPath(path, "activity"));
    if (!parsed.ok) return parsed;
    activity = parsed.value;
  }

  const resolvedRaw = raw.value["resolved_event_ids"];
  let resolvedEventIds: EventId[] | undefined;
  if (resolvedRaw !== undefined && resolvedRaw !== null) {
    if (!Array.isArray(resolvedRaw)) {
      return err(
        "invalid_field_type",
        `${path}.resolved_event_ids は array である必要がある`,
        path,
      );
    }
    resolvedEventIds = [];
    for (const [index, item] of resolvedRaw.entries()) {
      const parsed = parseEventId(
        item,
        joinPath(joinPath(path, "resolved_event_ids"), String(index)),
      );
      if (!parsed.ok) return parsed;
      resolvedEventIds.push(parsed.value);
    }
  }

  return ok({
    created,
    ...(nextState === undefined ? {} : { next_state: nextState }),
    added_relations: addedRelations,
    ...(removedRelations === undefined || removedRelations.length === 0
      ? {}
      : { removed_relations: removedRelations }),
    ...(activity === undefined ? {} : { activity }),
    ...(resolvedEventIds === undefined ? {} : { resolved_event_ids: resolvedEventIds }),
  });
}

export function parseJournalRecord(
  value: unknown,
  options: ParseDiffOptions = {},
): Result<JournalRecord> {
  const raw = parseObject(value, "record");
  if (!raw.ok) return raw;
  for (const key of Object.keys(raw.value)) {
    if ((RECORD_FIELDS as readonly string[]).includes(key)) continue;
    if (FORBIDDEN_RECORD_FIELDS.includes(key)) {
      return err(
        "change_notification_carries_body",
        `Journal は committed diff だけを運ぶ: ${key}`,
        key,
      );
    }
    return err("unexpected_field", `JournalRecord に未知の field がある: ${key}`, key);
  }

  const eventId = parseEventId(raw.value["event_id"], "event_id");
  if (!eventId.ok) return eventId;
  const repositoryId = parseRepositoryId(raw.value["repository_id"], "repository_id");
  if (!repositoryId.ok) return repositoryId;
  const sourceDeviceId = parseDeviceId(raw.value["source_device_id"], "source_device_id");
  if (!sourceDeviceId.ok) return sourceDeviceId;
  const sourceSequence = parseSequence(raw.value["source_sequence"], "source_sequence");
  if (!sourceSequence.ok) return sourceSequence;
  const aggregateId = parseComponentId(raw.value["aggregate_id"], "aggregate_id");
  if (!aggregateId.ok) return aggregateId;
  // 未知の event_type を既定値へ落とさない。将来の peer が増やした operation はそのまま拒否する。
  const eventType = parseOperationName(raw.value["event_type"], "event_type");
  if (!eventType.ok) return eventType;
  const baseRevision = parseRevision(raw.value["base_revision"], "base_revision");
  if (!baseRevision.ok) return baseRevision;
  const aggregateRevision = parseRevision(raw.value["aggregate_revision"], "aggregate_revision");
  if (!aggregateRevision.ok) return aggregateRevision;
  if (aggregateRevision.value < baseRevision.value) {
    return err(
      "invalid_revision",
      `aggregate_revision ${aggregateRevision.value} が base_revision ${baseRevision.value} より小さい`,
      "aggregate_revision",
    );
  }
  const committedAt = parseTimestamp(raw.value["committed_at"], "committed_at");
  if (!committedAt.ok) return committedAt;

  let causationOperationId: OperationId | undefined;
  const causationRaw = raw.value["causation_operation_id"];
  if (causationRaw !== undefined && causationRaw !== null) {
    const parsed = parseOperationId(causationRaw, "causation_operation_id");
    if (!parsed.ok) return parsed;
    causationOperationId = parsed.value;
  }

  const diff = parseCommittedDiff(raw.value["diff"] ?? {}, "diff", options);
  if (!diff.ok) return diff;

  return ok({
    event_id: eventId.value,
    repository_id: repositoryId.value,
    source_device_id: sourceDeviceId.value,
    source_sequence: sourceSequence.value,
    aggregate_id: aggregateId.value,
    event_type: eventType.value,
    base_revision: baseRevision.value,
    aggregate_revision: aggregateRevision.value,
    ...(causationOperationId === undefined ? {} : { causation_operation_id: causationOperationId }),
    committed_at: committedAt.value,
    diff: diff.value,
  });
}

/**
 * Journal の重複排除 key。`event_id` と `repository_id + device_id + sequence` の **両方**で
 * 排除する (persistence.md の「Journal publish」)。こちらは後者。
 */
export function journalSequenceKey(record: JournalRecord): string {
  return `${record.repository_id}:${record.source_device_id}:${record.source_sequence}`;
}

/** remote event 1 件の適用結果。`durable` は DB へ materialize したかを表す。 */
export type RemoteApplyOutcome = "applied" | "duplicate" | "deferred" | "rejected" | "conflict";

export type RemoteApplyResult = {
  readonly event_id: EventId;
  readonly source_device_id: DeviceId;
  readonly source_sequence: number;
  readonly outcome: RemoteApplyOutcome;
  /** DB へ materialize したか。false の deferred は再送が要る。 */
  readonly durable: boolean;
  readonly component_id?: ComponentId;
  readonly state_revision?: Revision;
  readonly reason?: string;
};

/** `RemoteApplyOutcome` を `EVENT_INBOX.disposition` へ写す。duplicate は row を変えない。 */
export function inboxDispositionOf(outcome: RemoteApplyOutcome): InboxDisposition | undefined {
  switch (outcome) {
    case "applied":
      return "applied";
    case "deferred":
      return "received";
    case "rejected":
      return "rejected";
    case "conflict":
      return "conflict";
    case "duplicate":
      return undefined;
  }
}

/**
 * contiguous cursor の進め方。**terminal な sequence が連続している範囲だけ進む。**
 *
 * `received` (= 未適用で保留) の row を越えない。越えると、後から埋まった穴を二度と処理しない。
 * `conflict` は terminal に含める。含めないと、1 件の conflict でその device からの配送が
 * 永久に止まる (persistence.md の「同じ event で配送を停止し続けない」)。
 */
export function advanceContiguous(
  lastContiguous: number,
  terminalSequences: ReadonlySet<number>,
): number {
  let next = lastContiguous;
  while (terminalSequences.has(next + 1)) next += 1;
  return next;
}
