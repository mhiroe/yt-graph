// Command envelope と minimum command union。
// generic property patch と generic object store を公開せず、domain intent を名前に持つ operation だけを受ける。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentId,
  type DeviceId,
  joinPath,
  type OperationId,
  parseComponentId,
  parseDeviceId,
  parseEventId,
  parseOperationId,
  parseRepositoryId,
  type RepositoryId,
} from "./ids.ts";
import { parseRevision, type Revision, TASK_STATUSES, WISH_STATUSES } from "./components.ts";
import { parseIterationScope } from "./iterations.ts";
import { parseRelationType } from "./relations.ts";
import { parseComponentKind } from "./components.ts";
import {
  isProtocolCompatible,
  parseProtocolVersion,
  type ProtocolVersion,
  WORKFLOW_PROTOCOL_VERSION,
} from "./protocol.ts";
import {
  evaluateTaskTransition,
  evaluateWishTransition,
  type TransitionOutcome,
} from "./transitions.ts";
import type { ComponentStatus, TaskStatus, WishStatus } from "./components.ts";

/**
 * minimum command union。
 * `complete_satisfied` は satisfaction 仕様が決まるまで入れない。
 */
export const OPERATION_NAMES = [
  "component.register",
  "wish.plan_begin",
  "wish.request_ready",
  "wish.set_pending",
  "wish.start_doing",
  // doing -> done の口 (裁定 root PM 2026-09-20)。`WISH_TRANSITIONS` は doing から done を
  // 許しているのに、その行き先へ到達する operation が union に無かった。**推測ではなく欠落。**
  // `canAutoCompleteWish` が自動導出を禁じている以上、手動の口が無いと wish は終われない。
  "wish.complete",
  "wish.drop",
  "task.create_planned",
  "task.attach_planned",
  "relation.begin_external",
  "relation.attach_external",
  "relation.detach",
  "task.request_ready",
  "task.start_doing",
  "task.complete",
  // 各 active status から dropped へ入れる口 (user 裁定 2026-09-22)。`wish.drop` と同じく
  // `reason` を optional で持つ。
  "task.drop",
  "activity.append",
  "replication.resolve_conflict",
  // 同一 repo 内の relation を 1 本足す (iteration: successor -> predecessor wish)。
  // external への attach は既存の `relation.attach_external` が持つ。
  "relation.attach",
  // iteration (schema 7)。component aggregate に乗らないので target_id を持たない
  // (`component.register` と同じ envelope 変形)。domain_events は出さない。
  "iteration.open",
  "iteration.activate",
  "iteration.deactivate",
  "iteration.set_default",
  "iteration.switch",
  "iteration.carry",
  "iteration.dispose",
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export function parseOperationName(value: unknown, path?: string): Result<OperationName> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "operation は string である必要がある", path);
  }
  const operation = OPERATION_NAMES.find((candidate) => candidate === value);
  if (operation === undefined) {
    return err("unknown_operation", `未知の operation: ${JSON.stringify(value)}`, path);
  }
  return ok(operation);
}

type FieldKind =
  | "string"
  | "component_id"
  | "component_id_array"
  | "repository_id"
  | "component_kind"
  | "relation_type"
  | "event_id"
  | "event_id_array"
  | "operation_id"
  | "object"
  | "iteration_scope"
  | "string_array";

type FieldSpec = {
  readonly name: string;
  readonly required: boolean;
  readonly kind: FieldKind;
};

/**
 * field の要否。`optional` は「設定されていれば検査する」を表す。
 * 裁定 (Slice B): `activity.append` だけがこれを使う。理由は OPERATION_SPECS の該当 entry に置く。
 */
type Presence = "required" | "optional" | "forbidden";

export type OperationSpec = {
  readonly operation: OperationName;
  /** component 登録時だけ target_id / expected_revision の未設定を許す。 */
  readonly target_id: Presence;
  readonly expected_revision: Presence;
  readonly fields: readonly FieldSpec[];
};

const f = (name: string, required: boolean, kind: FieldKind): FieldSpec => ({
  name,
  required,
  kind,
});

export const OPERATION_SPECS: Readonly<Record<OperationName, OperationSpec>> = {
  "component.register": {
    operation: "component.register",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [
      f("kind", true, "component_kind"),
      f("title", false, "string"),
      f("locator", false, "string"),
      // optional current の裁定 (schema 7): scope に default が無い時はここで
      // iteration を明示する。default が在れば不要 (default に入る)。
      f("iteration_id", false, "string"),
      f("correlation_id", false, "string"),
    ],
  },
  "wish.plan_begin": {
    operation: "wish.plan_begin",
    target_id: "required",
    expected_revision: "required",
    fields: [],
  },
  "wish.request_ready": {
    operation: "wish.request_ready",
    target_id: "required",
    expected_revision: "required",
    fields: [],
  },
  "wish.set_pending": {
    operation: "wish.set_pending",
    target_id: "required",
    expected_revision: "required",
    fields: [f("reason", false, "string")],
  },
  "wish.start_doing": {
    operation: "wish.start_doing",
    target_id: "required",
    expected_revision: "required",
    fields: [],
  },
  /**
   * Wish を done にする (裁定 root PM 2026-09-20)。`task.complete` と対称の手動完了。
   *
   * **payload は `reason` にする。**`task.complete` の `verification` を写さない。Task の完了は
   * 実行した検証を残す場面だが、Wish の完了は「満たされたと人が判断した」ことの記録であり、
   * satisfaction assessment は現時点で contract の外 (`canAutoCompleteWish`)。`verification` を
   * 置くと、まだ決まっていない satisfaction 判定の入口があるように読める。terminal へ入る
   * もう一方の `wish.drop` と同じ `reason` に揃える。
   */
  "wish.complete": {
    operation: "wish.complete",
    target_id: "required",
    expected_revision: "required",
    fields: [f("reason", false, "string")],
  },
  "wish.drop": {
    operation: "wish.drop",
    target_id: "required",
    expected_revision: "required",
    fields: [f("reason", false, "string")],
  },
  "task.create_planned": {
    operation: "task.create_planned",
    target_id: "required",
    expected_revision: "required",
    fields: [
      f("title", false, "string"),
      f("locator", false, "string"),
      // `component.register` と同じ optional current の裁定。default の無い scope
      // で新しい task がどの iteration の member になるかを明示する。
      f("iteration_id", false, "string"),
      f("correlation_id", false, "string"),
    ],
  },
  "task.attach_planned": {
    operation: "task.attach_planned",
    target_id: "required",
    expected_revision: "required",
    fields: [f("task_component_id", true, "component_id")],
  },
  /**
   * cross-repo intent の口を開く (裁定 Slice E)。
   *
   * **名前を `relation.*` に置く理由。** この flow が source repo に作るのは outgoing relation
   * 1 本だけで、終端 step が `relation.attach_external` である。加えて `attach_external` は
   * `correlation_id` を **required** で持つ唯一の command で、対になる開始 step がある前提が
   * 既に contract へ入っている。開き手を同じ aggregate に置く。
   *
   * **step operation ID を payload で受け取る。** caller が落ちても recovery worker が
   * 「同じ step operation ID で続きから再送する」(domain.md) ためには、ID が intent 側に
   * 残っている必要がある。caller の記憶に置くと、caller の消滅で ID も消える。
   */
  "relation.begin_external": {
    operation: "relation.begin_external",
    target_id: "required",
    // 裁定 (Slice E): intent は relation ではないので `state_revision` を消費しない。
    // 消費させると、同じ Wish に対する独立した 2 つの cross-repo intent が互いに conflict する。
    // Slice D が記録した「独立した 2 つの relation 追加が競合する」残余 risk を増やすだけになる。
    // 「この revision を見た上で開いた」を残したい呼び出しのために optional で検査する。
    expected_revision: "optional",
    fields: [
      f("target_repository_id", true, "repository_id"),
      f("relation_type", true, "relation_type"),
      f("correlation_id", true, "string"),
      f("target_create_operation_id", true, "operation_id"),
      f("source_attach_operation_id", true, "operation_id"),
      // **移動の時だけ入る 2 つ** (裁定 O4-2 2026-09-15)。source repo に残っている元の relation を
      // 畳む step を intent 自身に持たせる。片方だけを受け取らない (`decide.ts` で reject する)。
      // 相手が分からない step ID も、ID の無い相手も、送れる command にならない。
      f("source_detach_component_id", false, "component_id"),
      f("source_detach_operation_id", false, "operation_id"),
    ],
  },
  "relation.attach_external": {
    operation: "relation.attach_external",
    target_id: "required",
    expected_revision: "required",
    fields: [
      f("target_repository_id", true, "repository_id"),
      f("target_component_id", true, "component_id"),
      f("relation_type", true, "relation_type"),
      f("correlation_id", true, "string"),
    ],
  },
  /**
   * relation を 1 本外す (裁定 root PM 2026-09-15)。
   *
   * **「移動」の片側。**`my-wish-data.md` の hierarchy が「所属は親 node の `children` list を
   * 正本として表す」「child 側に `parent` を保存しない」と定めているので、**移動は旧親からの
   * 除去と新親への追加**になる。除去側の operation がこれ。
   *
   * **`relation.*` に置く。**外す対象は relation そのもので、attach 側と同じ aggregate
   * (source Wish) に属する。`target_id` は `attach_external` と同じく source Wish。
   *
   * **`target_repository_id` を local でも必須にする。**relation key は
   * 「必ず repository_id を伴う address」(`relations.ts`) なので、local だけ省略形を作らない。
   */
  "relation.detach": {
    operation: "relation.detach",
    target_id: "required",
    expected_revision: "required",
    fields: [
      f("target_repository_id", true, "repository_id"),
      f("target_component_id", true, "component_id"),
      f("relation_type", true, "relation_type"),
    ],
  },
  "task.request_ready": {
    operation: "task.request_ready",
    target_id: "required",
    expected_revision: "required",
    fields: [],
  },
  "task.start_doing": {
    operation: "task.start_doing",
    target_id: "required",
    expected_revision: "required",
    fields: [],
  },
  "task.complete": {
    operation: "task.complete",
    target_id: "required",
    expected_revision: "required",
    fields: [f("verification", false, "string")],
  },
  /**
   * Task を dropped にする (user 裁定 2026-09-22)。`wish.drop` と対称で、payload は同じ
   * `reason` に揃える — Task の drop も「やらないと人が判断した」記録で、verification を
   * 置く場面ではない。各 active status から 1 step で入る terminal。
   */
  "task.drop": {
    operation: "task.drop",
    target_id: "required",
    expected_revision: "required",
    fields: [f("reason", false, "string")],
  },
  "activity.append": {
    operation: "activity.append",
    target_id: "required",
    // 裁定 (Slice B、transaction 実測に基づく): activity.append は state_revision を消費しない。
    // 消費しない以上、必須にしても書き込みを保護しない。読み取り検査にしかならない一方で、
    // 無関係な state 変更が並走しただけで履歴の append が conflict で落ちる。
    // 「この revision を見た上での記録」を残したい呼び出しはあるので、設定されていれば検査する
    // `optional` にする。詳細は `docs/candidate/workflow-v4/persistence.md` の
    // 「activity.append と revision」。
    expected_revision: "optional",
    fields: [
      f("activity_type", true, "string"),
      f("detail", false, "object"),
      f("causing_operation_id", false, "string"),
      f("causing_event_id", false, "string"),
    ],
  },
  "replication.resolve_conflict": {
    operation: "replication.resolve_conflict",
    target_id: "required",
    expected_revision: "required",
    // 裁定 (Slice D): event ID は裸の string ではなく parse 済み型で受ける。
    // conflict を指す値がここと `ChangeNotification.conflict_ids` の 2 か所に出るので、
    // 受理範囲を片方だけ緩くしない。
    fields: [
      f("conflicting_event_ids", true, "event_id_array"),
      f("adopted_event_id", true, "event_id"),
    ],
  },
  /**
   * 同一 repo 内の outgoing relation を足す (iteration の successor -> predecessor)。
   *
   * **`relation.attach_external` と対。**外部 repo への attach は correlation_id を必須に
   * する `attach_external` だけが持ち、こちらは `to_repository_id` が local と一致する時
   * だけ受ける (一致しない request は decide が rejected にする)。duplicate attach は
   * 既存規則どおり `noop`。
   */
  "relation.attach": {
    operation: "relation.attach",
    target_id: "required",
    expected_revision: "required",
    fields: [
      f("target_repository_id", true, "repository_id"),
      f("target_component_id", true, "component_id"),
      f("relation_type", true, "relation_type"),
    ],
  },
  /**
   * iteration を開く (schema 7、docs/candidate/workflow-v4/iterations.md)。
   *
   * **component aggregate ではないので `target_id` / `expected_revision` を持たない**
   * (`component.register` と同じ変形)。`name` は caller が渡す自由 label で display に
   * 過ぎず、順序の正本は Core が採番する `seq`。`created_at` / `last_modified` は
   * Core clock が stamp するので payload には置かない。
   * `predecessor_iteration_id` は**並行する兄弟への lineage 記録だけ** —
   * schema 7 では predecessor は close も deactivate もされない (`closed_at` は廃止)。
   */
  "iteration.open": {
    operation: "iteration.open",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [
      f("scope", true, "iteration_scope"),
      f("name", true, "string"),
      f("component_path", false, "string"),
      f("predecessor_iteration_id", false, "string"),
    ],
  },
  /**
   * iteration を scope の active set に入れる (schema 7)。default にはならない —
   * `current` link 相当の役割は `iteration.set_default` / `iteration.switch` が持つ。
   * fs 側では `<p>/active/<label>` symlink が立つ。既に active なら noop。
   */
  "iteration.activate": {
    operation: "iteration.activate",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [f("iteration_id", true, "string")],
  },
  /**
   * active set から外す。対象が default だったら default も消える (current は
   * optional — 無い状態は合法)。`next_default` に残る active member の id を渡すと
   * 同じ transaction で default を引き継ぐ。dir / file は消さない。
   */
  "iteration.deactivate": {
    operation: "iteration.deactivate",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [
      f("iteration_id", true, "string"),
      f("next_default", false, "string"),
    ],
  },
  /**
   * scope の default を target へ付け替える (`current` link が指す先)。
   * target は既に active でなければならない。既に default なら noop。
   */
  "iteration.set_default": {
    operation: "iteration.set_default",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [f("iteration_id", true, "string")],
  },
  /**
   * activate + set_default の composite sugar。scope の default を target へ
   * 切り替え、まだ active でなければ active set にも入れる。`components` /
   * `documents` に member を同時に渡せる (carry の一部)。membership 追加 +
   * active/default の flip は同一 transaction で確定し、symlink の張り替えは
   * commit 後の fs side effect として行う (狂ったら `iteration.repair` で再構成する)。
   */
  "iteration.switch": {
    operation: "iteration.switch",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [
      f("scope", true, "iteration_scope"),
      f("component_path", false, "string"),
      f("iteration_id", true, "string"),
      f("components", false, "component_id_array"),
      f("documents", false, "string_array"),
    ],
  },
  /** member を足すだけ。active set / default は動かない。すでに全員 member なら noop。 */
  "iteration.carry": {
    operation: "iteration.carry",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [
      f("iteration_id", true, "string"),
      f("components", false, "component_id_array"),
      f("documents", false, "string_array"),
    ],
  },
  /** iteration を破棄する。dir / file は消さない (`disposed_at` を stamp するだけ)。 */
  "iteration.dispose": {
    operation: "iteration.dispose",
    target_id: "forbidden",
    expected_revision: "forbidden",
    fields: [f("iteration_id", true, "string")],
  },
};

export type CommandPayload = Readonly<Record<string, unknown>>;

export type Command = {
  readonly protocol_version: ProtocolVersion;
  readonly repository_id: RepositoryId;
  readonly operation_id: OperationId;
  readonly operation: OperationName;
  readonly target_id?: ComponentId;
  readonly expected_revision?: Revision;
  readonly actor_ref: string;
  readonly source_device_id: DeviceId;
  readonly payload: CommandPayload;
};

const ENVELOPE_FIELDS = [
  "protocol_version",
  "repository_id",
  "operation_id",
  "operation",
  "target_id",
  "expected_revision",
  "actor_ref",
  "source_device_id",
  "payload",
] as const;

export type ParseCommandOptions = {
  /** 接続先 repository。指定すると repository_id の不一致を拒否する。 */
  readonly repository_id?: RepositoryId;
  readonly port_protocol_version?: ProtocolVersion;
};

export function parseCommand(value: unknown, options: ParseCommandOptions = {}): Result<Command> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "Command は object である必要がある");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) {
      return err("unexpected_field", `Command envelope に未知の field がある: ${key}`, key);
    }
  }

  const protocolVersion = parseProtocolVersion(raw["protocol_version"], "protocol_version");
  if (!protocolVersion.ok) return protocolVersion;
  const portVersion = options.port_protocol_version ?? WORKFLOW_PROTOCOL_VERSION;
  if (!isProtocolCompatible(portVersion, protocolVersion.value)) {
    return err(
      "protocol_incompatible",
      `protocol_version ${protocolVersion.value.major}.${protocolVersion.value.minor} は port と互換でない`,
      "protocol_version",
    );
  }

  const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
  if (!repositoryId.ok) return repositoryId;
  if (options.repository_id !== undefined && options.repository_id !== repositoryId.value) {
    return err(
      "repository_id_mismatch",
      `command の repository_id ${repositoryId.value} が接続先 ${options.repository_id} と一致しない`,
      "repository_id",
    );
  }

  const operationId = parseOperationId(raw["operation_id"], "operation_id");
  if (!operationId.ok) return operationId;
  const operation = parseOperationName(raw["operation"], "operation");
  if (!operation.ok) return operation;
  const spec = OPERATION_SPECS[operation.value];

  const actorRef = raw["actor_ref"];
  if (typeof actorRef !== "string" || actorRef.length === 0 || actorRef.length > 128) {
    return err(
      "invalid_field_type",
      "actor_ref は 1..128 文字の string である必要がある",
      "actor_ref",
    );
  }
  const sourceDeviceId = parseDeviceId(raw["source_device_id"], "source_device_id");
  if (!sourceDeviceId.ok) return sourceDeviceId;

  const targetId = parsePresence(
    raw["target_id"],
    spec.target_id,
    "target_id",
    (input, path) => parseComponentId(input, path),
    "target_id_required",
    "target_id_forbidden",
  );
  if (!targetId.ok) return targetId;

  const expectedRevision = parsePresence(
    raw["expected_revision"],
    spec.expected_revision,
    "expected_revision",
    (input, path) => parseRevision(input, path),
    "expected_revision_required",
    "expected_revision_forbidden",
  );
  if (!expectedRevision.ok) return expectedRevision;

  const payload = parsePayload(raw["payload"], spec);
  if (!payload.ok) return payload;

  return ok({
    protocol_version: protocolVersion.value,
    repository_id: repositoryId.value,
    operation_id: operationId.value,
    operation: operation.value,
    ...(targetId.value === undefined ? {} : { target_id: targetId.value }),
    ...(expectedRevision.value === undefined ? {} : { expected_revision: expectedRevision.value }),
    actor_ref: actorRef,
    source_device_id: sourceDeviceId.value,
    payload: payload.value,
  });
}

function parsePresence<T>(
  value: unknown,
  presence: Presence,
  path: string,
  parse: (input: unknown, path: string) => Result<T>,
  requiredCode: "target_id_required" | "expected_revision_required",
  forbiddenCode: "target_id_forbidden" | "expected_revision_forbidden",
): Result<T | undefined> {
  const absent = value === undefined || value === null;
  if (presence === "forbidden") {
    if (!absent) {
      return err(forbiddenCode, `${path} はこの operation では設定できない`, path);
    }
    return ok(undefined);
  }
  if (absent) {
    if (presence === "optional") return ok(undefined);
    return err(requiredCode, `${path} はこの operation で必須である`, path);
  }
  return parse(value, path);
}

function parsePayload(value: unknown, spec: OperationSpec): Result<CommandPayload> {
  if (value === undefined || value === null) {
    if (spec.fields.some((field) => field.required)) {
      return err("missing_field", `${spec.operation} は payload を必要とする`, "payload");
    }
    return ok({});
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return err("invalid_field_type", "payload は object である必要がある", "payload");
  }
  const raw = value as Record<string, unknown>;
  const names = spec.fields.map((field) => field.name);
  for (const key of Object.keys(raw)) {
    if (!names.includes(key)) {
      return err(
        "unexpected_field",
        `${spec.operation} の payload に未知の field がある: ${key}`,
        joinPath("payload", key),
      );
    }
  }
  const result: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const path = joinPath("payload", field.name);
    const fieldValue = raw[field.name];
    if (fieldValue === undefined || fieldValue === null) {
      if (field.required) {
        return err("missing_field", `${spec.operation} の payload.${field.name} が無い`, path);
      }
      continue;
    }
    const parsed = parseField(field.kind, fieldValue, path);
    if (!parsed.ok) return parsed;
    result[field.name] = parsed.value;
  }
  return ok(result);
}

function parseField(kind: FieldKind, value: unknown, path: string): Result<unknown> {
  switch (kind) {
    case "string":
      return typeof value === "string" && value.length > 0
        ? ok(value)
        : err("invalid_field_type", `${path} は空でない string である必要がある`, path);
    case "component_id":
      return parseComponentId(value, path);
    case "component_id_array": {
      // **空 array を許す。**carry 無しの switch / documents だけの carry が書ける形にする。
      if (!Array.isArray(value)) {
        return err("invalid_field_type", `${path} は array である必要がある`, path);
      }
      const parsed: ComponentId[] = [];
      for (const [index, item] of value.entries()) {
        const componentId = parseComponentId(item, joinPath(path, String(index)));
        if (!componentId.ok) return componentId;
        parsed.push(componentId.value);
      }
      return ok(parsed);
    }
    case "string_array": {
      if (!Array.isArray(value)) {
        return err("invalid_field_type", `${path} は array である必要がある`, path);
      }
      const parsed: string[] = [];
      for (const [index, item] of value.entries()) {
        if (typeof item !== "string" || item.length === 0) {
          return err(
            "invalid_field_type",
            `${joinPath(path, String(index))} は空でない string である必要がある`,
            path,
          );
        }
        parsed.push(item);
      }
      return ok(parsed);
    }
    case "iteration_scope":
      return parseIterationScope(value, path);
    case "repository_id":
      return parseRepositoryId(value, path);
    case "component_kind":
      return parseComponentKind(value, path);
    case "relation_type":
      return parseRelationType(value, path);
    case "event_id":
      return parseEventId(value, path);
    case "operation_id":
      return parseOperationId(value, path);
    case "event_id_array": {
      if (!Array.isArray(value) || value.length === 0) {
        return err("invalid_field_type", `${path} は空でない array である必要がある`, path);
      }
      const parsed: string[] = [];
      for (const [index, item] of value.entries()) {
        const eventId = parseEventId(item, joinPath(path, String(index)));
        if (!eventId.ok) return eventId;
        parsed.push(eventId.value);
      }
      return ok(parsed);
    }
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? ok(value)
        : err("invalid_field_type", `${path} は object である必要がある`, path);
  }
}

type StatusTransitionSpec =
  | { readonly kind: "wish"; readonly to: WishStatus }
  | { readonly kind: "task"; readonly to: TaskStatus };

/** status を進める operation と、その遷移先。ここに無い operation は status を変えない。 */
export const OPERATION_TRANSITIONS: Readonly<
  Partial<Record<OperationName, StatusTransitionSpec>>
> = {
  "wish.plan_begin": { kind: "wish", to: "plan" },
  "wish.request_ready": { kind: "wish", to: "ready" },
  "wish.set_pending": { kind: "wish", to: "pending" },
  "wish.start_doing": { kind: "wish", to: "doing" },
  "wish.complete": { kind: "wish", to: "done" },
  "wish.drop": { kind: "wish", to: "dropped" },
  "task.request_ready": { kind: "task", to: "ready" },
  "task.start_doing": { kind: "task", to: "doing" },
  "task.complete": { kind: "task", to: "done" },
  "task.drop": { kind: "task", to: "dropped" },
};

/** operation と現在 status から transition を評価する。status を変えない operation は undefined を返す。 */
export function evaluateCommandTransition(
  operation: OperationName,
  currentStatus: ComponentStatus,
): Result<TransitionOutcome | undefined> {
  const spec = OPERATION_TRANSITIONS[operation];
  if (spec === undefined) return ok(undefined);
  if (spec.kind === "wish") {
    const from = WISH_STATUSES.find((candidate) => candidate === currentStatus);
    if (from === undefined) {
      return err(
        "status_not_allowed_for_kind",
        "wish 用 operation に wish 以外の status が渡された",
      );
    }
    return ok(evaluateWishTransition(from, spec.to));
  }
  const from = TASK_STATUSES.find((candidate) => candidate === currentStatus);
  if (from === undefined) {
    return err("status_not_allowed_for_kind", "task 用 operation に task 以外の status が渡された");
  }
  return ok(evaluateTaskTransition(from, spec.to));
}
