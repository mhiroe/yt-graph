// Executable entry for the phase runner — the runtime twin of `cli/main.ts`.
//
// **Thin like `cli/main.ts`:** argument parsing, request validation, exactly
// one JSON line on stdout on every exit path, diagnostics on stderr only, and
// the same four exit codes. `writeFileSync(1, ...)` + `process.exitCode` is
// used for the same reason as `cli/main.ts`: `process.stdout.write()` is
// async on pipes and can truncate under `process.exit()`.
//
// **Entry-local request kinds.** `skill.phase` / `wish.complete` /
// `wish.transition` are NOT added to `dispatch.ts`: they are harness-level
// requests that fan out into multiple `workflow.submit` calls through the
// real CLI subprocess, not single store commands. Nothing in v3 calls this
// entry yet.
//
// 使い方:
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-run \
//     src/harness/skill_entry.ts \
//     --repository-id dotfiles --device-id dev-macbook \
//     --db .workflow/dotfiles.sqlite --root . \
//     --request '{"kind":"skill.phase","phase":"doit","wish":{...},"operation_prefix":"op-x"}'

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { type ComponentId, parseComponentId, parseRepositoryId } from "../ids.ts";
import {
  type ComponentKind,
  parseComponentKind,
  parseRevision,
  type Revision,
} from "../components.ts";
import { err, ok, type Result, type WorkflowErrorCode } from "../result.ts";
import {
  CLI_EXIT_BAD_REQUEST,
  CLI_EXIT_NOT_APPLIED,
  CLI_EXIT_OK,
  CLI_EXIT_UNAVAILABLE,
  type CliExitCode,
  type CliResponse,
} from "../cli/dispatch.ts";
import { type SessionAttachment, SKILL_PHASES, type SkillPhaseInput } from "./skill_adapter.ts";
import {
  type CliResult,
  type CliSubmit,
  type PhaseRunResult,
  type RunContext,
  runSkillPhase,
  runWishCompletion,
  runWishTransition,
  WISH_TRANSITION_OPERATIONS,
  type WishCompletionInput,
  type WishTransitionInput,
} from "./phase_runner.ts";

const CLI_ENTRY = new URL("../cli/main.ts", import.meta.url).href;

const ENTRY_REQUEST_KINDS = ["skill.phase", "wish.complete", "wish.transition"] as const;

type Options = {
  readonly repository_id: string;
  readonly device_id: string;
  readonly db: string;
  readonly root: string;
  readonly request?: string;
};

const USAGE = [
  "usage: skill-entry --repository-id <id> --device-id <id> --db <path> [--root <dir>]",
  "                   [--request <json>]",
  "",
  "request kinds: skill.phase (phase + flattened phase input + operation_prefix)",
  "               wish.complete (wish + reason + operation_prefix)",
  "               wish.transition (wish + operation + reason + operation_prefix)",
  "request を省くと stdin から JSON を 1 件読む。stdout は JSON 1 行、診断は stderr。",
  "exit code: 0=phase 完走 / wish.complete applied 1=CLI 到達不能 2=request 不正 3=非 applied で halt",
].join("\n");

type ArgvResult =
  | { readonly ok: true; readonly value: Options }
  | { readonly ok: false; readonly message: string };

function parseArgs(argv: readonly string[]): ArgvResult {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) {
      return { ok: false, message: `option は --name value の形である必要がある: ${String(arg)}` };
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, message: `${arg} に値が無い` };
    }
    values.set(arg.slice(2), next);
    i += 1;
  }
  const missing = ["repository-id", "device-id", "db"].filter((name) => !values.has(name));
  if (missing.length > 0) {
    return { ok: false, message: `必須 option が足りない: ${missing.join(", ")}` };
  }
  const request = values.get("request");
  return {
    ok: true,
    value: {
      repository_id: values.get("repository-id") ?? "",
      device_id: values.get("device-id") ?? "",
      db: values.get("db") ?? "",
      root: values.get("root") ?? process.cwd(),
      ...(request === undefined ? {} : { request }),
    },
  };
}

/** stdout へ JSON 1 行を書き、exit code を設定する (`cli/main.ts` と同じ経路)。 */
function emit(response: CliResponse): void {
  writeFileSync(1, `${JSON.stringify(response)}\n`);
  process.exitCode = response.exit_code;
}

/** 診断は stderr だけに出す。stdout には 1 byte も混ぜない。 */
function diagnostic(text: string): void {
  writeFileSync(2, text.endsWith("\n") ? text : `${text}\n`);
}

function failure(
  kind: string,
  code: WorkflowErrorCode,
  message: string,
  exit: CliExitCode,
  path?: string,
): CliResponse {
  diagnostic(`error: ${code}: ${message}`);
  return {
    kind,
    ok: false,
    exit_code: exit,
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

/**
 * One `workflow.submit` through the real CLI subprocess — the f1 `runCli`
 * pattern. **Never throws**: spawn and parse failures come back as
 * `ok:false` results so the runner can halt on them as data.
 */
function cliSubmitOf(options: Options): CliSubmit {
  return (request: unknown): CliResult => {
    let output;
    try {
      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--allow-read",
          "--allow-write",
          "--allow-ffi",
          "--allow-env",
          CLI_ENTRY,
          "--repository-id",
          options.repository_id,
          "--device-id",
          options.device_id,
          "--db",
          options.db,
          "--root",
          options.root,
          "--request",
          JSON.stringify(request),
        ],
        stdout: "piped",
        stderr: "piped",
      });
      output = command.outputSync();
    } catch (cause) {
      return {
        exit_code: 1,
        ok: false,
        result: undefined,
        error: { code: "cli_spawn_failed", message: String(cause) },
      };
    }
    const stdout = new TextDecoder().decode(output.stdout);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch (cause) {
      return {
        exit_code: output.code,
        ok: false,
        result: undefined,
        error: {
          code: "cli_unparseable_stdout",
          message: `CLI stdout を JSON として読めない: ${String(cause)}`,
        },
      };
    }
    return {
      exit_code: output.code,
      ok: parsed["ok"] === true,
      result: parsed["result"],
      ...(parsed["error"] === undefined
        ? {}
        : { error: parsed["error"] as NonNullable<CliResult["error"]> }),
    };
  };
}

// ---------------------------------------------------------------------------
// Request validation — same strictness as `dispatch.ts`: unknown or missing
// fields are exit-2 failures, never defaults.
// ---------------------------------------------------------------------------

function optionalString(raw: Record<string, unknown>, name: string): Result<string | undefined> {
  const value = raw[name];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") {
    return err("invalid_field_type", `${name} は string である必要がある`, name);
  }
  return ok(value);
}

type ComponentRef = { readonly component_id: ComponentId; readonly state_revision: Revision };

/** `wish` / `task` fields: optional, but when present must be a typed ref. */
function componentRefOf(
  raw: Record<string, unknown>,
  name: string,
): Result<ComponentRef | undefined> {
  const value = raw[name];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", `${name} は object である必要がある`, name);
  }
  const ref = value as Record<string, unknown>;
  const componentId = parseComponentId(ref["component_id"], `${name}.component_id`);
  if (!componentId.ok) return componentId;
  const stateRevision = parseRevision(ref["state_revision"], `${name}.state_revision`);
  if (!stateRevision.ok) return stateRevision;
  return ok({ component_id: componentId.value, state_revision: stateRevision.value });
}

type RegisterInit = {
  readonly kind: ComponentKind;
  readonly title?: string;
  readonly locator?: string;
  readonly iteration_id?: string;
};

function registerOf(raw: Record<string, unknown>): Result<RegisterInit | undefined> {
  const value = raw["register"];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "register は object である必要がある", "register");
  }
  const init = value as Record<string, unknown>;
  const kind = parseComponentKind(init["kind"], "register.kind");
  if (!kind.ok) return kind;
  const title = optionalString(init, "title");
  if (!title.ok) return title;
  const locator = optionalString(init, "locator");
  if (!locator.ok) return locator;
  const iterationId = optionalString(init, "iteration_id");
  if (!iterationId.ok) return iterationId;
  return ok({
    kind: kind.value,
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(locator.value === undefined ? {} : { locator: locator.value }),
    ...(iterationId.value === undefined ? {} : { iteration_id: iterationId.value }),
  });
}

/** doit の `session` field。全 subfield 省略可。 */
function sessionOf(raw: Record<string, unknown>): Result<SessionAttachment | undefined> {
  const value = raw["session"];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "session は object である必要がある", "session");
  }
  const init = value as Record<string, unknown>;
  const sessionId = optionalString(init, "session_id");
  if (!sessionId.ok) return sessionId;
  const agent = optionalString(init, "agent");
  if (!agent.ok) return agent;
  const pane = optionalString(init, "pane");
  if (!pane.ok) return pane;
  return ok({
    ...(sessionId.value === undefined ? {} : { session_id: sessionId.value }),
    ...(agent.value === undefined ? {} : { agent: agent.value }),
    ...(pane.value === undefined ? {} : { pane: pane.value }),
  });
}

function runContextOf(raw: Record<string, unknown>, options: Options): Result<RunContext> {
  const prefix = raw["operation_prefix"];
  if (prefix === undefined) {
    return err("missing_field", "operation_prefix が必要である", "operation_prefix");
  }
  if (typeof prefix !== "string" || prefix.length === 0) {
    return err(
      "invalid_field_type",
      "operation_prefix は空でない string である必要がある",
      "operation_prefix",
    );
  }
  const actorRef = optionalString(raw, "actor_ref");
  if (!actorRef.ok) return actorRef;
  return ok({
    repository_id: options.repository_id,
    device_id: options.device_id,
    operation_prefix: prefix,
    ...(actorRef.value === undefined ? {} : { actor_ref: actorRef.value }),
  });
}

function phaseInputOf(raw: Record<string, unknown>): Result<SkillPhaseInput> {
  const phaseRaw = raw["phase"];
  if (phaseRaw === undefined) {
    return err("missing_field", "phase が必要である", "phase");
  }
  const phase = SKILL_PHASES.find((candidate) => candidate === phaseRaw);
  if (phase === undefined) {
    return err(
      "invalid_field_type",
      `phase は ${SKILL_PHASES.join(" / ")} のいずれかである必要がある`,
      "phase",
    );
  }

  const wish = componentRefOf(raw, "wish");
  if (!wish.ok) return wish;
  const task = componentRefOf(raw, "task");
  if (!task.ok) return task;
  const register = registerOf(raw);
  if (!register.ok) return register;

  const scalars: Record<string, string> = {};
  for (
    const name of [
      "task_title",
      "task_locator",
      "task_iteration_id",
      "verification",
      "correlation_id",
    ] as const
  ) {
    const value = optionalString(raw, name);
    if (!value.ok) return value;
    if (value.value !== undefined) scalars[name] = value.value;
  }
  const correlation = scalars["correlation_id"];
  const correlationField = correlation === undefined ? {} : { correlation_id: correlation };

  switch (phase) {
    case "planner":
      return ok({
        phase,
        ...(wish.value === undefined ? {} : { wish: wish.value }),
        ...(register.value === undefined ? {} : { register: register.value }),
        ...correlationField,
      });
    case "doit": {
      if (wish.value === undefined) {
        return err("missing_field", "doit は wish を必要とする", "wish");
      }
      const session = sessionOf(raw);
      if (!session.ok) return session;
      const taskTitle = scalars["task_title"];
      const taskLocator = scalars["task_locator"];
      const taskIterationId = scalars["task_iteration_id"];
      return ok({
        phase,
        wish: wish.value,
        ...(task.value === undefined ? {} : { task: task.value }),
        ...(taskTitle === undefined ? {} : { task_title: taskTitle }),
        ...(taskLocator === undefined ? {} : { task_locator: taskLocator }),
        ...(taskIterationId === undefined ? {} : { task_iteration_id: taskIterationId }),
        ...(session.value === undefined ? {} : { session: session.value }),
        ...correlationField,
      });
    }
    case "done": {
      if (task.value === undefined) {
        return err("missing_field", "done は task を必要とする", "task");
      }
      const verification = scalars["verification"];
      return ok({
        phase,
        task: task.value,
        ...(verification === undefined ? {} : { verification }),
        ...correlationField,
      });
    }
  }
}

function wishCompletionInputOf(raw: Record<string, unknown>): Result<WishCompletionInput> {
  const wish = componentRefOf(raw, "wish");
  if (!wish.ok) return wish;
  if (wish.value === undefined) {
    return err("missing_field", "wish.complete は wish を必要とする", "wish");
  }
  const reason = raw["reason"];
  if (reason === undefined) {
    return err("missing_field", "wish.complete には reason が必要である", "reason");
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return err(
      "invalid_field_type",
      "reason は空でない string である必要がある (人の理由無しに Wish を閉じない)",
      "reason",
    );
  }
  return ok({ wish: wish.value, reason });
}

function wishTransitionInputOf(raw: Record<string, unknown>): Result<WishTransitionInput> {
  const wish = componentRefOf(raw, "wish");
  if (!wish.ok) return wish;
  if (wish.value === undefined) {
    return err("missing_field", "wish.transition は wish を必要とする", "wish");
  }
  const operationRaw = raw["operation"];
  if (operationRaw === undefined) {
    return err("missing_field", "wish.transition は operation を必要とする", "operation");
  }
  const operation = WISH_TRANSITION_OPERATIONS.find((candidate) => candidate === operationRaw);
  if (operation === undefined) {
    return err(
      "invalid_field_type",
      `operation は ${WISH_TRANSITION_OPERATIONS.join(" / ")} のいずれかである必要がある`,
      "operation",
    );
  }
  const reason = raw["reason"];
  if (reason === undefined) {
    return err("missing_field", "wish.transition には reason が必要である", "reason");
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return err(
      "invalid_field_type",
      "reason は空でない string である必要がある (人の理由無しに Wish を動かさない)",
      "reason",
    );
  }
  return ok({ wish: wish.value, operation, reason });
}

// ---------------------------------------------------------------------------
// Run -> CliResponse
// ---------------------------------------------------------------------------

/**
 * Runner error codes that mean "could not proceed", not "request was wrong".
 * Anything else the runner reports is a request/plan validation failure.
 */
const UNAVAILABLE_RUN_CODES = ["cli_unavailable", "continuation_blocked"];

function exitForRun(run: PhaseRunResult): CliExitCode {
  if (run.error !== undefined) {
    return UNAVAILABLE_RUN_CODES.includes(run.error.code)
      ? CLI_EXIT_UNAVAILABLE
      : CLI_EXIT_BAD_REQUEST;
  }
  return run.completed ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED;
}

function respond(kind: string, run: PhaseRunResult): CliResponse {
  if (run.error !== undefined) {
    diagnostic(`error: ${run.error.code}: ${run.error.message}`);
  } else if (run.halted_at !== undefined) {
    const halted = run.commands[run.halted_at];
    diagnostic(
      `halted: ${String(halted?.operation)} が disposition=${String(halted?.disposition)} ` +
        "を返したため以降の command を出さない",
    );
  }
  // `ok` follows dispatch.ts semantics: the request was processed. The
  // domain outcome lives in `exit_code` and `result`, not in `ok`.
  return { kind, ok: run.error === undefined, exit_code: exitForRun(run), result: run };
}

function dispatchEntry(options: Options, request: unknown): CliResponse {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return failure(
      "unknown",
      "invalid_field_type",
      "request は object である必要がある",
      CLI_EXIT_BAD_REQUEST,
    );
  }
  const raw = request as Record<string, unknown>;
  const kindRaw = raw["kind"];
  const kind = ENTRY_REQUEST_KINDS.find((candidate) => candidate === kindRaw);
  if (kind === undefined) {
    return failure(
      typeof kindRaw === "string" ? kindRaw : "unknown",
      "unknown_request_kind",
      `未知の request kind: ${JSON.stringify(kindRaw)}`,
      CLI_EXIT_BAD_REQUEST,
      "kind",
    );
  }
  const ctx = runContextOf(raw, options);
  if (!ctx.ok) {
    return failure(kind, ctx.error.code, ctx.error.message, CLI_EXIT_BAD_REQUEST, ctx.error.path);
  }
  const submit = cliSubmitOf(options);

  switch (kind) {
    case "skill.phase": {
      const input = phaseInputOf(raw);
      if (!input.ok) {
        return failure(
          kind,
          input.error.code,
          input.error.message,
          CLI_EXIT_BAD_REQUEST,
          input.error.path,
        );
      }
      return respond(kind, runSkillPhase(submit, input.value, ctx.value));
    }
    case "wish.complete": {
      const input = wishCompletionInputOf(raw);
      if (!input.ok) {
        return failure(
          kind,
          input.error.code,
          input.error.message,
          CLI_EXIT_BAD_REQUEST,
          input.error.path,
        );
      }
      return respond(kind, runWishCompletion(submit, input.value, ctx.value));
    }
    case "wish.transition": {
      const input = wishTransitionInputOf(raw);
      if (!input.ok) {
        return failure(
          kind,
          input.error.code,
          input.error.message,
          CLI_EXIT_BAD_REQUEST,
          input.error.path,
        );
      }
      return respond(kind, runWishTransition(submit, input.value, ctx.value));
    }
  }
}

function main(): void {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    diagnostic(USAGE);
    emit(failure("usage", "missing_field", parsedArgs.message, CLI_EXIT_UNAVAILABLE, "argv"));
    return;
  }
  const options = parsedArgs.value;

  if (!parseRepositoryId(options.repository_id).ok) {
    emit(failure(
      "usage",
      "invalid_id",
      `repository_id が id 形式でない: ${options.repository_id}`,
      CLI_EXIT_UNAVAILABLE,
      "repository_id",
    ));
    return;
  }

  let requestText = options.request;
  if (requestText === undefined) {
    try {
      requestText = readFileSync(0, "utf8");
    } catch (cause) {
      emit(failure(
        "stdin",
        "missing_field",
        `stdin を読めない: ${String(cause)}`,
        CLI_EXIT_UNAVAILABLE,
        "request",
      ));
      return;
    }
  }

  let request: unknown;
  try {
    request = JSON.parse(requestText);
  } catch (cause) {
    emit(failure(
      "request",
      "invalid_field_type",
      `request が JSON として読めない: ${String(cause)}`,
      CLI_EXIT_BAD_REQUEST,
      "request",
    ));
    return;
  }

  emit(dispatchEntry(options, request));
}

if (import.meta.main) {
  main();
}
