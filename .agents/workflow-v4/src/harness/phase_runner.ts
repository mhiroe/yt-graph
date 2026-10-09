// Runtime half of the skill adapter: executes a `SkillPlan` through an injected
// submit port and reports what actually happened (cutover-readiness work).
//
// **Nothing in v3 calls this yet.** The adapter decides *which* commands a phase
// emits and *what may be touched*; this runner submits them in order, honours
// the halt rule, and performs the single ID-boundary continuation the adapter
// cuts at. The executable entry that backs the port with the real CLI
// subprocess lives in `skill_entry.ts`.
//
// **No runtime APIs.** Like `skill_adapter.ts` this file stays pure — no
// `Deno.*`, no `node:*`, no process/env/fs access — so it remains importable
// from `mod.ts` and testable in-process.
//
// Two rules carry the constitution into runtime behaviour:
//
// 1. **Halt on the first non-`applied` disposition — except a `noop` on the
//    plan's LAST command.** Later commands carry `expected_revision` values
//    computed under the assumption that every prior command applied;
//    submitting them after a noop/conflict would write on a stale base. A
//    noop on the final command has no successor to protect: the target state
//    the command aimed at already holds (e.g. `wish.plan_begin` on a Wish
//    already in `plan` — a planner resume), so the run reports `completed`.
//    `scope_opens_on` is `"applied"` fixed, so a noop never opens the
//    mutation scope either way.
// 2. **Never guess component IDs.** Plans that cut at an ID boundary return
//    the new IDs in the applied response; exactly one continuation hop
//    re-plans with them. If the response lacks the ID the run reports
//    `continuation_blocked` instead — the issuance point is single.

import { type ComponentId, parseComponentId, parseOperationId } from "../ids.ts";
import type { Revision } from "../components.ts";
import { OPERATION_TRANSITIONS, type OperationName } from "../commands.ts";
import type { SprintRosterEntry } from "../sprints.ts";
import { formatProtocolVersion, WORKFLOW_PROTOCOL_VERSION } from "../protocol.ts";
import {
  type MutationScope,
  type PlannedCommand,
  planSkillPhase,
  type SkillPhase,
  type SkillPhaseInput,
} from "./skill_adapter.ts";

/**
 * Minimal view of one CLI call result, shaped like f1's `CliResult`.
 * `result` is the `CommandResponse` payload for `workflow.submit`.
 */
export type CliResult = {
  readonly exit_code: number;
  readonly ok: boolean;
  readonly result: unknown;
  readonly error?: { code?: string; message?: string; path?: string };
};

/**
 * Submit port. The executable entry backs this with the real CLI subprocess;
 * tests inject an in-memory store. Kept synchronous so the runner stays a
 * straight-line data transformation.
 */
export type CliSubmit = (request: unknown) => CliResult;

export type RunContext = {
  readonly repository_id: string;
  readonly device_id: string;
  /**
   * The runner derives `${prefix}-${seq}` operation IDs. `seq` is 1-based and
   * counts across the continuation hop so IDs never repeat within one run.
   */
  readonly operation_prefix: string;
  /** Default `agent:<phase>` for phases, `user` for wish completion. */
  readonly actor_ref?: string;
};

/** One submitted command and what the CLI answered. */
export type ExecutedCommand = {
  readonly operation_id: string;
  readonly operation: OperationName;
  readonly target_id?: string;
  readonly expected_revision?: number;
  readonly why: string;
  /** Response disposition, or `"(unavailable)"` when no response could be read. */
  readonly disposition: string;
  readonly component_id?: string;
  readonly state_revision?: number;
  readonly created_ids?: readonly { repository_id: string; component_id: string }[];
  readonly reason?: string;
  readonly exit_code: number;
  /**
   * その submit が返した result payload そのまま。record の field が拾わない
   * 値を運ぶ口 — `sprint.issue` の dry_run preview / 採番された sprint が入る。
   */
  readonly result?: unknown;
};

/**
 * What one `runSkillPhase` / `runWishCompletion` call did. **All failures are
 * data** — the runner never throws, so callers can branch on `completed` /
 * `halted_at` / `error` instead of catching.
 */
/** `runSkillPhase` の phase 名と、phase でない entry (`wish.complete` / `wish.transition` / `sprint.issue`) の識別子。 */
export type RunnerPhase = SkillPhase | "wish_complete" | "wish_transition" | "sprint_issue";

export type PhaseRunResult = {
  readonly phase: RunnerPhase;
  readonly ok: boolean;
  /**
   * The final plan ran to its end (a `noop` on the last command counts as
   * satisfied — the state it aimed at already holds) and no continuation is
   * pending.
   */
  readonly completed: boolean;
  /** An ID-boundary continuation hop happened. */
  readonly continued: boolean;
  /**
   * Effective scope NOW: the last executed plan's `mutation_scope_after` if it
   * fully applied, else its `mutation_scope`. `"none"` when no plan executed.
   */
  readonly mutation_scope: MutationScope;
  /** Effective scope equals the last executed plan's `mutation_scope_after`. */
  readonly scope_opened: boolean;
  readonly commands: readonly ExecutedCommand[];
  /** Index into `commands` of the first non-applied response. */
  readonly halted_at?: number;
  /** From the LAST executed plan. */
  readonly out_of_scope: readonly string[];
  readonly error?: { code: string; message: string };
};

/** Response fields the runner consumes, read defensively off the wire. */
type ResponseView = {
  readonly disposition: string;
  readonly component_id?: string;
  readonly state_revision?: number;
  readonly created_ids?: readonly { repository_id: string; component_id: string }[];
  readonly reason?: string;
};

function responseViewOf(result: unknown): ResponseView | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const raw = result as Record<string, unknown>;
  if (typeof raw["disposition"] !== "string") return undefined;
  const createdRaw = raw["created_ids"];
  const createdIds = (Array.isArray(createdRaw) ? createdRaw : [])
    .filter((item): item is { repository_id: string; component_id: string } =>
      typeof item === "object" && item !== null &&
      typeof (item as Record<string, unknown>)["repository_id"] === "string" &&
      typeof (item as Record<string, unknown>)["component_id"] === "string"
    );
  return {
    disposition: raw["disposition"],
    ...(typeof raw["component_id"] === "string" ? { component_id: raw["component_id"] } : {}),
    ...(typeof raw["state_revision"] === "number" ? { state_revision: raw["state_revision"] } : {}),
    created_ids: createdIds,
    ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
  };
}

function executedRecord(
  operationId: string,
  command: PlannedCommand,
  exitCode: number,
  view: ResponseView | undefined,
): ExecutedCommand {
  return {
    operation_id: operationId,
    operation: command.operation,
    ...(command.target_id === undefined ? {} : { target_id: command.target_id }),
    ...(command.expected_revision === undefined
      ? {}
      : { expected_revision: command.expected_revision }),
    why: command.why,
    disposition: view?.disposition ?? "(unavailable)",
    ...(view?.component_id === undefined ? {} : { component_id: view.component_id }),
    ...(view?.state_revision === undefined ? {} : { state_revision: view.state_revision }),
    ...(view === undefined || view.created_ids === undefined || view.created_ids.length === 0
      ? {}
      : { created_ids: view.created_ids }),
    ...(view?.reason === undefined ? {} : { reason: view.reason }),
    exit_code: exitCode,
  };
}

/**
 * Error codes the submit port itself fabricates when no CLI answer exists at
 * all (`cli_spawn_failed` / `cli_unparseable_stdout` in `skill_entry.ts`).
 * Any other code on an `ok:false` result is the CLI's own structured answer
 * (e.g. `operation_id_reused` from `runLocalCommand`) — a domain response the
 * caller must see, not a transport failure.
 */
const TRANSPORT_FAILURE_CODES = ["cli_spawn_failed", "cli_unparseable_stdout"];

/**
 * Map a failed / unreadable `workflow.submit` result to the run error. A
 * structured `ok:false` keeps the CLI's semantic code (flattening it to
 * `cli_unavailable` loses `operation_id_reused`); only a missing response or
 * a port-fabricated transport code reports unavailable.
 */
function submitFailure(cli: CliResult): { code: string; message: string } {
  const code = cli.error?.code;
  if (code !== undefined && !TRANSPORT_FAILURE_CODES.includes(code)) {
    return {
      code,
      message: cli.error?.message ?? `workflow.submit が ${code} で失敗した`,
    };
  }
  return {
    code: "cli_unavailable",
    message: cli.error?.message ??
      "workflow.submit の response から disposition を読めなかった",
  };
}

/** `workflow.submit` request carrying the full Command envelope. */
function submitRequest(
  command: PlannedCommand,
  ctx: RunContext,
  actorRef: string,
  operationId: string,
): unknown {
  return {
    kind: "workflow.submit",
    command: {
      protocol_version: formatProtocolVersion(WORKFLOW_PROTOCOL_VERSION),
      repository_id: ctx.repository_id,
      operation_id: operationId,
      operation: command.operation,
      ...(command.target_id === undefined ? {} : { target_id: command.target_id }),
      ...(command.expected_revision === undefined
        ? {}
        : { expected_revision: command.expected_revision }),
      actor_ref: actorRef,
      source_device_id: ctx.device_id,
      payload: command.payload,
    },
  };
}

/** Scope / out_of_scope bookkeeping for the last plan that actually ran. */
type ExecutedPlan = {
  readonly scope: MutationScope;
  readonly after: MutationScope;
  readonly fullyApplied: boolean;
  readonly outOfScope: readonly string[];
};

function finish(
  phase: RunnerPhase,
  commands: readonly ExecutedCommand[],
  continued: boolean,
  lastPlan: ExecutedPlan | undefined,
  haltedAt: number | undefined,
  error: { code: string; message: string } | undefined,
): PhaseRunResult {
  const effectiveScope: MutationScope = lastPlan === undefined
    ? "none"
    : lastPlan.fullyApplied
    ? lastPlan.after
    : lastPlan.scope;
  const completed = haltedAt === undefined && error === undefined;
  return {
    phase,
    ok: completed,
    completed,
    continued,
    mutation_scope: effectiveScope,
    scope_opened: lastPlan !== undefined && effectiveScope === lastPlan.after,
    commands,
    ...(haltedAt === undefined ? {} : { halted_at: haltedAt }),
    out_of_scope: lastPlan?.outOfScope ?? [],
    ...(error === undefined ? {} : { error }),
  };
}

type Continuation =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "hop"; readonly input: SkillPhaseInput };

/**
 * The ID-boundary continuation. `boundary` is the record of the plan's last
 * command — the adapter makes the boundary command (`component.register` /
 * `task.create_planned`) the only command before the cut, so the last executed
 * record is the response the continuation needs.
 */
function continuationInput(
  input: SkillPhaseInput,
  boundary: ExecutedCommand | undefined,
): Continuation {
  if (input.phase === "planner" && input.wish === undefined) {
    const componentId = boundary?.component_id;
    const stateRevision = boundary?.state_revision;
    if (componentId === undefined || stateRevision === undefined) {
      return {
        kind: "blocked",
        message: "component.register の response が component_id / state_revision を返さなかった",
      };
    }
    const parsedId = parseComponentId(componentId, "component_id");
    if (!parsedId.ok) {
      return {
        kind: "blocked",
        message:
          `component.register が返した component_id を parse できない: ${parsedId.error.message}`,
      };
    }
    return {
      kind: "hop",
      input: {
        phase: "planner",
        wish: { component_id: parsedId.value, state_revision: stateRevision },
        ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      },
    };
  }
  if (input.phase === "doit" && input.task === undefined) {
    const taskId = boundary?.created_ids?.[0]?.component_id;
    const stateRevision = boundary?.state_revision;
    if (taskId === undefined || stateRevision === undefined) {
      return {
        kind: "blocked",
        message:
          "task.create_planned の response が作成した Task ID / state_revision を返さなかった",
      };
    }
    const parsedId = parseComponentId(taskId, "component_id");
    if (!parsedId.ok) {
      return {
        kind: "blocked",
        message:
          `task.create_planned が返した Task ID を parse できない: ${parsedId.error.message}`,
      };
    }
    return {
      kind: "hop",
      input: {
        phase: "doit",
        // create consumed the wish revision; the response carries the next one.
        wish: {
          component_id: input.wish.component_id,
          state_revision: stateRevision,
        },
        task: { component_id: parsedId.value, state_revision: 0 },
        // session.attach は start_doing の hop 側で出るので hop へ引き継ぐ。
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      },
    };
  }
  // `done` never continues; a completed input has no ID boundary left.
  return { kind: "none" };
}

/**
 * Plan the phase and submit its commands in order through `submit`.
 *
 * **Halts on the first non-`applied` disposition** and does not submit the
 * rest: their `expected_revision` assumed applied predecessors. One
 * exception: a `noop` on the plan's LAST command means the target state
 * already holds (planner resume on a `plan` Wish), so the run completes
 * instead — with `scope` unopened, since `scope_opens_on` is `applied`.
 * When every command applied and the input was incomplete (no `wish` for
 * planner, no `task` for doit), exactly one continuation hop re-plans with
 * the IDs the applied response returned — never guessed.
 */
export function runSkillPhase(
  submit: CliSubmit,
  input: SkillPhaseInput,
  ctx: RunContext,
): PhaseRunResult {
  const actorRef = ctx.actor_ref ?? `agent:${input.phase}`;
  const commands: ExecutedCommand[] = [];
  let seq = 0;
  let continued = false;
  let currentInput = input;
  let lastPlan: ExecutedPlan | undefined;
  // The hopped input always has the component set, so `continuationInput`
  // returns "none" after it — but the bound makes "at most one hop" explicit.
  for (let hop = 0; hop < 2; hop += 1) {
    const planned = planSkillPhase(currentInput);
    if (!planned.ok) {
      return finish(input.phase, commands, continued, lastPlan, undefined, {
        code: planned.error.code,
        message: planned.error.message,
      });
    }
    const plan = planned.value;
    let haltedAt: number | undefined;
    let transportError: { code: string; message: string } | undefined;
    let allApplied = true;
    for (const [index, command] of plan.commands.entries()) {
      seq += 1;
      const operationId = `${ctx.operation_prefix}-${seq}`;
      const parsedId = parseOperationId(operationId, "operation_prefix");
      if (!parsedId.ok) {
        return finish(input.phase, commands, continued, lastPlan, undefined, {
          code: parsedId.error.code,
          message: parsedId.error.message,
        });
      }
      const cli = submit(submitRequest(command, ctx, actorRef, operationId));
      const view = responseViewOf(cli.result);
      commands.push(executedRecord(operationId, command, cli.exit_code, view));
      if (!cli.ok || view === undefined) {
        // No readable disposition. A structured `ok:false` still carries the
        // CLI's semantic answer; preserve it instead of flattening.
        allApplied = false;
        haltedAt = commands.length - 1;
        transportError = submitFailure(cli);
        break;
      }
      if (view.disposition !== "applied") {
        allApplied = false;
        // **最後の command の noop は halt しない。** 目指す state は既に
        // 満たされていて (plan の Wish への plan_begin 再入)、後続 command の
        // stale base を心配する必要が無い。scope は fullyApplied が false の
        // ままなので noop では開かない。
        if (view.disposition === "noop" && index === plan.commands.length - 1) {
          break;
        }
        haltedAt = commands.length - 1;
        break;
      }
    }
    lastPlan = {
      scope: plan.mutation_scope,
      after: plan.mutation_scope_after,
      fullyApplied: allApplied,
      outOfScope: plan.out_of_scope,
    };
    if (haltedAt !== undefined) {
      return finish(input.phase, commands, continued, lastPlan, haltedAt, transportError);
    }
    const next = continuationInput(currentInput, commands[commands.length - 1]);
    if (next.kind === "blocked") {
      return finish(input.phase, commands, continued, lastPlan, undefined, {
        code: "continuation_blocked",
        message: next.message,
      });
    }
    if (next.kind === "none") break;
    continued = true;
    currentInput = next.input;
  }
  return finish(input.phase, commands, continued, lastPlan, undefined, undefined);
}

export type WishCompletionInput = {
  readonly wish: { readonly component_id: ComponentId; readonly state_revision: Revision };
  /** The user's reason. Empty means "no instruction", not "no reason given". */
  readonly reason: string;
};

/**
 * Explicit user instruction that closes a Wish. **Not a SkillPhase** — `done`
 * never closes a Wish on its own judgment (憲法: 閉じることと終わることを
 * 同じにしない), so this entry exists only for an explicit instruction. A
 * missing or empty `reason` is a `missing_field` error with zero submits; the
 * default actor is `user`, not `agent:<phase>`.
 */
export function runWishCompletion(
  submit: CliSubmit,
  input: WishCompletionInput,
  ctx: RunContext,
): PhaseRunResult {
  const phase = "wish_complete" as const;
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    return finish(phase, [], false, undefined, undefined, {
      code: "missing_field",
      message: "wish.complete には空でない reason が必要である (人の理由無しに Wish を閉じない)",
    });
  }
  const operationId = `${ctx.operation_prefix}-1`;
  const parsedId = parseOperationId(operationId, "operation_prefix");
  if (!parsedId.ok) {
    return finish(phase, [], false, undefined, undefined, {
      code: parsedId.error.code,
      message: parsedId.error.message,
    });
  }
  const command: PlannedCommand = {
    operation: "wish.complete",
    target_id: input.wish.component_id,
    expected_revision: input.wish.state_revision,
    payload: { reason: input.reason },
    why: "人の指示で Wish を閉じる (done の phase は Wish を閉じない)",
  };
  const cli = submit(submitRequest(command, ctx, ctx.actor_ref ?? "user", operationId));
  const view = responseViewOf(cli.result);
  const record = executedRecord(operationId, command, cli.exit_code, view);
  const applied = cli.ok && view !== undefined && view.disposition === "applied";
  const transportError = !cli.ok || view === undefined ? submitFailure(cli) : undefined;
  return finish(phase, [record], false, undefined, applied ? undefined : 0, transportError);
}

/**
 * `wish.transition` が出せる Wish 単独 transition operation。
 *
 * `OPERATION_NAMES` に在るがどの phase も emit しなかった口 — `plan` のままの
 * Wish がどの terminal へも辿れなかった defect の fix (intake
 * `20260928T202306`)。`wish.complete` は既存の `wish.complete` kind が持つので
 * ここへは入れない。`wish.plan_begin` は planner の開始 operation で、人の
 * 指示で状態を動かす口ではない。
 */
export const WISH_TRANSITION_OPERATIONS = [
  "wish.request_ready",
  "wish.set_pending",
  "wish.start_doing",
  "wish.drop",
] as const;
export type WishTransitionOperation = (typeof WISH_TRANSITION_OPERATIONS)[number];

export type WishTransitionInput = {
  readonly wish: { readonly component_id: ComponentId; readonly state_revision: Revision };
  readonly operation: WishTransitionOperation;
  /** The user's reason. Empty means "no instruction", not "no reason given". */
  readonly reason: string;
};

/**
 * Explicit user instruction that moves a Wish one transition (e.g.
 * `plan -> pending` で止める、`plan -> dropped` で畳む、terminal へ向かう
 * `ready` / `doing` への hop)。**Not a SkillPhase** — `wish.complete` と同じく
 * 人の指示だけが動かす口で、non-empty `reason` が無ければ submit しない
 * (gm 裁定 2026-09-28: user instruction + verbatim reason gate)。
 *
 * `OPERATION_SPECS` に `reason` field が無い operation
 * (`wish.request_ready` / `wish.start_doing`) では、指示理由を
 * `activity.append` (`user.instruction`) として Wish の履歴へ追記する —
 * ledger に人の理由が残らない遷移を作らない。
 */
export function runWishTransition(
  submit: CliSubmit,
  input: WishTransitionInput,
  ctx: RunContext,
): PhaseRunResult {
  const phase = "wish_transition" as const;
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    return finish(phase, [], false, undefined, undefined, {
      code: "missing_field",
      message:
        "wish.transition には空でない reason が必要である (人の理由無しに Wish を動かさない)",
    });
  }
  if (!WISH_TRANSITION_OPERATIONS.includes(input.operation)) {
    return finish(phase, [], false, undefined, undefined, {
      code: "unknown_operation",
      message: `wish.transition が出せるのは ${WISH_TRANSITION_OPERATIONS.join(" / ")} のみ: ${
        String(input.operation)
      }`,
    });
  }
  // `reason` を payload に持てるのは `wish.set_pending` / `wish.drop` だけ
  // (`OPERATION_SPECS`)。残り 2 つは trailing activity で理由を残す。
  const carriesReason = input.operation === "wish.set_pending" ||
    input.operation === "wish.drop";
  const to = OPERATION_TRANSITIONS[input.operation]?.to;
  const planned: PlannedCommand[] = [{
    operation: input.operation,
    target_id: input.wish.component_id,
    expected_revision: input.wish.state_revision,
    payload: carriesReason ? { reason: input.reason } : {},
    why: `人の指示で Wish を ${to ?? "?"} へ進める`,
  }];
  if (!carriesReason) {
    planned.push({
      operation: "activity.append",
      target_id: input.wish.component_id,
      payload: {
        activity_type: "user.instruction",
        detail: { operation: input.operation, reason: input.reason },
      },
      why: "transition operation に reason 欄が無いので、人の指示理由を履歴へ残す",
    });
  }

  const actorRef = ctx.actor_ref ?? "user";
  const commands: ExecutedCommand[] = [];
  for (const [index, command] of planned.entries()) {
    const operationId = `${ctx.operation_prefix}-${index + 1}`;
    const parsedId = parseOperationId(operationId, "operation_prefix");
    if (!parsedId.ok) {
      return finish(phase, commands, false, undefined, undefined, {
        code: parsedId.error.code,
        message: parsedId.error.message,
      });
    }
    const cli = submit(submitRequest(command, ctx, actorRef, operationId));
    const view = responseViewOf(cli.result);
    commands.push(executedRecord(operationId, command, cli.exit_code, view));
    if (!cli.ok || view === undefined) {
      return finish(
        phase,
        commands,
        false,
        undefined,
        commands.length - 1,
        submitFailure(cli),
      );
    }
    if (view.disposition !== "applied") {
      // 先頭 (transition) が noop なら目指す状態は既に満たされている —
      // 完了として返し、理由記録の activity は出さない (再送の idempotent 経路)。
      if (view.disposition === "noop" && index === 0) break;
      return finish(phase, commands, false, undefined, commands.length - 1, undefined);
    }
  }
  return finish(phase, commands, false, undefined, undefined, undefined);
}

export type SprintIssueInput = {
  readonly iteration_id: string;
  readonly goal: string;
  /**
   * sprint を出す人の受理 verbatim (docs/candidate/workflow-v4/sprints.md)。
   * 空は「指示無し」であって「理由無し」ではない — gate は wish.complete の
   * `reason` と同じ形。
   */
  readonly accepted: string;
  readonly baseline_ref?: string;
  /**
   * 発行時に見た head の sprint_id。**省略は「head 無しを期待」** —
   * 既に head が立っていれば conflict (並行 issue の片方だけが通る)。
   */
  readonly expected_head?: string;
  readonly roster: readonly SprintRosterEntry[];
  /** true なら採番 preview だけを返して DB / file / ledger に何も書かない。 */
  readonly dry_run?: boolean;
};

/**
 * `sprint.issue` の sanctioned agent seam — agent が sprint を発行する唯一の口。
 * **Not a SkillPhase** — 人の受理 verbatim (`accepted`) が無ければ submit しない
 * (wish.complete の `reason` gate と同じ形)。raw `workflow.submit` は agent の
 * sanctioned seam ではないので、この entry が typed command を 1 件組み立てて
 * submit する。
 *
 * submit した command の result は `commands[0].result` にそのまま残る —
 * `sprint` (採番された SprintInfo) と `dry_run` preview (`projection` block) を
 * caller が拾う経路。
 */
export function runSprintIssue(
  submit: CliSubmit,
  input: SprintIssueInput,
  ctx: RunContext,
): PhaseRunResult {
  const phase = "sprint_issue" as const;
  if (typeof input.accepted !== "string" || input.accepted.length === 0) {
    return finish(phase, [], false, undefined, undefined, {
      code: "missing_field",
      message: "sprint.issue には空でない accepted が必要である (人の受理無しに Sprint を出さない)",
    });
  }
  const operationId = `${ctx.operation_prefix}-1`;
  const parsedId = parseOperationId(operationId, "operation_prefix");
  if (!parsedId.ok) {
    return finish(phase, [], false, undefined, undefined, {
      code: parsedId.error.code,
      message: parsedId.error.message,
    });
  }
  const command: PlannedCommand = {
    operation: "sprint.issue",
    payload: {
      iteration_id: input.iteration_id,
      goal: input.goal,
      accepted: input.accepted,
      ...(input.baseline_ref === undefined ? {} : { baseline_ref: input.baseline_ref }),
      ...(input.expected_head === undefined ? {} : { expected_head: input.expected_head }),
      roster: input.roster.map((entry) => ({
        component_id: entry.component_id,
        expected_revision: entry.expected_revision,
      })),
      ...(input.dry_run === true ? { dry_run: true } : {}),
    },
    why: "人の受理で Sprint を発行する",
  };
  const cli = submit(submitRequest(command, ctx, ctx.actor_ref ?? "user", operationId));
  const view = responseViewOf(cli.result);
  const record = {
    ...executedRecord(operationId, command, cli.exit_code, view),
    result: cli.result,
  };
  const applied = cli.ok && view !== undefined && view.disposition === "applied";
  const transportError = !cli.ok || view === undefined ? submitFailure(cli) : undefined;
  return finish(phase, [record], false, undefined, applied ? undefined : 0, transportError);
}
