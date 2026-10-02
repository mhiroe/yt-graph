// planner / doit / done から typed command を呼ぶ薄い adapter (Slice E)。
//
// **v4 側に閉じている。** current v3 の skill、hook、`.agents/workflow.toml`、Markdown property、
// relay 経路へ 1 行も載せ替えない (`implementation.md`「v4 採用まで current v3 の skill、hook、
// Markdown property、relay 経路を candidate 実装へ載せ替えない」)。この file を呼ぶ側はまだ
// 居らず、Slice F で user が v4 採用を決めたときに繋ぐ。
//
// **command を実行しない。** 返すのは「どの typed command をどの順で出すか」と
// 「この phase で何を触ってよいか」だけ。実行は `runLocalCommand` / CLI が持つ。
// 純粋にしておく理由は 2 つ。
//
// 1. phase の guard (plan 中は docs だけ、start_doing 成功まで implementation を触らない) を
//    **prose ではなく data として** test で固定できる。
// 2. skill 側の実行機構 (agent runtime、hook、pane) から独立させられる。実行機構が変わっても
//    phase の意味は変わらない。

import { err, ok, type Result } from "../result.ts";
import type { ComponentId } from "../ids.ts";
import type { ComponentKind, Revision } from "../components.ts";
import type { OperationName } from "../commands.ts";

/**
 * shared skill の phase。`doit` / `done` / planner (`wish-chat` / `task-tuner`) に対応する。
 *
 * **`task-orchestrator` を phase にしない。** あれは routing であって workflow state を
 * 動かさない。動かさないものを phase にすると、routing しただけで state が進む経路ができる。
 */
export const SKILL_PHASES = ["planner", "doit", "done"] as const;
export type SkillPhase = (typeof SKILL_PHASES)[number];

/**
 * その phase で触ってよい範囲。
 *
 * - `docs_only`: docs と spec だけ。**code を変更しない** (`implementation.md`
 *   「plan 中は docs だけを変更し、code を変更しない」)。
 * - `implementation`: code を変更してよい。
 * - `none`: まだ何も触らない。**`doit` が `start_doing` に成功するまでがこれ。**
 */
export const MUTATION_SCOPES = ["none", "docs_only", "implementation"] as const;
export type MutationScope = (typeof MUTATION_SCOPES)[number];

/** 出す typed command 1 件。envelope の残り (operation_id、actor_ref 等) は呼び出し側が付ける。 */
export type PlannedCommand = {
  readonly operation: OperationName;
  readonly target_id?: ComponentId;
  readonly expected_revision?: Revision;
  readonly payload: Readonly<Record<string, unknown>>;
  /** この command が何のために出るか。log と activity の説明に使う。 */
  readonly why: string;
};

/**
 * phase 1 回分の計画。
 *
 * **`mutation_scope` は「今」で、`mutation_scope_after` は「commands が全部 `applied` になった後」。**
 * 2 つに分けるのが要点で、1 つにすると `doit` が `start_doing` の前に implementation を
 * 触れる形になる。
 */
export type SkillPlan = {
  readonly phase: SkillPhase;
  readonly commands: readonly PlannedCommand[];
  readonly mutation_scope: MutationScope;
  readonly mutation_scope_after: MutationScope;
  /**
   * `mutation_scope_after` へ上がる条件。**`applied` 固定。**
   * `noop` で上げると、既に doing な Task をもう一度 `start_doing` して
   * 「自分が取った」と誤認する経路ができる。
   */
  readonly scope_opens_on: "applied";
  /** この phase が**やらないこと**。呼び出し側が先回りしないための明示。 */
  readonly out_of_scope: readonly string[];
};

/** planner phase の入力。Wish が無ければ登録から始める。 */
export type PlannerInput = {
  readonly phase: "planner";
  /** 既にある Wish。無ければ登録する。 */
  readonly wish?: { readonly component_id: ComponentId; readonly state_revision: Revision };
  /** Wish を新規に作る場合の初期値。 */
  readonly register?: {
    readonly kind: ComponentKind;
    readonly title?: string;
    readonly locator?: string;
    /** 登録先 scope に default が無い / 非 default の iteration へ入れる時に明示する。 */
    readonly iteration_id?: string;
  };
  readonly correlation_id?: string;
};

/**
 * doit が Task の実行 session を記録するための任意入力。全 field 省略可 —
 * 呼び出し側が解決できるものだけを入れる (herdr pane 環境では pane /
 * agent_session、それ以外では取れるものだけ)。
 */
export type SessionAttachment = {
  readonly session_id?: string;
  readonly agent?: string;
  readonly pane?: string;
};

/** doit phase の入力。Task が無ければ Wish から planned Task を作る。 */
export type DoitInput = {
  readonly phase: "doit";
  readonly wish: { readonly component_id: ComponentId; readonly state_revision: Revision };
  /** 既にある Task。無ければ `task.create_planned` で作る。 */
  readonly task?: { readonly component_id: ComponentId; readonly state_revision: Revision };
  readonly task_title?: string;
  readonly task_locator?: string;
  /** 作成先 scope に default が無い / 非 default の iteration へ入れる時に明示する。 */
  readonly task_iteration_id?: string;
  /** 与えられれば `task.start_doing` の直後に `session.attach` activity を追記する。 */
  readonly session?: SessionAttachment;
  readonly correlation_id?: string;
};

/** done phase の入力。Task の完了だけを扱う。 */
export type DoneInput = {
  readonly phase: "done";
  readonly task: { readonly component_id: ComponentId; readonly state_revision: Revision };
  /** 実行した検証。`task.complete` の payload と activity に残る。 */
  readonly verification?: string;
  /** 与えられれば `task.complete` の直前に `session.attach` activity を追記する
      (doit 側で記録されなかったケースの fallback — retro の transcript 解決用)。 */
  readonly session?: SessionAttachment;
  readonly correlation_id?: string;
};

export type SkillPhaseInput = PlannerInput | DoitInput | DoneInput;

/**
 * planner。Wish が無ければ登録し、`plan` を開始する。
 *
 * **`wish.request_ready` を出さない。** `tuning` から `ready` へ落とす判断は plan の終わりで
 * 人が決めるもので、plan を開始する phase の仕事ではない。
 */
function planPlanner(input: PlannerInput): Result<SkillPlan> {
  const commands: PlannedCommand[] = [];
  const correlation = input.correlation_id;
  if (input.wish === undefined) {
    const register = input.register;
    if (register === undefined) {
      return err(
        "missing_field",
        "既存 Wish が無い場合は register の初期値が必要である",
        "register",
      );
    }
    commands.push({
      operation: "component.register",
      payload: {
        kind: register.kind,
        ...(register.title === undefined ? {} : { title: register.title }),
        ...(register.locator === undefined ? {} : { locator: register.locator }),
        ...(register.iteration_id === undefined ? {} : { iteration_id: register.iteration_id }),
        ...(correlation === undefined ? {} : { correlation_id: correlation }),
      },
      why: "Wish が無いので登録する",
    });
    // 登録直後の `plan_begin` は、register の response が返す component_id を要する。
    // **ここで採番しない。** 採番点は 1 つ (`my-wish-data.md` の `id`)。
    return ok({
      phase: "planner",
      commands,
      mutation_scope: "docs_only",
      mutation_scope_after: "docs_only",
      scope_opens_on: "applied",
      out_of_scope: [
        "register の response が返す component_id で wish.plan_begin を続けて出す",
        "code の変更 (plan 中は docs だけ)",
        "wish.request_ready (tuning から ready へ落とすのは人の判断)",
      ],
    });
  }
  commands.push({
    operation: "wish.plan_begin",
    target_id: input.wish.component_id,
    expected_revision: input.wish.state_revision,
    payload: correlation === undefined ? {} : { correlation_id: correlation },
    why: "壁打ちを開始する",
  });
  return ok({
    phase: "planner",
    commands,
    mutation_scope: "docs_only",
    mutation_scope_after: "docs_only",
    scope_opens_on: "applied",
    out_of_scope: [
      "code の変更 (plan 中は docs だけ)",
      "wish.request_ready (tuning から ready へ落とすのは人の判断)",
      "task.start_doing (実行は doit の phase)",
    ],
  });
}

/**
 * doit。Task を用意し、`start_doing` まで出す。
 *
 * **`mutation_scope` は `none` で始まる。** `start_doing` が `applied` になるまで
 * implementation を触らない (`implementation.md`「worker は `start_doing` 成功後に
 * implementation mutation へ入る」)。`noop` では開かない。
 */
function planDoit(input: DoitInput): Result<SkillPlan> {
  const commands: PlannedCommand[] = [];
  const correlation = input.correlation_id;
  if (input.task === undefined) {
    commands.push({
      operation: "task.create_planned",
      target_id: input.wish.component_id,
      expected_revision: input.wish.state_revision,
      payload: {
        ...(input.task_title === undefined ? {} : { title: input.task_title }),
        ...(input.task_locator === undefined ? {} : { locator: input.task_locator }),
        ...(input.task_iteration_id === undefined ? {} : { iteration_id: input.task_iteration_id }),
        ...(correlation === undefined ? {} : { correlation_id: correlation }),
      },
      why: "Wish から planned Task を作る (Task 作成と relation 追加は 1 transaction)",
    });
    // create の response が返す Task ID を使って続きを出す。**採番しない。**
    return ok({
      phase: "doit",
      commands,
      mutation_scope: "none",
      mutation_scope_after: "none",
      scope_opens_on: "applied",
      out_of_scope: [
        "create の response が返す Task ID で task.request_ready と task.start_doing を続けて出す",
        "implementation mutation (start_doing が applied になるまで触らない)",
      ],
    });
  }
  commands.push({
    operation: "task.request_ready",
    target_id: input.task.component_id,
    expected_revision: input.task.state_revision,
    payload: correlation === undefined ? {} : { correlation_id: correlation },
    why: "Task を実行待ちにする",
  });
  commands.push({
    operation: "task.start_doing",
    target_id: input.task.component_id,
    // request_ready が revision を 1 つ進めるので、次の expected はその先。
    expected_revision: (input.task.state_revision + 1) as Revision,
    payload: correlation === undefined ? {} : { correlation_id: correlation },
    why: "Worker が Task を取る。ここが applied になってから code を触る",
  });
  // session.attach: 実行 session と Task の対応を残す (retrospective が
  // transcript を辿る唯一の決定的な手がかり)。activity は state を進めないので
  // expected_revision は付けない — 並走する無関係な更新で落とさない。
  if (input.session !== undefined) {
    const detail: Record<string, string> = { via: "doit" };
    if (input.session.session_id !== undefined) detail.session_id = input.session.session_id;
    if (input.session.agent !== undefined) detail.agent = input.session.agent;
    if (input.session.pane !== undefined) detail.pane = input.session.pane;
    commands.push({
      operation: "activity.append",
      target_id: input.task.component_id,
      payload: {
        activity_type: "session.attach",
        detail,
      },
      why: "Task を実行した session を記録する (retrospective の transcript 解決用)",
    });
  }
  return ok({
    phase: "doit",
    commands,
    mutation_scope: "none",
    // **最後の start_doing が applied になってから開く。**
    mutation_scope_after: "implementation",
    scope_opens_on: "applied",
    out_of_scope: [
      "task.complete (完了は done の phase)",
      "Wish の satisfaction 判定 (Task 完了と Wish 達成は別)",
    ],
  });
}

/**
 * done。Task を完了させる。
 *
 * **Wish を閉じない。** `complete_satisfied` は minimum command union に無く
 * (`interfaces.md`「satisfaction 仕様が決まるまで minimum command へ入れない」)、
 * satisfaction は初期 scope 外である。加えて憲法が「agent の判断で要求そのものを閉じない」と
 * している。配下 Task が全部 done でも Wish を done にしない。
 */
function planDone(input: DoneInput): Result<SkillPlan> {
  const correlation = input.correlation_id;
  const commands: PlannedCommand[] = [];
  // session.attach fallback: doit の plan が start_doing 不適用で止まると
  // attach が出ない (anchor 未整備で raw start_doing を再送する運用がある)。
  // done で session が渡ればここで記録する — retro が transcript を辿る
  // 最後の機会である。doit で記録済みでも重複は無害 (retro は最古の attach
  // = 実行者を読む)。activity.append は state_revision を消費せず常に
  // applied なので、後続の task.complete の expected_revision を狂わせない。
  if (input.session !== undefined) {
    const detail: Record<string, string> = { via: "done" };
    if (input.session.session_id !== undefined) detail.session_id = input.session.session_id;
    if (input.session.agent !== undefined) detail.agent = input.session.agent;
    if (input.session.pane !== undefined) detail.pane = input.session.pane;
    commands.push({
      operation: "activity.append",
      target_id: input.task.component_id,
      payload: {
        activity_type: "session.attach",
        detail,
      },
      why: "実行 session の記録 (doit で記録されなかった場合の retro 用 fallback)",
    });
  }
  commands.push({
    operation: "task.complete",
    target_id: input.task.component_id,
    expected_revision: input.task.state_revision,
    payload: {
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      ...(correlation === undefined ? {} : { correlation_id: correlation }),
    },
    why: "Task を完了し、検証内容を activity に残す",
  });
  return ok({
    phase: "done",
    commands,
    // 締め処理 (work_log 追記、task node の state) は docs 側の変更である。
    mutation_scope: "docs_only",
    mutation_scope_after: "docs_only",
    scope_opens_on: "applied",
    out_of_scope: [
      "Wish の done / satisfaction (agent の判断で要求を閉じない)",
      "code の変更 (実装は doit の phase で終わっている)",
    ],
  });
}

/**
 * phase 1 回分の計画を返す。
 *
 * **どの phase も 1 回の呼び出しで全部を返さない。** component を作る command は
 * response が返す ID を次の command が要するので、そこで切れる。切れ目を
 * `out_of_scope` に書いて、呼び出し側が ID を推測で埋めないようにしてある。
 */
export function planSkillPhase(input: SkillPhaseInput): Result<SkillPlan> {
  switch (input.phase) {
    case "planner":
      return planPlanner(input);
    case "doit":
      return planDoit(input);
    case "done":
      return planDone(input);
  }
}

/**
 * その scope で code を触ってよいか。
 *
 * **`docs_only` を「だいたい書ける」へ倒さない。** plan 中の code 変更を許すと、
 * 壁打ちが実装を始める経路ができる。
 */
export function allowsCodeMutation(scope: MutationScope): boolean {
  return scope === "implementation";
}

/** その scope で docs を触ってよいか。 */
export function allowsDocsMutation(scope: MutationScope): boolean {
  return scope === "docs_only" || scope === "implementation";
}
