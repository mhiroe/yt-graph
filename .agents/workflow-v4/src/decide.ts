// command の純粋な適用判断。storage を持たず、現在 state と command から disposition を決める。
// 永続化 (SQLite transaction、operation 保存、event / outbox) は Slice B 以降が担う。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentAddress,
  componentAddress,
  type ComponentId,
  type EventId,
  formatComponentAddress,
  type OperationId,
  type RepositoryId,
} from "./ids.ts";
import { checkStepOperationIds } from "./cross_repo.ts";
import { parseTaskLocator } from "./document.ts";
import type { ComponentKind, ComponentState, ComponentStatus, Revision } from "./components.ts";
import { initialStatus, TASK_TERMINAL_STATUSES, WISH_TERMINAL_STATUSES } from "./transitions.ts";
import { type Command, evaluateCommandTransition, OPERATION_SPECS } from "./commands.ts";
import {
  type IterationInfo,
  type IterationLookup,
  type IterationScope,
  validateComponentPath,
  validateIterationLabel,
} from "./iterations.ts";
import {
  normalizeSprintLine,
  type SprintInfo,
  sprintLabel,
  type SprintLookup,
  type SprintMember,
  type SprintRosterEntry,
} from "./sprints.ts";
import type { CommandResponse } from "./responses.ts";
import { type RelationKey, relationLocality, type RelationType } from "./relations.ts";
import type { RepositoryContext } from "./repository.ts";

/** local repo の component を stable ID で引く。推測 merge をしないため、無ければ undefined を返す。 */
export type ComponentLookup = (componentId: ComponentId) => ComponentState | undefined;

/**
 * outgoing relation が既にあるかを引く。
 *
 * 裁定 (Slice B): duplicate relation の判定は persistence 側の後処理ではなく core が持つ。
 * `decideCommand()` 系は applied / noop / rejected / conflict / not_found の全 disposition を
 * 決める唯一の場所であり、あとから storage 側で disposition を差し替えると判断が 2 か所へ割れる。
 * その形では storage を持たない client の fake 実装が同じ noop 化を独自に持つことになり、実際に
 * そうなっていた。`lookup` と同じ「現在 state は storage から渡す」形へ揃えるのが最小。
 *
 * ただし置き方は **additive** にする。`DecideInput` へ必須 field を足すと consumer が即座に
 * 赤化するため、relation を渡せる入口を別に足し、既存 `decideCommand()` の signature と
 * 振る舞いは変えない。
 */
export type RelationLookup = (key: RelationKey) => boolean;

/**
 * committed DomainEvent を event ID で引く (Slice D)。
 *
 * `replication.resolve_conflict` は「どの event を採用したか」で結果が決まるので、採用対象の
 * committed diff を読めないと判断できない。`relationLookup` と同じく **additive** に足し、
 * 既存の入口の signature と振る舞いを変えない。
 */
export type EventLookup = (eventId: EventId) => StoredEventSummary | undefined;

/** resolve が必要とする範囲だけの event 要約。event 本文をそのまま domain へ持ち込まない。 */
export type StoredEventSummary = {
  readonly event_id: EventId;
  readonly aggregate_id: ComponentId;
  readonly base_revision: Revision;
  readonly aggregate_revision: Revision;
  /** 採用したときに component が取る status。status を動かさない event では undefined。 */
  readonly resulting_status?: ComponentStatus;
  /** 採用したときに足す outgoing relation。 */
  readonly added_relations: readonly RelationKey[];
  /** 採用したときに外す outgoing relation (裁定 root PM 2026-09-15)。 */
  readonly removed_relations?: readonly RelationKey[];
  /** `EVENT_INBOX` に未解決の conflict として残っているか。 */
  readonly open_conflict: boolean;
};

/**
 * component に結び付いた document locator を引く (Lane I、wish w-01M3N7RV5K の
 * `task.start_doing` anchor gate)。
 *
 * **「bound `^t-` anchor」の正本は document projection の locator** (`path#^<task_id>`)。
 * document を持たない decide 入口 (relation / event だけの fake) に「anchor 無し」を
 * 答えさせないため、`relationLookup` / `eventLookup` と同じく lookup として additive に足す。
 * lookup を持たない入口は gate が入口を名指しして `rejected` にする — `() => undefined` を
 * 既定にすると「検査不能」と「未観測」が区別できず、検査不能のまま `doing` へ入れてしまう。
 */
export type DocumentLocatorLookup = (componentId: ComponentId) => string | undefined;

export type DecideInput = {
  readonly command: Command;
  readonly context: RepositoryContext;
  readonly lookup: ComponentLookup;
  /**
   * component を作る operation で使う stable ID。
   * 採番は idempotent replay と一緒に保持する必要があるので、pure core では入力として受け取る。
   */
  readonly allocated_component_id?: ComponentId;
  /**
   * `task.start_doing` の anchor gate が引く document locator (additive)。
   * 無い入口は gate が `rejected` にする — document projection を読める入口は必ず渡す。
   */
  readonly documentLocatorLookup?: DocumentLocatorLookup;
};

export type CommandDecision = {
  readonly response: CommandResponse;
  /**
   * この決定が解決済みにする conflict event。`EVENT_INBOX.resolved_by_operation_id` を
   * 埋めるのは persistence 側なので、decide は「どれを解決したか」だけを返す。
   */
  readonly resolved_event_ids?: readonly EventId[];
  /** 更新後の target state。status も revision も変わらない場合は undefined。 */
  readonly next_state?: ComponentState;
  readonly created_states?: readonly ComponentState[];
  readonly added_relations?: readonly RelationKey[];
  /**
   * この決定が外す relation (裁定 root PM 2026-09-15)。
   * 永続化 (`COMPONENT_RELATIONS` からの DELETE) と committed diff への載せ方は persistence 側。
   */
  readonly removed_relations?: readonly RelationKey[];
  /**
   * `iteration.*` command が確定させる state (schema 6)。
   *
   * **component state / relation / event とは別経路。**iteration row は aggregate では
   * なく、membership と current pointer は components の state_revision を進めない。
   * 書き込みの実体は persistence 側 (`sql/iterations.ts`) が持つ。
   */
  readonly iteration_effect?: IterationEffect;
  /**
   * `sprint.*` command が確定させる state (schema 8)。
   * iteration と同じく aggregate ではなく、component の state_revision を進めない。
   */
  readonly sprint_effect?: SprintEffect;
  /** activity を append するか。Slice A では内容を保持せず、append の有無だけを返す。 */
  readonly appends_activity: boolean;
};

/** `iteration.*` command が確定させる DB 側の変更。fs side effect はここに含めない。 */
export type IterationEffect =
  | { readonly kind: "open"; readonly iteration: IterationInfo }
  | { readonly kind: "activate"; readonly iteration: IterationInfo }
  | {
    readonly kind: "deactivate";
    readonly iteration: IterationInfo;
    /** 外す対象が default だったか。fs 側が `current` link を外すかの判断材料。 */
    readonly was_default: boolean;
    /** 同じ op で default を引き継ぐ active iteration (optional sugar)。 */
    readonly next_default?: IterationInfo;
  }
  | {
    readonly kind: "set_default";
    readonly iteration: IterationInfo;
    /** 今の default (last_modified を両方 touch する裁定)。 */
    readonly previous_default?: IterationInfo;
  }
  | {
    /** activate + set_default の composite (0.20.0 の semantics を保持)。 */
    readonly kind: "switch";
    readonly iteration: IterationInfo;
    readonly previous_default?: IterationInfo;
    readonly carried_components: readonly ComponentId[];
    readonly carried_documents: readonly string[];
  }
  | {
    readonly kind: "carry";
    readonly iteration: IterationInfo;
    readonly carried_components: readonly ComponentId[];
    readonly carried_documents: readonly string[];
  }
  | { readonly kind: "dispose"; readonly iteration: IterationInfo };

/**
 * `sprint.*` command が確定させる DB 側の変更 (schema 8)。
 * sprint は immutable — 差分は次の issue が担うので effect は issue だけ。
 * fs side effect (registry / `sprint:` key の stamp) はここに含めない。
 */
export type SprintEffect = {
  readonly kind: "issue";
  readonly sprint: SprintInfo;
  readonly members: readonly SprintMember[];
};

const PLANNED_TASK: RelationType = "planned_task";

/**
 * relation を認識する入力。`DecideInput` に `relationLookup` だけを足した additive な拡張。
 * storage を持つ呼び出し (SQLite adapter) は必ずこちらを使う。
 */
export type RelationAwareDecideInput = DecideInput & {
  readonly relationLookup: RelationLookup;
};

/**
 * event を引ける入力 (Slice D)。storage を持つ呼び出しはこちらを使う。
 * `replication.resolve_conflict` を実際に適用できるのはこの入口だけ。
 */
export type ReplicationAwareDecideInput = RelationAwareDecideInput & {
  readonly eventLookup: EventLookup;
};

/**
 * iteration を読める入力 (schema 7)。storage を持つ呼び出しはこの入口を使う。
 *
 * `now` は `created_at` / `last_modified` / `carried_at` / `activated_at` の stamp。
 * decide が時計を持たないので、transaction 側が注入する。
 */
export type IterationAwareDecideInput = ReplicationAwareDecideInput & {
  readonly iterationLookup: IterationLookup;
  readonly now: string;
  /**
   * `task.start_doing` の anchor gate。storage を持つ入口は document projection の
   * locator を必ず渡す — DecideInput の optional をここで必須に絞る。
   */
  readonly documentLocatorLookup: DocumentLocatorLookup;
};

/**
 * sprint を読める入力 (schema 8)。storage を持つ呼び出しはこの入口を使う。
 *
 * `allocated_sprint_id` は `sp-<Crockford 10>` 形の採番済み ID。replay の同一性は
 * ledger が持つので deterministic である必要は無い (`allocated_component_id` と同じ)。
 */
export type SprintAwareDecideInput = IterationAwareDecideInput & {
  readonly sprintLookup: SprintLookup;
  readonly allocated_sprint_id?: string;
};

/**
 * relation を見ない既定の入口。**Slice A からの signature と振る舞いを変えない。**
 *
 * この入口は同一 relation の再 attach を `applied` と判定し、owner の revision を進める。
 * storage を持たない呼び出し (fixture、client 側 fake) 向けであり、既知の制限として残す。
 * duplicate を正しく noop にしたい呼び出しは `decideCommandWithRelations()` を使う。
 */
export function decideCommand(input: DecideInput): Result<CommandDecision> {
  // relation 集合を渡さない入口なので「既存 relation は分からない」を false で表す。
  // 既定化ではなく、この入口が持つ判定能力の限界そのもの。
  return decideCommandWithRelations({ ...input, relationLookup: () => false });
}

/**
 * relation を認識する入口。duplicate な relation attach を `noop` にし、revision を進めない。
 * 呼び出し側は現在の outgoing relation を引ける必要がある。
 *
 * **event は引けないので `replication.resolve_conflict` は `rejected` のまま。**
 * 既定化ではなく、この入口が持つ判定能力の限界そのもの。
 */
export function decideCommandWithRelations(
  input: RelationAwareDecideInput,
): Result<CommandDecision> {
  return decideCommandWithReplication({ ...input, eventLookup: EVENT_LOOKUP_UNAVAILABLE });
}

/**
 * 「event を引けない入口」を表す番人。
 *
 * `() => undefined` をそのまま渡すと「その event はこの repo に無い」という答えになり、
 * `not_found` を返してしまう。引けないことと無いことは違うので、**同一性で区別できる値**を
 * 1 つ置き、resolve 側でこの入口からの呼び出しだけ `rejected` にする。
 */
const EVENT_LOOKUP_UNAVAILABLE: EventLookup = () => undefined;

/**
 * event まで引ける入口 (Slice D)。`replication.resolve_conflict` を実際に適用できる唯一の入口。
 * 判断は 1 か所に保ち、storage 側で disposition を差し替えない。
 */
export function decideCommandWithReplication(
  input: ReplicationAwareDecideInput,
): Result<CommandDecision> {
  const { command, context, lookup } = input;
  if (command.repository_id !== context.repository_id) {
    return err(
      "repository_id_mismatch",
      `command の repository_id ${command.repository_id} が context と一致しない`,
      "repository_id",
    );
  }

  // iteration は component aggregate に乗らない。この入口から来た `iteration.*` は
  // iteration state を読めないので reject する — 落として unknown_operation にせず、
  // 「どこへ渡せばよいか」を reason に残す。
  if (isIterationOperation(command.operation)) {
    return ok({
      response: response(command, "rejected", {
        reason: `${command.operation} は iterationLookup を持つ入口` +
          " (decideCommandWithIterations) を必要とする",
      }),
      appends_activity: false,
    });
  }

  // sprint も component aggregate に乗らない。ここから来た `sprint.*` は sprint
  // state を読めないので、iteration op と同じく入口を名指しして reject する。
  if (isSprintOperation(command.operation)) {
    return ok({
      response: response(command, "rejected", {
        reason: `${command.operation} は sprintLookup を持つ入口` +
          " (decideCommandWithSprints) を必要とする",
      }),
      appends_activity: false,
    });
  }

  if (command.operation === "component.register") {
    return decideRegister(input);
  }

  // 登録以外は必ず target を持つ。envelope parse を通っていれば undefined にならない。
  const targetId = command.target_id;
  if (targetId === undefined) {
    return err(
      "target_id_required",
      `${command.operation} は target_id を必要とする`,
      "target_id",
    );
  }
  const target = lookup(targetId);
  if (target === undefined) {
    return ok({
      response: response(command, "not_found", {
        reason: `component ${
          formatComponentAddress(componentAddress(context.repository_id, targetId))
        } が見つからない`,
      }),
      appends_activity: false,
    });
  }

  const expected = command.expected_revision;
  // 裁定 (Slice B): presence と value を別の失敗に分ける。
  // presence 違反は typed 経路でも wire 経路と同じ `expected_revision_required` にする。
  // 以前は typed 経路だけが「未設定」を `conflict` として返しており、呼び出し側からは
  // 「誰かが先に更新した」と読めてしまっていた。`conflict` は値の不一致だけに残す。
  // wire 経路は `parseCommand()` が先に同じ code で落とすので、code と path は変わらない。
  if (
    OPERATION_SPECS[command.operation].expected_revision === "required" && expected === undefined
  ) {
    return err(
      "expected_revision_required",
      `${command.operation} は expected_revision を必要とする`,
      "expected_revision",
    );
  }
  if (expected !== undefined && expected !== target.state_revision) {
    return ok({
      response: response(command, "conflict", {
        component_id: targetId,
        state_revision: target.state_revision,
        reason: `expected_revision ${
          String(expected)
        } が現在の state_revision ${target.state_revision} と一致しない`,
      }),
      appends_activity: false,
    });
  }

  switch (command.operation) {
    case "activity.append":
      // activity は履歴であり workflow state を進めない。
      return ok({
        response: response(command, "applied", {
          component_id: targetId,
          state_revision: target.state_revision,
        }),
        appends_activity: true,
      });
    case "task.create_planned":
      return decideCreatePlanned(input, target);
    case "task.attach_planned":
      return decideAttachPlanned(input, target);
    case "relation.begin_external":
      return decideBeginExternal(input, target);
    case "relation.attach_external":
      return decideAttachExternal(input, target);
    case "relation.detach":
      return decideDetachRelation(input, target);
    case "relation.attach":
      return decideAttachLocal(input, target);
    case "replication.resolve_conflict":
      return decideResolveConflict(input, target);
    default:
      return decideTransition(input, target);
  }
}

function decideRegister(input: RelationAwareDecideInput): Result<CommandDecision> {
  const { command, context, lookup } = input;
  const componentId = input.allocated_component_id;
  if (componentId === undefined) {
    return err(
      "missing_field",
      "component.register には採番済みの component_id が必要である",
      "allocated_component_id",
    );
  }
  // payload に component_id が宣言されているなら採番結果と一致しなければならない。
  // request digest は payload を含むので、食い違いを通すと「digest に刻まれた ID」と
  // 「実際に登録された ID」が分かれ、canonical_request が状態を偽る。
  const declaredId = command.payload["component_id"];
  if (declaredId !== undefined && declaredId !== componentId) {
    return err(
      "invalid_id",
      `component_id ${String(declaredId)} が採番された ID ${componentId} と一致しない`,
      "component_id",
    );
  }
  const kind = command.payload["kind"] as ComponentKind;
  // 既存 ID への再 register (bugfix 6)。caller が既存の vault ID を指定する口を通った時と、
  // allocator が既存 ID を返した時にここへ来る。duplicate relation attach と同じ規則:
  // 同じ kind への再登録は望む状態が既にあるので `noop`、別 kind との衝突は `rejected`。
  // **推測 merge しない。**ここで止めないと COMPONENTS への INSERT が制約違反で落ちる。
  const existing = lookup(componentId);
  if (existing !== undefined) {
    return ok({
      response: response(
        command,
        existing.kind === kind ? "noop" : "rejected",
        {
          component_id: componentId,
          state_revision: existing.state_revision,
          ...(existing.kind === kind ? {} : {
            reason: `component ${componentId} は kind=${existing.kind} で既に登録されている`,
          }),
        },
      ),
      appends_activity: false,
    });
  }
  const created: ComponentState = {
    address: componentAddress(context.repository_id, componentId),
    kind,
    status: initialStatus(kind),
    state_revision: 0,
  };
  return ok({
    response: response(command, "applied", {
      component_id: componentId,
      state_revision: created.state_revision,
      created_ids: [created.address],
    }),
    created_states: [created],
    appends_activity: true,
  });
}

function decideTransition(
  input: RelationAwareDecideInput,
  target: ComponentState,
): Result<CommandDecision> {
  const { command } = input;
  if (target.status === undefined) {
    return err("missing_status", `${target.kind} は status を持たないため遷移できない`);
  }
  const evaluated = evaluateCommandTransition(command.operation, target.status);
  if (!evaluated.ok) return evaluated;
  const outcome = evaluated.value;
  if (outcome === undefined) {
    return err("unknown_operation", `${command.operation} の transition 定義が無い`);
  }
  if (outcome.kind === "rejected") {
    return ok({
      response: response(command, "rejected", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
        reason: outcome.reason,
      }),
      appends_activity: false,
    });
  }
  if (outcome.kind === "noop") {
    return ok({
      response: response(command, "noop", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
      }),
      appends_activity: false,
    });
  }
  // Lane I (wish w-01M3N7RV5K): `doing` へ入る task は bound `^t-` document anchor を要求する。
  // evidence: anchor 無しのまま `doing` へ入った task は document node が実装 commit の中で
  // 事後生成され、parity が自己修復できなかった。gate は applied になる遷移だけに掛ける —
  // 上で返した noop / rejected の再判定には掛けない。
  if (command.operation === "task.start_doing") {
    const locatorLookup = input.documentLocatorLookup;
    if (locatorLookup === undefined) {
      return ok({
        response: response(command, "rejected", {
          component_id: target.address.component_id,
          state_revision: target.state_revision,
          reason: "task.start_doing は document locator を引ける入口" +
            " (documentLocatorLookup を持つ decideCommandWithIterations) を必要とする",
        }),
        appends_activity: false,
      });
    }
    const locator = locatorLookup(target.address.component_id);
    const bound = locator !== undefined &&
      parseTaskLocator(locator, target.address.component_id).ok;
    if (!bound) {
      return ok({
        response: response(command, "rejected", {
          component_id: target.address.component_id,
          state_revision: target.state_revision,
          reason: `task_document_anchor_missing: task ${target.address.component_id} には` +
            ` ^${target.address.component_id} anchor の document 観測が無い` +
            ` (document_locator: ${locator ?? "未設定"})`,
        }),
        appends_activity: false,
      });
    }
  }
  const next: ComponentState = {
    ...target,
    status: outcome.next,
    state_revision: nextRevision(target.state_revision),
  };
  return ok({
    response: response(command, "applied", {
      component_id: target.address.component_id,
      state_revision: next.state_revision,
    }),
    next_state: next,
    appends_activity: true,
  });
}

function decideCreatePlanned(
  input: RelationAwareDecideInput,
  owner: ComponentState,
): Result<CommandDecision> {
  const { context } = input;
  const taskId = input.allocated_component_id;
  if (taskId === undefined) {
    return err(
      "missing_field",
      "task.create_planned には採番済みの component_id が必要である",
      "allocated_component_id",
    );
  }
  const task: ComponentState = {
    address: componentAddress(context.repository_id, taskId),
    kind: "task",
    status: initialStatus("task"),
    state_revision: 0,
  };
  const relation: RelationKey = {
    source: owner.address,
    target: task.address,
    relation_type: PLANNED_TASK,
  };
  return attachRelation(input, owner, relation, [task]);
}

function decideAttachPlanned(
  input: RelationAwareDecideInput,
  owner: ComponentState,
): Result<CommandDecision> {
  const { command, context, lookup } = input;
  const taskId = command.payload["task_component_id"] as ComponentId;
  const task = lookup(taskId);
  if (task === undefined) {
    return ok({
      response: response(command, "not_found", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
        reason: `attach 対象の task ${taskId} が見つからない`,
      }),
      appends_activity: false,
    });
  }
  const relation: RelationKey = {
    source: owner.address,
    target: componentAddress(context.repository_id, taskId),
    relation_type: PLANNED_TASK,
  };
  return attachRelation(input, owner, relation, []);
}

/**
 * cross-repo intent の口を開く (裁定 Slice E)。
 *
 * **relation を足さない。** この時点で target component ID はまだ存在しない (target repo が
 * 採番する)。relation を先に作ると、存在しない相手を指す正本 relation が source repo に残る。
 *
 * **`state_revision` を進めない。** intent は relation ではない。進めると同じ Wish に対する
 * 独立した 2 つの cross-repo intent が互いに conflict する。残るのは `OPERATIONS` の receipt と
 * `ACTIVITIES` の 1 行で、これが durable な pending intent の実体である
 * (`persistence.md` "Persistence boundary": 専用 coordinator table を作らない)。
 */
function decideBeginExternal(
  input: RelationAwareDecideInput,
  owner: ComponentState,
): Result<CommandDecision> {
  const { command, context } = input;
  const targetRepositoryId = command.payload["target_repository_id"] as RepositoryId;
  if (targetRepositoryId === context.repository_id) {
    // 同一 repo の planned Task 作成は 1 transaction で行う operation が既にある。
    // cross-repo の 2 step 手順を同一 repo へ使うと、atomic に出来るものを分割することになる。
    return ok({
      response: response(command, "rejected", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
        reason: "target が同一 repo である。同一 repo の planned Task は " +
          "task.create_planned で 1 transaction で作る",
      }),
      appends_activity: false,
    });
  }
  // **移動の 2 field は両方そろっているか、両方無いか。**片方だけを受理すると、
  // 「畳む相手は分かるが送る ID が無い」か「ID はあるが相手が分からない」intent ができる。
  // どちらも recovery が実行できない step なので、開かせない。
  const detachComponentId = command.payload["source_detach_component_id"] as
    | ComponentId
    | undefined;
  const detachOperationId = command.payload["source_detach_operation_id"] as
    | OperationId
    | undefined;
  if ((detachComponentId === undefined) !== (detachOperationId === undefined)) {
    return ok({
      response: response(command, "rejected", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
        reason: "source_detach_component_id と source_detach_operation_id は" +
          "両方そろえるか、両方省く必要がある",
      }),
      appends_activity: false,
    });
  }
  const steps = checkStepOperationIds(
    command.operation_id,
    command.payload["target_create_operation_id"] as OperationId,
    command.payload["source_attach_operation_id"] as OperationId,
    detachOperationId,
  );
  if (!steps.ok) {
    return ok({
      response: response(command, "rejected", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
        reason: steps.error.message,
      }),
      appends_activity: false,
    });
  }
  return ok({
    response: response(command, "applied", {
      component_id: owner.address.component_id,
      state_revision: owner.state_revision,
    }),
    appends_activity: true,
  });
}

function decideAttachExternal(
  input: RelationAwareDecideInput,
  owner: ComponentState,
): Result<CommandDecision> {
  const { command } = input;
  const relation: RelationKey = {
    source: owner.address,
    target: componentAddress(
      command.payload["target_repository_id"] as never,
      command.payload["target_component_id"] as never,
    ),
    relation_type: command.payload["relation_type"] as RelationType,
  };
  return attachRelation(input, owner, relation, []);
}

/**
 * manual conflict resolve (Slice D)。
 *
 * `interfaces.md`: 「競合した event IDs と採用内容を payload で参照し、新しい DomainEvent を作る」。
 * payload は event ID しか持たないので、**採用内容 = 採用した event の committed diff** になる。
 * 採用先を payload の外から与える形にはできない。
 *
 * **裁定 (Slice D): `adopted_event_id` は `conflicting_event_ids` の要素でなければならない。**
 * payload が結果 state を持たない以上、採用できるのは競合している event のどれかだけ。第三の
 * 結果を作れる形にすると、payload が表現できない state を command が要求することになる。
 *
 * **裁定 (Slice D): 採用しなかった側の diff は復元しない。** automatic merge は初期 scope 外で、
 * ここで拾うと merge 規則を暗黙に作ることになる。失われる範囲は README の残余 risk が持つ。
 */
/**
 * relation を 1 本外す (裁定 root PM 2026-09-15)。
 *
 * **`attachRelation` の鏡像。**存在しない relation の detach は `noop` で revision を進めない。
 * attach 側が「既にある relation の再 attach は noop」なので、対称に置く。`not_found` にしない
 * のは、`not_found` が「target component を引けない」を表す code だから。**外れているという
 * 結果は同じなので、再送で落ちる形にしない。**
 *
 * target component (relation の相手) が存在するかは見ない。**relation は source 側の所有物**で、
 * 相手が消えていても source の relation は外せる必要がある。
 */
function decideDetachRelation(
  input: RelationAwareDecideInput,
  owner: ComponentState,
): Result<CommandDecision> {
  const { command } = input;
  const relation: RelationKey = {
    source: owner.address,
    target: componentAddress(
      command.payload["target_repository_id"] as RepositoryId,
      command.payload["target_component_id"] as ComponentId,
    ),
    relation_type: command.payload["relation_type"] as RelationType,
  };
  // locality の検査は attach と同じものを通す。self reference と source の非 local をここで落とす。
  const locality = relationLocality(relation, input.context);
  if (!locality.ok) return locality;

  if (!input.relationLookup(relation)) {
    return ok({
      response: response(command, "noop", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
      }),
      appends_activity: false,
    });
  }
  const next: ComponentState = {
    ...owner,
    state_revision: nextRevision(owner.state_revision),
  };
  return ok({
    response: response(command, "applied", {
      component_id: owner.address.component_id,
      state_revision: next.state_revision,
      removed_relations: [relation],
    }),
    next_state: next,
    removed_relations: [relation],
    appends_activity: true,
  });
}

function decideResolveConflict(
  input: ReplicationAwareDecideInput,
  target: ComponentState,
): Result<CommandDecision> {
  const { command } = input;
  if (input.eventLookup === EVENT_LOOKUP_UNAVAILABLE) {
    // event を引けない入口。受理したように見せず、無いとも言わない。
    return ok({
      response: response(command, "rejected", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
        reason: "この入口は committed event を引けないため conflict を解決できない",
      }),
      appends_activity: false,
    });
  }
  const conflicting = command.payload["conflicting_event_ids"] as readonly EventId[];
  const adoptedId = command.payload["adopted_event_id"] as EventId;

  if (!conflicting.includes(adoptedId)) {
    return ok({
      response: response(command, "rejected", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
        reason: `adopted_event_id ${adoptedId} が conflicting_event_ids に含まれていない`,
      }),
      appends_activity: false,
    });
  }

  const summaries: StoredEventSummary[] = [];
  for (const eventId of conflicting) {
    const summary = input.eventLookup(eventId);
    if (summary === undefined) {
      return ok({
        response: response(command, "not_found", {
          component_id: target.address.component_id,
          state_revision: target.state_revision,
          reason: `event ${eventId} がこの repo に無い`,
        }),
        appends_activity: false,
      });
    }
    // 別 component の conflict をこの target で解決させない。
    if (summary.aggregate_id !== target.address.component_id) {
      return err(
        "event_aggregate_mismatch",
        `event ${eventId} の aggregate ${summary.aggregate_id} が target ${target.address.component_id} と違う`,
        "payload.conflicting_event_ids",
      );
    }
    summaries.push(summary);
  }

  // 解決すべき conflict が 1 つも残っていない。別 operation_id での再実行を安全にするため、
  // 勝手に revision を進めず noop にする。
  if (!summaries.some((summary) => summary.open_conflict)) {
    return ok({
      response: response(command, "noop", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
        reason: "未解決の conflict が無い",
      }),
      appends_activity: false,
    });
  }

  const adopted = summaries.find((summary) => summary.event_id === adoptedId);
  if (adopted === undefined) {
    return err(
      "adopted_event_not_in_conflict",
      `adopted_event_id ${adoptedId} を解決対象から引けない`,
      "payload.adopted_event_id",
    );
  }

  // 採用した event の結果 status を、local の次 revision として確定する。
  // adopted の aggregate_revision をそのまま採らない。revision は repo-local な連番であり、
  // 他 device の revision を移植すると以後の expected_revision 検査が壊れる。
  const next: ComponentState = {
    ...target,
    status: adopted.resulting_status ?? target.status,
    state_revision: nextRevision(target.state_revision),
  };
  const relations = adopted.added_relations.filter((relation) => !input.relationLookup(relation));
  // 採用した event が relation を外すものなら、その除去も一緒に確定する。
  const removed = (adopted.removed_relations ?? []).filter((relation) =>
    input.relationLookup(relation)
  );

  return ok({
    response: response(command, "applied", {
      component_id: target.address.component_id,
      state_revision: next.state_revision,
    }),
    next_state: next,
    ...(relations.length === 0 ? {} : { added_relations: relations }),
    ...(removed.length === 0 ? {} : { removed_relations: removed }),
    // **open な subset ではなく、競合 set 全体を返す。** 人が下した決定は set 全体に対する
    // もので、どれが自分の inbox にあるかは device ごとに違う。set 全体を event へ載せて
    // おかないと、受信側が自分の側の marker を消せない。実際に、片側だけを載せた実装では
    // resolve した device だけ conflict が消え、相手に消せない marker が残った。
    resolved_event_ids: conflicting,
    appends_activity: true,
  });
}

/**
 * outgoing relation の追加は owner の state_revision を進める。
 * Task 作成と relation 追加を同じ decision で返すことで、同一 repo の atomicity を表す。
 */
function attachRelation(
  input: RelationAwareDecideInput,
  owner: ComponentState,
  relation: RelationKey,
  createdStates: readonly ComponentState[],
): Result<CommandDecision> {
  const locality = relationLocality(relation, input.context);
  if (!locality.ok) return locality;
  // 既にある relation の再 attach は state を変えないので noop。revision を進めない。
  // 新規 component を作る operation は採番済み ID が毎回新しく、ここには落ちてこない。
  if (input.relationLookup(relation)) {
    return ok({
      response: response(input.command, "noop", {
        component_id: owner.address.component_id,
        state_revision: owner.state_revision,
      }),
      appends_activity: false,
    });
  }
  const next: ComponentState = {
    ...owner,
    state_revision: nextRevision(owner.state_revision),
  };
  return ok({
    response: response(input.command, "applied", {
      component_id: owner.address.component_id,
      state_revision: next.state_revision,
      created_ids: createdStates.map((state) => state.address),
    }),
    next_state: next,
    created_states: createdStates,
    added_relations: [relation],
    appends_activity: true,
  });
}

function nextRevision(current: Revision): Revision {
  return current + 1;
}

/**
 * 同一 repo 内の outgoing relation を足す (iteration の successor -> predecessor)。
 *
 * `to_repository_id` が local と一致する時だけ受ける。外部 repo への attach は
 * correlation_id を必須にする `relation.attach_external` の仕事なので、ここで受けると
 * 「どちらを使うか」が payload ではなく呼び出しの結果で分かれてしまう。
 */
function decideAttachLocal(
  input: RelationAwareDecideInput,
  target: ComponentState,
): Result<CommandDecision> {
  const { command, context } = input;
  const toRepositoryId = command.payload["target_repository_id"];
  const toComponentId = command.payload["target_component_id"];
  const relationType = command.payload["relation_type"];
  if (
    typeof toRepositoryId !== "string" || typeof toComponentId !== "string" ||
    typeof relationType !== "string"
  ) {
    return err(
      "missing_field",
      "relation.attach は target_repository_id / target_component_id / relation_type を必要とする",
      "payload",
    );
  }
  if (toRepositoryId !== context.repository_id) {
    return ok({
      response: response(command, "rejected", {
        component_id: target.address.component_id,
        state_revision: target.state_revision,
        reason: `to_repository_id ${toRepositoryId} は external。` +
          "外部 repo への attach は relation.attach_external を使う",
      }),
      appends_activity: false,
    });
  }
  const relation: RelationKey = {
    source: target.address,
    target: componentAddress(toRepositoryId as RepositoryId, toComponentId as ComponentId),
    relation_type: relationType as RelationType,
  };
  return attachRelation(input, target, relation, []);
}

// ---------------------------------------------------------------------------
// iteration (schema 7)
// ---------------------------------------------------------------------------

export function isIterationOperation(operation: string): boolean {
  return operation.startsWith("iteration.");
}

/**
 * iteration を読める入口。storage を持つ呼び出しは必ずこちらを使う。
 *
 * `iteration.*` は component aggregate に乗らないので、`component.register` や
 * transition 判定とは別の枝で決める。component 側の command はそのまま
 * `decideCommandWithReplication` へ流す。
 */
export function decideCommandWithIterations(
  input: IterationAwareDecideInput,
): Result<CommandDecision> {
  if (isIterationOperation(input.command.operation)) {
    return decideIteration(input);
  }
  // component を新しく作る op は、scope に active iteration が在って default が無いと
  // membership の行き先を決められない。optional current の裁定 (schema 7) に従い、
  // 明示 (`iteration_id`) が無ければここで fail closed にする。auto-pick はしない。
  if (
    input.command.operation === "component.register" ||
    input.command.operation === "task.create_planned"
  ) {
    const gate = iterationMembershipGate(input);
    if (gate !== undefined) return ok(gate);
  }
  return decideCommandWithReplication(input);
}

/**
 * `component.register` / `task.create_planned` の membership 解決の番人。
 * 返すのは「止める decision」だけ — 通す場合は undefined。
 *
 * - payload の `iteration_id` が在ればその iteration (実在・未 dispose・scope 一致) を
 *   membership の行き先として受理する。
 * - 無ければ scope の default を使う。default が無く active set が非空なら、
 *   どれへ入れるか決められないので rejected (component と active label を名指す)。
 * - active が 1 つも無い scope は今までどおり membership 無しで通る。
 * - 既存 component への再 register は decideRegister が noop にするので対象外。
 */
function iterationMembershipGate(
  input: IterationAwareDecideInput,
): CommandDecision | undefined {
  const { command, iterationLookup: iterations, lookup } = input;
  if (
    input.allocated_component_id !== undefined &&
    lookup(input.allocated_component_id) !== undefined
  ) {
    return undefined; // 再 register — membership の解決は一度だけ
  }
  const located = typeof command.payload["locator"] === "string"
    ? iterations.containing(command.payload["locator"] as string)
    : undefined;
  const scope = located === undefined
    ? { scope: "project" as const, component_path: "" }
    : { scope: located.scope, component_path: located.component_path };
  const stop = (disposition: "rejected" | "not_found", reason: string): CommandDecision => ({
    response: response(command, disposition, { reason }),
    appends_activity: false,
  });

  const explicit = command.payload["iteration_id"];
  if (explicit !== undefined) {
    const target = typeof explicit === "string" ? iterations.byId(explicit) : undefined;
    if (target === undefined) {
      return stop("not_found", `iteration ${String(explicit)} が見つからない`);
    }
    if (target.disposed_at !== undefined) {
      return stop("rejected", `iteration ${explicit} は disposed 済み`);
    }
    if (target.scope !== scope.scope || target.component_path !== scope.component_path) {
      return stop(
        "rejected",
        `iteration ${explicit} は別 scope (${target.scope}:${target.component_path || "-"}) — ` +
          `locator の scope は ${scope.scope}:${scope.component_path || "-"}`,
      );
    }
    return undefined;
  }
  if (iterations.defaultIteration(scope.scope, scope.component_path) !== undefined) {
    return undefined;
  }
  const actives = iterations.activeIterations(scope.scope, scope.component_path);
  if (actives.length === 0) return undefined;
  return stop(
    "rejected",
    `${scope.component_path || "project"} に default iteration が無い` +
      ` (active: ${actives.map((it) => it.name).join(", ")})。` +
      "iteration_id を payload に渡すか iteration.set_default で default を置く",
  );
}

/**
 * `iteration.*` の disposition。
 *
 * **rejected でも operation ledger には残る** (runLocalCommand が claim row を置く)。
 * 受理されなかった open の試行が消えないので、label の再利用判断は DB が取れる。
 */
function decideIteration(input: IterationAwareDecideInput): Result<CommandDecision> {
  const { command, iterationLookup: iterations } = input;
  const reject = (reason: string): Result<CommandDecision> =>
    ok({
      response: response(command, "rejected", { reason }),
      appends_activity: false,
    });
  const payloadScope = command.payload["scope"];
  const payloadPath = command.payload["component_path"];
  const scope = typeof payloadScope === "string" ? (payloadScope as IterationScope) : undefined;
  const componentPath = typeof payloadPath === "string" ? payloadPath : "";

  switch (command.operation) {
    case "iteration.open": {
      if (scope === undefined) {
        return reject("scope は project | component である必要がある");
      }
      // scope と path の整合はここでしか見ない。payload 片側だけの指定を
      // 黙って丸めると、意図した scope と違う場所へ dir が生える。
      if (scope === "component") {
        const checkedPath = validateComponentPath(componentPath, "payload.component_path");
        if (!checkedPath.ok) {
          return reject(
            `component scope には有効な component_path が必要: ${checkedPath.error.message}`,
          );
        }
      } else if (componentPath !== "") {
        return reject("project scope は component_path を持たない");
      }
      const name = command.payload["name"];
      const label = validateIterationLabel(name, "payload.name");
      if (!label.ok) return reject(label.error.message);
      // label は使い捨てない。disposed でも同じ名前を作り直さない (dir が残るので
      // DB 上の一意性だけでなく filesystem 側の一意性も守る)。
      if (iterations.byName(scope, componentPath, label.value) !== undefined) {
        return reject(
          `label ${label.value} はこの scope (${scope}:${componentPath || "-"}) で既に使われている`,
        );
      }
      const predecessorId = command.payload["predecessor_iteration_id"];
      let predecessor: IterationInfo | undefined;
      if (typeof predecessorId === "string") {
        predecessor = iterations.byId(predecessorId);
        if (predecessor === undefined) {
          return reject(`predecessor ${predecessorId} が存在しない`);
        }
        if (predecessor.scope !== scope || predecessor.component_path !== componentPath) {
          return reject(
            `predecessor ${predecessorId} は別 scope (${predecessor.scope}:${
              predecessor.component_path || "-"
            }) の iteration`,
          );
        }
        if (predecessor.disposed_at !== undefined) {
          return reject(`predecessor ${predecessorId} は disposed 済み`);
        }
      }
      // iteration_id は operation_id から決定的に採番する。再送は ledger が同じ
      // response を返すので、ここで random にせず `it-<operation_id>` にする。
      const iteration: IterationInfo = {
        iteration_id: `it-${command.operation_id}`,
        scope,
        component_path: componentPath,
        name: label.value,
        seq: iterations.nextSeq(scope, componentPath),
        ...(predecessor === undefined
          ? {}
          : { predecessor_iteration_id: predecessor.iteration_id }),
        created_at: input.now,
        last_modified: input.now,
      };
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: { kind: "open", iteration },
        appends_activity: false,
      });
    }
    case "iteration.activate": {
      const target = iterationTarget(command, iterations);
      if ("decision" in target) return ok(target.decision);
      const iteration = target.iteration;
      if (isActive(iterations, iteration)) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: { kind: "activate", iteration },
        appends_activity: false,
      });
    }
    case "iteration.deactivate": {
      const target = iterationTarget(command, iterations);
      if ("decision" in target) return ok(target.decision);
      const iteration = target.iteration;
      const actives = iterations.activeIterations(
        iteration.scope,
        iteration.component_path,
      );
      if (!actives.some((it) => it.iteration_id === iteration.iteration_id)) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      // default を外すと default が消える (user 裁定: current は optional)。
      // `next_default` を渡せば同じ op で atomic に引き継ぐ。引き継ぎ先は
      // 残る側の active member でなければならない。
      const previousDefault = iterations.defaultIteration(
        iteration.scope,
        iteration.component_path,
      );
      const nextDefaultId = command.payload["next_default"];
      let nextDefault: IterationInfo | undefined;
      if (typeof nextDefaultId === "string") {
        if (nextDefaultId === iteration.iteration_id) {
          return reject("next_default は deactivate 対象自身を指せない");
        }
        nextDefault = iterations.byId(nextDefaultId);
        if (nextDefault === undefined) {
          return reject(`next_default ${nextDefaultId} が見つからない`);
        }
        if (nextDefault.disposed_at !== undefined) {
          return reject(`next_default ${nextDefaultId} は disposed 済み`);
        }
        if (
          !actives.some((it) => it.iteration_id === nextDefault!.iteration_id)
        ) {
          return reject(
            `next_default ${nextDefaultId} はこの scope の active set に無い`,
          );
        }
      }
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: {
          kind: "deactivate",
          iteration,
          was_default: previousDefault?.iteration_id === iteration.iteration_id,
          ...(nextDefault === undefined ? {} : { next_default: nextDefault }),
        },
        appends_activity: false,
      });
    }
    case "iteration.set_default": {
      const target = iterationTarget(command, iterations);
      if ("decision" in target) return ok(target.decision);
      const iteration = target.iteration;
      // default は active set の member でなければならない — active でないものを
      // 指す current link は 0.20.0 と違って矛盾状態 (repair でも fail する)。
      if (!isActive(iterations, iteration)) {
        return reject(
          `iteration ${iteration.iteration_id} は active でない — 先に activate する`,
        );
      }
      const previousDefault = iterations.defaultIteration(
        iteration.scope,
        iteration.component_path,
      );
      if (previousDefault?.iteration_id === iteration.iteration_id) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: {
          kind: "set_default",
          iteration,
          ...(previousDefault === undefined ? {} : { previous_default: previousDefault }),
        },
        appends_activity: false,
      });
    }
    case "iteration.switch": {
      const target = iterationTarget(command, iterations);
      if ("decision" in target) return ok(target.decision);
      const iteration = target.iteration;
      if (
        scope !== undefined &&
        (scope !== iteration.scope || componentPath !== iteration.component_path)
      ) {
        return reject(
          `request の scope (${scope}:${componentPath || "-"}) が iteration の ` +
            `${iteration.scope}:${iteration.component_path || "-"} と一致しない`,
        );
      }
      const carried = carriedMembers(command, input, iteration, iterations);
      if ("decision" in carried) return ok(carried.decision);
      // composite: activate (member でなければ足す) + set_default (違えば付け替え)。
      // 対象が既に default なら carry 分が空のとき noop。
      const previousDefault = iterations.defaultIteration(
        iteration.scope,
        iteration.component_path,
      );
      if (
        previousDefault?.iteration_id === iteration.iteration_id &&
        carried.components.length === 0 && carried.documents.length === 0
      ) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: {
          kind: "switch",
          iteration,
          ...(previousDefault === undefined ||
              previousDefault.iteration_id === iteration.iteration_id
            ? {}
            : { previous_default: previousDefault }),
          carried_components: carried.components,
          carried_documents: carried.documents,
        },
        appends_activity: false,
      });
    }
    case "iteration.carry": {
      const target = iterationTarget(command, iterations);
      if ("decision" in target) return ok(target.decision);
      const iteration = target.iteration;
      const carried = carriedMembers(command, input, iteration, iterations);
      if ("decision" in carried) return ok(carried.decision);
      if (carried.components.length === 0 && carried.documents.length === 0) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      return ok({
        response: response(command, "applied", { iteration }),
        iteration_effect: {
          kind: "carry",
          iteration,
          carried_components: carried.components,
          carried_documents: carried.documents,
        },
        appends_activity: false,
      });
    }
    case "iteration.dispose": {
      const target = command.payload["iteration_id"];
      if (typeof target !== "string") {
        return reject("iteration_id は string である必要がある");
      }
      const iteration = iterations.byId(target);
      if (iteration === undefined) {
        return ok({
          response: response(command, "not_found", {
            reason: `iteration ${target} が見つからない`,
          }),
          appends_activity: false,
        });
      }
      if (iteration.disposed_at !== undefined) {
        return ok({
          response: response(command, "noop", { iteration }),
          appends_activity: false,
        });
      }
      // active set に残っているものは dispose できない。row 消去でなく tombstone なので、
      // active link を張ったままの dispose は fs 上の active set と矛盾する。
      if (isActive(iterations, iteration)) {
        return reject(
          `iteration ${iteration.iteration_id} はまだ active — 先に deactivate する`,
        );
      }
      const disposed: IterationInfo = { ...iteration, disposed_at: input.now };
      return ok({
        response: response(command, "applied", { iteration: disposed }),
        iteration_effect: { kind: "dispose", iteration: disposed },
        appends_activity: false,
      });
    }
    default:
      return err(
        "unknown_operation",
        `未知の iteration operation: ${command.operation}`,
        "operation",
      );
  }
}

/** iteration が自分の scope の active set に入っているか。 */
function isActive(
  iterations: IterationLookup,
  iteration: IterationInfo,
): boolean {
  return iterations
    .activeIterations(iteration.scope, iteration.component_path)
    .some((it) => it.iteration_id === iteration.iteration_id);
}

/** iteration op が対象にする iteration。存在しない / disposed ならその decision を返す。 */
function iterationTarget(
  command: Command,
  iterations: IterationLookup,
): { iteration: IterationInfo } | { decision: CommandDecision } {
  const target = command.payload["iteration_id"];
  if (typeof target !== "string") {
    return {
      decision: {
        response: response(command, "rejected", {
          reason: "iteration_id は string である必要がある",
        }),
        appends_activity: false,
      },
    };
  }
  const iteration = iterations.byId(target);
  if (iteration === undefined) {
    return {
      decision: {
        response: response(command, "not_found", {
          reason: `iteration ${target} が見つからない`,
        }),
        appends_activity: false,
      },
    };
  }
  if (iteration.disposed_at !== undefined) {
    return {
      decision: {
        response: response(command, "rejected", {
          iteration,
          reason: `iteration ${target} は disposed 済み`,
        }),
        appends_activity: false,
      },
    };
  }
  return { iteration };
}

/**
 * switch / carry の `components` / `documents` payload を、まだ member でない
 * ものだけへ絞る。既に member の分を再度足しても noop に倒す。
 */
function carriedMembers(
  command: Command,
  input: IterationAwareDecideInput,
  iteration: IterationInfo,
  iterations: IterationLookup,
):
  | { components: ComponentId[]; documents: string[] }
  | { decision: CommandDecision } {
  const componentsRaw = command.payload["components"];
  const documentsRaw = command.payload["documents"];
  const components = Array.isArray(componentsRaw) ? componentsRaw as ComponentId[] : [];
  const documents = Array.isArray(documentsRaw) ? documentsRaw as string[] : [];
  // member に載せる component は存在するものだけ。typo の id を黙って入れない。
  for (const componentId of components) {
    if (input.lookup(componentId) === undefined) {
      return {
        decision: {
          response: response(command, "not_found", {
            iteration,
            reason: `member の component ${componentId} が見つからない`,
          }),
          appends_activity: false,
        },
      };
    }
  }
  const existing = iterations.members(iteration.iteration_id);
  return {
    components: components.filter((id) => !existing.components.includes(id)),
    documents: documents.filter((path) => !existing.documents.includes(path)),
  };
}

// ---------------------------------------------------------------------------
// sprint (schema 8)
// ---------------------------------------------------------------------------

export function isSprintOperation(operation: string): boolean {
  return operation.startsWith("sprint.");
}

/**
 * sprint を読める入口。storage を持つ呼び出しは必ずこちらを使う。
 *
 * `sprint.*` は component aggregate に乗らないので `decideIteration` と同じく
 * 別の枝で決める。component 側の command は `decideCommandWithIterations` へ流す。
 */
export function decideCommandWithSprints(
  input: SprintAwareDecideInput,
): Result<CommandDecision> {
  if (isSprintOperation(input.command.operation)) {
    return decideSprintIssue(input);
  }
  return decideCommandWithIterations(input);
}

/** kind を問わず使う terminal status の集合。sprint roster の非終端検査用。 */
const SPRINT_TERMINAL_STATUSES = new Set<string>([
  ...WISH_TERMINAL_STATUSES,
  ...TASK_TERMINAL_STATUSES,
]);

/**
 * `sprint.issue` の disposition。
 *
 * 検査は全部 decide に集める — roster の実在 / kind / 終端 / membership / revision、
 * expected_head の同時実行検査、goal の 1 行正規化。通った時だけ issue する。
 * rejected / conflict / not_found でも ledger には残る (iteration op と同じ規則)。
 */
function decideSprintIssue(input: SprintAwareDecideInput): Result<CommandDecision> {
  const { command, iterationLookup: iterations, sprintLookup: sprints, lookup } = input;
  const reject = (reason: string): Result<CommandDecision> =>
    ok({
      response: response(command, "rejected", { reason }),
      appends_activity: false,
    });
  const conflict = (reason: string): Result<CommandDecision> =>
    ok({
      response: response(command, "conflict", { reason }),
      appends_activity: false,
    });
  if (command.operation !== "sprint.issue") {
    return err(
      "unknown_operation",
      `未知の sprint operation: ${command.operation}`,
      "operation",
    );
  }
  const iterationId = command.payload["iteration_id"];
  if (typeof iterationId !== "string") {
    return reject("iteration_id は string である必要がある");
  }
  const iteration = iterations.byId(iterationId);
  if (iteration === undefined) {
    return ok({
      response: response(command, "not_found", {
        reason: `iteration ${iterationId} が見つからない`,
      }),
      appends_activity: false,
    });
  }
  if (iteration.disposed_at !== undefined) {
    return reject(`iteration ${iterationId} は disposed 済み`);
  }

  // 同時実行検査 1: expected_head。省略は「head 無しを期待」。
  // head が動いていたら conflict — 暗黙に前の sprint の上へ乗せない。
  const expectedHead = command.payload["expected_head"];
  const head = sprints.head(iteration.iteration_id);
  if (expectedHead === undefined) {
    if (head !== undefined) {
      return conflict(
        `iteration ${iteration.name} の head は ${head.sprint_id} だが expected_head が無い` +
          " — head 更新を意図するなら expected_head を渡す",
      );
    }
  } else if (typeof expectedHead !== "string") {
    return reject("expected_head は string である必要がある");
  } else if (head === undefined || head.sprint_id !== expectedHead) {
    return conflict(
      `expected_head ${expectedHead} が現在の head ${head?.sprint_id ?? "なし"} と一致しない`,
    );
  }

  // 同時実行検査 2: roster。member はその iteration の member (birth or carry) の
  // 非終端 wish / mind で、見た revision が現在と一致していること。
  const rosterRaw = command.payload["roster"];
  const roster = (Array.isArray(rosterRaw) ? rosterRaw : []) as readonly SprintRosterEntry[];
  const membership = iterations.members(iteration.iteration_id);
  for (const entry of roster) {
    const component = lookup(entry.component_id);
    if (component === undefined) {
      return ok({
        response: response(command, "not_found", {
          reason: `roster の component ${entry.component_id} が見つからない`,
        }),
        appends_activity: false,
      });
    }
    if (component.kind === "task") {
      return reject(
        `roster の ${entry.component_id} は task — sprint member は wish / mind に限る` +
          " (task-level binding は後続の拡張)",
      );
    }
    if (
      component.status !== undefined && SPRINT_TERMINAL_STATUSES.has(component.status)
    ) {
      return reject(
        `roster の ${entry.component_id} は terminal status (${component.status})`,
      );
    }
    if (!membership.components.includes(entry.component_id)) {
      return reject(
        `roster の ${entry.component_id} は iteration ${iteration.name} の member でない`,
      );
    }
    if (component.state_revision !== entry.expected_revision) {
      return conflict(
        `roster の ${entry.component_id} は expected_revision ${entry.expected_revision} だが` +
          ` 現在は r${component.state_revision}`,
      );
    }
  }

  const sprintId = input.allocated_sprint_id;
  if (sprintId === undefined) {
    return err(
      "missing_field",
      "sprint.issue には採番済みの sprint_id が必要である",
      "allocated_sprint_id",
    );
  }
  const goal = normalizeSprintLine(command.payload["goal"] as string);
  const accepted = normalizeSprintLine(command.payload["accepted"] as string);
  if (goal === "") return reject("goal は空にできない");
  if (accepted === "") return reject("accepted は空にできない");
  const baselineRaw = command.payload["baseline_ref"];
  const baselineRef = typeof baselineRaw === "string" ? normalizeSprintLine(baselineRaw) : "";

  const seq = sprints.nextSeq(iteration.iteration_id);
  const sprint: SprintInfo = {
    sprint_id: sprintId,
    iteration_id: iteration.iteration_id,
    scope: iteration.scope,
    component_path: iteration.component_path,
    label: sprintLabel(iteration, seq),
    seq,
    issued_seq: sprints.nextIssuedSeq(),
    ...(head === undefined ? {} : { previous_sprint_id: head.sprint_id }),
    goal,
    accepted,
    ...(baselineRef === "" ? {} : { baseline_ref: baselineRef }),
    issued_at: input.now,
  };
  const members: SprintMember[] = roster.map((entry) => ({
    component_id: entry.component_id,
    state_revision: entry.expected_revision,
  }));
  return ok({
    response: response(command, "applied", { sprint }),
    sprint_effect: { kind: "issue", sprint, members },
    appends_activity: false,
  });
}

function response(
  command: Command,
  disposition: CommandResponse["disposition"],
  detail: {
    component_id?: ComponentId;
    state_revision?: Revision;
    created_ids?: readonly ComponentAddress[];
    removed_relations?: readonly RelationKey[];
    iteration?: IterationInfo;
    sprint?: SprintInfo;
    reason?: string;
  },
): CommandResponse {
  return {
    operation_id: command.operation_id,
    repository_id: command.repository_id,
    disposition,
    ...(detail.component_id === undefined ? {} : { component_id: detail.component_id }),
    ...(detail.state_revision === undefined ? {} : { state_revision: detail.state_revision }),
    created_ids: detail.created_ids ?? [],
    ...(detail.removed_relations === undefined || detail.removed_relations.length === 0
      ? {}
      : { removed_relations: detail.removed_relations }),
    ...(detail.iteration === undefined ? {} : { iteration: detail.iteration }),
    ...(detail.sprint === undefined ? {} : { sprint: detail.sprint }),
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
  };
}
