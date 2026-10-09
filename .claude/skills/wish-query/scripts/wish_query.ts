#!/usr/bin/env -S deno run --allow-read --allow-run

const RESPONSE_LIMIT_BYTES = 256 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;

const BODY_SCAN_SCHEMA = "wf4.body-scan.v1";
const BODY_SCAN_DEFAULTS = {
  dir: "docs",
  glob: "wish_*.md",
  maxFiles: 200,
  maxMatches: 40,
  fileBytes: 256 * 1024,
} as const;
const TRUNCATION_ORDER = [
  "dir_missing",
  "file_cap",
  "file_bytes",
  "match_cap",
] as const;

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
  readonly command: "preflight" | "list" | "body-scan";
  readonly values: ReadonlyMap<string, string>;
  readonly terms: readonly string[];
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
  "body-scan": new Set([
    "term",
    "dir",
    "glob",
    "max-files",
    "max-matches",
    "file-bytes",
  ]),
};

function parseArgs(args: readonly string[]): ParsedArgs {
  const command = args[0];
  if (command !== "preflight" && command !== "list" && command !== "body-scan") {
    fail(
      "usage",
      "expected: wish_query.ts <preflight|list|body-scan> [--flag value ...]",
    );
  }
  const values = new Map<string, string>();
  const terms: string[] = [];
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
    if (name === "term") {
      terms.push(value);
      continue;
    }
    if (values.has(name)) {
      fail("duplicate_argument", `duplicate flag: --${name}`);
    }
    values.set(name, value);
  }
  if (command === "preflight" && !values.has("title")) {
    fail("missing_argument", "preflight requires --title");
  }
  if (command === "body-scan" && terms.length === 0) {
    fail("missing_argument", "body-scan requires at least one --term");
  }
  if (values.has("expected-revision") && !values.has("subject")) {
    fail("missing_argument", "--expected-revision requires --subject");
  }
  return { command, values, terms };
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

function normalizeForScan(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function globToRegex(glob: string): RegExp {
  if (glob.length === 0 || glob.includes("/") || glob.includes("..")) {
    fail("invalid_argument", "--glob must be a bare filename pattern");
  }
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u");
}

function safeDir(value: string): string {
  if (
    value.length === 0 || value.startsWith("/") || value.includes("..") ||
    value.includes("\\")
  ) {
    fail("invalid_argument", "--dir must be a relative path inside the repo");
  }
  return value.replace(/\/+$/u, "");
}

async function readFileBounded(path: string, cap: number): Promise<string> {
  const handle = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(cap);
    let filled = 0;
    while (filled < cap) {
      const read = await handle.read(buffer.subarray(filled));
      if (read === null) break;
      filled += read;
    }
    return new TextDecoder().decode(buffer.subarray(0, filled));
  } finally {
    handle.close();
  }
}

function digestOf(paths: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = paths.join("\n");
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function bodyScan(repoRoot: string, parsed: ParsedArgs): Promise<never> {
  const get = (name: string): string | undefined => parsed.values.get(name);
  const dir = safeDir(get("dir") ?? BODY_SCAN_DEFAULTS.dir);
  const glob = get("glob") ?? BODY_SCAN_DEFAULTS.glob;
  const maxFiles = integer(parsed.values, "max-files") ?? BODY_SCAN_DEFAULTS.maxFiles;
  const maxMatches = integer(parsed.values, "max-matches") ?? BODY_SCAN_DEFAULTS.maxMatches;
  const fileBytes = integer(parsed.values, "file-bytes") ?? BODY_SCAN_DEFAULTS.fileBytes;
  const matcher = globToRegex(glob);
  const terms = [...new Set(parsed.terms.map(normalizeForScan))].filter(
    (term) => term.length > 0,
  );
  if (terms.length === 0) {
    fail("invalid_argument", "--term values must not be blank");
  }

  const truncated = new Set<string>();
  const dirAbs = `${repoRoot}/${dir}`;
  let names: string[] = [];
  let missingDir = false;
  try {
    for await (const entry of Deno.readDir(dirAbs)) {
      if (entry.isFile && matcher.test(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      missingDir = true;
      truncated.add("dir_missing");
    } else fail("scan_error", `cannot read ${dir}: ${String(error)}`, 2);
  }
  names.sort();
  if (names.length > maxFiles) {
    truncated.add("file_cap");
    names = names.slice(0, maxFiles);
  }

  const matchedFiles: string[] = [];
  const matchedAll: string[] = [];
  const perTerm: Record<string, number> = Object.fromEntries(
    terms.map((term) => [term, 0]),
  );
  let matchedTotal = 0;
  for (const name of names) {
    const path = `${dirAbs}/${name}`;
    let text: string;
    try {
      const stat = await Deno.stat(path);
      if (stat.size > fileBytes) {
        truncated.add("file_bytes");
        text = await readFileBounded(path, fileBytes);
      } else {
        text = await Deno.readTextFile(path);
      }
    } catch {
      truncated.add("file_bytes");
      continue;
    }
    const haystack = normalizeForScan(text);
    let hit = false;
    for (const term of terms) {
      if (haystack.includes(term)) {
        hit = true;
        perTerm[term] += 1;
      }
    }
    if (!hit) continue;
    matchedTotal += 1;
    matchedAll.push(`${dir}/${name}`);
    if (matchedFiles.length < maxMatches) matchedFiles.push(`${dir}/${name}`);
    else truncated.add("match_cap");
  }

  const truncation = TRUNCATION_ORDER.filter((reason) => truncated.has(reason));
  const complete = truncation.length === 0;
  console.log(JSON.stringify({
    kind: "wish-query.body-scan",
    ok: true,
    result: {
      schema: BODY_SCAN_SCHEMA,
      dir,
      glob,
      terms,
      dir_missing: missingDir,
      scanned_files: names.length,
      file_cap: maxFiles,
      file_bytes: fileBytes,
      matched_total: matchedTotal,
      matched_files: matchedFiles,
      matched_digest: digestOf(matchedAll),
      per_term: perTerm,
      truncated: !complete,
      truncation,
      complete,
      persistent_delta_bytes: 0,
    },
  }));
  Deno.exit(complete ? 0 : 3);
}

const parsed = parseArgs(Deno.args);
const repoRoot = await findRepoRoot(Deno.cwd());
if (parsed.command === "body-scan") await bodyScan(repoRoot, parsed);
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
