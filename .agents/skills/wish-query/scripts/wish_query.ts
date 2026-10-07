#!/usr/bin/env -S deno run --allow-read --allow-run

const RESPONSE_LIMIT_BYTES = 256 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;

function fail(code: string, message: string, exitCode = 2): never {
  console.log(JSON.stringify({
    kind: "wish-query.adapter",
    ok: false,
    error: { code, message },
  }));
  Deno.exit(exitCode);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function parent(path: string): string {
  const normalized = path.replace(/\/+$/u, "") || "/";
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return "/";
  return normalized.slice(0, slash);
}

async function findRepoRoot(start: string): Promise<string> {
  let cursor = start;
  while (true) {
    if (await isFile(`${cursor}/.agents/workflow-v4/wf4.sh`)) return cursor;
    const next = parent(cursor);
    if (next === cursor) {
      fail(
        "workflow_v4_not_found",
        "no .agents/workflow-v4/wf4.sh found above cwd",
      );
    }
    cursor = next;
  }
}

type ParsedArgs = {
  readonly command: "preflight" | "list";
  readonly values: ReadonlyMap<string, string>;
};

const ALLOWED: Readonly<Record<ParsedArgs["command"], ReadonlySet<string>>> = {
  preflight: new Set([
    "title",
    "subject",
    "expected-revision",
    "iteration",
    "state-changed-since",
    "scan-limit",
    "candidate-limit",
  ]),
  list: new Set([
    "id",
    "kind",
    "status",
    "iteration",
    "state-changed-since",
    "limit",
  ]),
};

function parseArgs(args: readonly string[]): ParsedArgs {
  const command = args[0];
  if (command !== "preflight" && command !== "list") {
    fail(
      "usage",
      "expected: wish_query.ts <preflight|list> [--flag value ...]",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const raw = args[index];
    const value = args[index + 1];
    if (
      raw === undefined || !raw.startsWith("--") || raw.length === 2 ||
      value === undefined
    ) {
      fail("invalid_argument", "flags must use --name value pairs");
    }
    const name = raw.slice(2);
    if (!ALLOWED[command].has(name)) {
      fail("unknown_argument", `unknown ${command} flag: --${name}`);
    }
    if (values.has(name)) {
      fail("duplicate_argument", `duplicate flag: --${name}`);
    }
    values.set(name, value);
  }
  if (command === "preflight" && !values.has("title")) {
    fail("missing_argument", "preflight requires --title");
  }
  if (values.has("expected-revision") && !values.has("subject")) {
    fail("missing_argument", "--expected-revision requires --subject");
  }
  return { command, values };
}

function integer(
  values: ReadonlyMap<string, string>,
  name: string,
  allowZero = false,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const pattern = allowZero ? /^\d+$/u : /^[1-9]\d*$/u;
  if (!pattern.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail(
      "invalid_argument",
      `--${name} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return Number(raw);
}

function requestFor(parsed: ParsedArgs): JsonRecord {
  const get = (name: string): string | undefined => parsed.values.get(name);
  if (parsed.command === "preflight") {
    return {
      kind: "wish_query.preflight",
      proposed_title: get("title"),
      ...(get("subject") === undefined
        ? {}
        : { subject_component_id: get("subject") }),
      ...(get("expected-revision") === undefined ? {} : {
        expected_revision: integer(parsed.values, "expected-revision", true),
      }),
      ...(get("iteration") === undefined
        ? {}
        : { iteration_id: get("iteration") }),
      ...(get("state-changed-since") === undefined
        ? {}
        : { state_changed_since: get("state-changed-since") }),
      ...(get("scan-limit") === undefined
        ? {}
        : { scan_limit: integer(parsed.values, "scan-limit") }),
      ...(get("candidate-limit") === undefined
        ? {}
        : { candidate_limit: integer(parsed.values, "candidate-limit") }),
    };
  }
  return {
    kind: "component.list",
    ...(get("id") === undefined ? {} : { component_id: get("id") }),
    ...(get("kind") === undefined ? {} : { component_kind: get("kind") }),
    ...(get("status") === undefined ? {} : { status: get("status") }),
    ...(get("iteration") === undefined
      ? {}
      : { iteration_id: get("iteration") }),
    ...(get("state-changed-since") === undefined
      ? {}
      : { state_changed_since: get("state-changed-since") }),
    ...(get("limit") === undefined
      ? {}
      : { limit: integer(parsed.values, "limit") }),
  };
}

type BoundedRead = {
  readonly bytes: Uint8Array;
  readonly exceeded: boolean;
};

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  stopChild: () => void,
): Promise<BoundedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > limit) {
        stopChild();
        await reader.cancel();
        return { bytes: new Uint8Array(), exceeded: true };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, exceeded: false };
}

const parsed = parseArgs(Deno.args);
const repoRoot = await findRepoRoot(Deno.cwd());
if (!(await isFile(`${repoRoot}/.workflow/repository.json`))) {
  fail("repository_not_provisioned", ".workflow/repository.json is missing");
}

const request = JSON.stringify(requestFor(parsed));
const child = new Deno.Command(`${repoRoot}/.agents/workflow-v4/wf4.sh`, {
  cwd: repoRoot,
  args: ["cli", request],
  stdout: "piped",
  stderr: "piped",
}).spawn();
let stopped = false;
const stopChild = (): void => {
  if (stopped) return;
  stopped = true;
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the bounded reader and this guard.
  }
};
const [stdout, stderr, status] = await Promise.all([
  readBounded(child.stdout, RESPONSE_LIMIT_BYTES, stopChild),
  readBounded(child.stderr, STDERR_LIMIT_BYTES, stopChild),
  child.status,
]);
if (stdout.exceeded) {
  fail(
    "output_limit_exceeded",
    `Core response exceeds ${RESPONSE_LIMIT_BYTES} bytes`,
    3,
  );
}
if (stderr.exceeded) {
  fail(
    "stderr_limit_exceeded",
    `Core stderr exceeds ${STDERR_LIMIT_BYTES} bytes`,
    3,
  );
}
if (stderr.bytes.length > 0) await Deno.stderr.write(stderr.bytes);
if (stdout.bytes.length === 0) {
  fail(
    "empty_core_response",
    "Core returned no JSON response",
    status.code === 0 ? 3 : status.code,
  );
}
await Deno.stdout.write(stdout.bytes);
Deno.exit(status.code);
