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
// 1. **Halt on the first non-`applied` disposition (noop included).** Later
//    commands carry `expected_revision` values computed under the assumption
//    that every prior command applied; submitting them after a noop/conflict
//    would write on a stale base. `scope_opens_on` is `"applied"` fixed, so a
//    noop never opens the mutation scope either.
// 2. **Never guess component IDs.** Plans that cut at an ID boundary return
//    the new IDs in the applied response; exactly one continuation hop
//    re-plans with them. If the response lacks the ID the run reports
//    `continuation_blocked` instead — the issuance point is single.

import { type ComponentId, parseComponentId, parseOperationId } from "../ids.ts";
import type { Revision } from "../components.ts";
import type { OperationName } from "../commands.ts";
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
};

/**
 * What one `runSkillPhase` / `runWishCompletion` call did. **All failures are
 * data** — the runner never throws, so callers can branch on `completed` /
 * `halted_at` / `error` instead of catching.
 */
export type PhaseRunResult = {
  readonly phase: SkillPhase | "wish_complete";
  readonly ok: boolean;
  /** The final plan's commands ALL applied and no continuation is pending. */
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
  phase: SkillPhase | "wish_complete",
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
 * rest: their `expected_revision` assumed applied predecessors. When every
 * command applied and the input was incomplete (no `wish` for planner, no
 * `task` for doit), exactly one continuation hop re-plans with the IDs the
 * applied response returned — never guessed.
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
    for (const command of plan.commands) {
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
        haltedAt = commands.length - 1;
        transportError = submitFailure(cli);
        break;
      }
      if (view.disposition !== "applied") {
        haltedAt = commands.length - 1;
        break;
      }
    }
    lastPlan = {
      scope: plan.mutation_scope,
      after: plan.mutation_scope_after,
      fullyApplied: haltedAt === undefined,
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
