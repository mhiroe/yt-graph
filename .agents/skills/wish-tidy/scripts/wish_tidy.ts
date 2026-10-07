#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

type Evidence = {
  readonly timestamp: string;
  readonly source: string;
  readonly evidence: string;
  readonly excerpt: string;
};

type WorkflowRead = {
  readonly events: Evidence[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly disposition: string;
};

const MAX_FINDINGS = 200;
const MAX_QUERY_CHARS = 256;

function fail(code: string, message: string, exitCode = 2): never {
  console.log(JSON.stringify({ ok: false, error: { code, message } }));
  Deno.exit(exitCode);
}

function parent(path: string): string {
  const clean = path.replace(/\/+$/u, "") || "/";
  const slash = clean.lastIndexOf("/");
  return slash <= 0 ? "/" : clean.slice(0, slash);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function repoRoot(): Promise<string> {
  const override = Deno.env.get("WISH_TIDY_REPO_ROOT");
  if (override) return override.replace(/\/+$/u, "");
  let cursor = Deno.cwd();
  while (true) {
    if (await exists(`${cursor}/.git`)) return cursor;
    const next = parent(cursor);
    if (next === cursor) {
      fail("repository_not_found", "no git repository above cwd");
    }
    cursor = next;
  }
}

type Parsed =
  | {
    readonly mode: "lineage";
    readonly query: string;
    readonly kind: "id" | "keyword";
  }
  | { readonly mode: "check2" | "check3-light" | "check4" };

function parseArgs(args: readonly string[]): Parsed {
  if (
    args[0] === "check2" || args[0] === "check3-light" || args[0] === "check4"
  ) {
    if (args.length !== 1) {
      fail("invalid_argument", `${args[0]} takes no arguments`);
    }
    return { mode: args[0] };
  }
  if (args[0] !== "lineage") {
    fail(
      "usage",
      "expected: wish_tidy.ts <lineage (--id ID | --keyword TEXT) | check2 | check3-light | check4>",
    );
  }
  if (args.length !== 3 || (args[1] !== "--id" && args[1] !== "--keyword")) {
    fail("invalid_argument", "lineage requires exactly one --id or --keyword");
  }
  const query = args[2]?.trim();
  if (!query) fail("invalid_argument", "query must not be empty");
  if ([...query].length > MAX_QUERY_CHARS) {
    fail("invalid_argument", `query exceeds ${MAX_QUERY_CHARS} characters`);
  }
  return {
    mode: "lineage",
    query,
    kind: args[1] === "--id" ? "id" : "keyword",
  };
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  if (!(await exists(root))) return files;
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) files.push(...await markdownFiles(path));
    else if (entry.isFile && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

function timestampFromName(path: string, fallback: Date): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = name.match(/^(\d{8})T(\d{4})(\d{2})?Z/u);
  if (!match) return fallback.toISOString();
  const [, day, hm, seconds = "00"] = match;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${
    hm.slice(0, 2)
  }:${hm.slice(2, 4)}:${seconds}Z`;
}

function cleanExcerpt(line: string): string {
  return line.trim().replace(/\s+/gu, " ").replace(/`/gu, "\\`").slice(0, 240);
}

async function intakeEvidence(
  root: string,
  query: string,
): Promise<Evidence[]> {
  const base = `${root}/.agent-state/intake`;
  const needle = query.toLocaleLowerCase("en-US");
  const found: Evidence[] = [];
  for (const path of await markdownFiles(base)) {
    const stat = await Deno.stat(path);
    const lines = (await Deno.readTextFile(path)).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!line.toLocaleLowerCase("en-US").includes(needle)) return;
      found.push({
        timestamp: timestampFromName(path, stat.mtime ?? new Date(0)),
        source: "intake",
        evidence: `${path.slice(root.length + 1)}:${index + 1}`,
        excerpt: cleanExcerpt(line),
      });
    });
  }
  return found;
}

async function decisionEvidence(
  root: string,
  query: string,
): Promise<Evidence[]> {
  const path = `${root}/.agent-state/user-decisions.md`;
  if (!(await exists(path))) return [];
  const needle = query.toLocaleLowerCase("en-US");
  const lines = (await Deno.readTextFile(path)).split(/\r?\n/u);
  let timestamp = (await Deno.stat(path)).mtime?.toISOString() ??
    new Date(0).toISOString();
  const found: Evidence[] = [];
  lines.forEach((line, index) => {
    const date = line.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1];
    if (date) timestamp = `${date}T00:00:00Z`;
    if (!line.toLocaleLowerCase("en-US").includes(needle)) return;
    found.push({
      timestamp,
      source: "decision",
      evidence: `.agent-state/user-decisions.md:${index + 1}`,
      excerpt: cleanExcerpt(line),
    });
  });
  return found;
}

async function returnsEvidence(
  path: string,
  query: string,
): Promise<Evidence[]> {
  if (!(await exists(path))) return [];
  const needle = query.toLocaleLowerCase("en-US");
  const fallback = (await Deno.stat(path)).mtime?.toISOString() ??
    new Date(0).toISOString();
  const found: Evidence[] = [];
  const lines = (await Deno.readTextFile(path)).split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (!line.toLocaleLowerCase("en-US").includes(needle)) return;
    let timestamp = fallback;
    let excerpt = cleanExcerpt(line);
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.ts === "string") timestamp = row.ts;
      excerpt = cleanExcerpt(
        [
          row.title,
          row.from,
          row.repo,
          row.judgment,
          row.path,
        ].filter((item) => typeof item === "string").join(" | "),
      );
    } catch {
      // A matching malformed row remains visible evidence instead of vanishing.
    }
    found.push({
      timestamp,
      source: "returns-index",
      evidence: `${path}:${index + 1}`,
      excerpt,
    });
  });
  return found;
}

async function gitEvidence(root: string, query: string): Promise<Evidence[]> {
  const output = await new Deno.Command("git", {
    cwd: root,
    args: [
      "log",
      "--all",
      "--fixed-strings",
      "--regexp-ignore-case",
      `--grep=${query}`,
      "--max-count=200",
      "--format=%H%x09%cI%x09%s",
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return [];
  return new TextDecoder().decode(output.stdout).trim().split(/\r?\n/u)
    .filter(Boolean).map((line) => {
      const [hash = "", timestamp = new Date(0).toISOString(), ...subject] =
        line.split("\t");
      return {
        timestamp,
        source: "git",
        evidence: `commit:${hash}`,
        excerpt: cleanExcerpt(subject.join("\t")),
      };
    });
}

async function workflowEvidence(
  root: string,
  query: string,
  kind: "id" | "keyword",
): Promise<WorkflowRead> {
  const adapter = `${root}/.agents/skills/wish-query/scripts/wish_query.ts`;
  if (!(await exists(adapter))) {
    return {
      events: [],
      complete: false,
      truncated: false,
      disposition: "adapter_missing",
    };
  }
  const args = kind === "id" ? ["list", "--id", query] : [
    "preflight",
    "--title",
    query,
    "--scan-limit",
    "200",
    "--candidate-limit",
    "25",
  ];
  const output = await new Deno.Command(adapter, {
    cwd: root,
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  const raw = new TextDecoder().decode(output.stdout);
  try {
    const response = JSON.parse(raw) as Record<string, unknown>;
    const result = response.result as Record<string, unknown> | undefined;
    const rows = kind === "id" ? result?.components : result?.candidates;
    if (!Array.isArray(rows)) {
      return {
        events: [],
        complete: false,
        truncated: false,
        disposition: "invalid_response",
      };
    }
    const events = rows.flatMap((value): Evidence[] => {
      if (typeof value !== "object" || value === null) return [];
      const row = value as Record<string, unknown>;
      const componentId = typeof row.component_id === "string"
        ? row.component_id
        : "unknown";
      const locator = typeof row.document_locator === "string"
        ? row.document_locator
        : typeof row.locator === "string"
        ? row.locator
        : componentId;
      const title = typeof row.title_projection === "string"
        ? row.title_projection
        : typeof row.title === "string"
        ? row.title
        : "";
      return [{
        timestamp: typeof row.updated_at === "string"
          ? row.updated_at
          : new Date(0).toISOString(),
        source: "workflow-query",
        evidence: locator,
        excerpt: cleanExcerpt(
          `${componentId} ${row.kind ?? ""} ${row.status ?? ""} rev ${
            row.state_revision ?? "?"
          } ${title}`,
        ),
      }];
    });
    const truncated = result?.truncated === true;
    const complete = kind === "id" ? !truncated : result?.complete === true;
    return {
      events,
      complete,
      truncated,
      disposition: typeof result?.disposition === "string"
        ? result.disposition
        : complete
        ? "complete"
        : "incomplete",
    };
  } catch {
    return {
      events: [],
      complete: false,
      truncated: false,
      disposition: "invalid_response",
    };
  }
}

function safeName(value: string): string {
  const slug = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "").slice(0, 48);
  return slug || "query";
}

function compactStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    fail("invalid_clock", "WISH_TIDY_NOW is not an ISO timestamp");
  }
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function displayTimestamp(sourceTimestamp: string): string {
  const date = new Date(sourceTimestamp);
  return Number.isNaN(date.getTime()) ? sourceTimestamp : date.toISOString();
}

function report(
  query: string,
  kind: string,
  generatedAt: string,
  events: Evidence[],
  truncated: boolean,
  sourceCounts: readonly number[],
  workflow: WorkflowRead,
): string {
  const lines = [
    "# Wish-tidy lineage report",
    "",
    `- Query: \`${query.replace(/`/gu, "\\`")}\` (${kind})`,
    `- Generated at: ${generatedAt}`,
    `- Findings: ${events.length}`,
    `- Bounds: max ${MAX_FINDINGS} findings; truncated=${truncated}`,
    `- Sources: intake=${sourceCounts[0]}, decision=${
      sourceCounts[1]
    }, returns-index=${sourceCounts[2]}, git=${
      sourceCounts[3]
    }, workflow-query=${sourceCounts[4]}`,
    `- workflow-query: complete=${workflow.complete}, truncated=${workflow.truncated}, disposition=${workflow.disposition}`,
    "- Mutation policy: report-only",
    "",
    "## Check 1 — lineage",
    "",
  ];
  if (
    kind === "keyword" && sourceCounts.slice(0, 4).every((count) => count === 0)
  ) {
    lines.push(
      "- Hint: no literal matches in intake/decision/returns-index/git; try spelling, punctuation, underscore or hyphen variants.",
      "",
    );
  }
  if (events.length === 0) {
    lines.push("No matching evidence found within the declared sources.", "");
  }
  for (const event of events) {
    const displayedAt = displayTimestamp(event.timestamp);
    lines.push(
      `### ${displayedAt} — ${event.source}`,
      "",
      ...(displayedAt === event.timestamp
        ? []
        : [`- Source time: ${event.timestamp}`]),
      `- Evidence: \`${event.evidence.replace(/`/gu, "\\`")}\``,
      `- Match: ${event.excerpt}`,
      "- Proposed follow-up: inspect the canonical Story and Core state before any sanctioned change.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// check 2 / check 3-light / check 4 — the manual sweep checks codified as named
// modes. Methods + thresholds follow `.agent-state/tidy/20261006-wish-tidy-methods-kk.md`.
// ---------------------------------------------------------------------------

type TaskNode = {
  readonly id: string;
  readonly marker: string;
  readonly title: string;
  readonly norm: string;
  readonly tokenSet: ReadonlySet<string>;
  readonly tokenSeq: readonly string[];
  readonly file: string;
  readonly line: number;
};

type WishBlock = {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly closedNote: string | null;
  readonly tasks: TaskNode[];
  unanchoredOpen: number;
};

const TASK_LINE = /^\s*-\s*\[([^\]]*)\]\s*(.*?)\^t-([0-9A-Z]+)\s*$/u;
const WISH_ANCHOR = /^\^w-([0-9A-Z]+)\s*$/u;
// Older docs carry the anchor on the wish heading line instead (`## title ^w-id`).
const WISH_HEADING_ANCHOR = /^#{1,6}\s+.*\^w-([0-9A-Z]+)\s*$/u;
const HEADING_LINE = /^#{1,6}\s/u;
const CHECKBOX_LINE = /^\s*-\s*\[([^\]]*)\]/u;
const CLOSE_ANNOTATION = /\b(COMPLETE|DROPPED|CLOSED)\b/u;
const TERMINAL_MARKERS: ReadonlySet<string> = new Set([
  "done",
  "x",
  "checked",
  "dropped",
]);
const DB_TERMINAL: ReadonlySet<string> = new Set([
  "done",
  "dropped",
  "completed",
  "closed",
]);
const COMPONENT_LIMIT = 100;
const PAIR_REPORT_MAX = 60;

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase("en-US").match(/[a-z0-9]{2,}/gu) ?? [];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const token of small) if (large.has(token)) both += 1;
  const union = a.size + b.size - both;
  return union === 0 ? 1 : both / union;
}

// difflib SequenceMatcher.ratio() port — recursive longest-match via the b2j
// index method; autojunk is intentionally absent (titles stay << 200 chars).
function difflibRatio(a: string, b: string): number {
  if (a.length + b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const key = b[j] ?? "";
    const list = b2j.get(key);
    if (list) list.push(j);
    else b2j.set(key, [j]);
  }
  let matched = 0;
  const queue: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() ?? [0, 0, 0, 0];
    let bestI = 0;
    let bestJ = 0;
    let bestSize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i] ?? "") ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
      j2len = next;
    }
    if (bestSize === 0) continue;
    matched += bestSize;
    if (alo < bestI && blo < bestJ) {
      queue.push([alo, bestI, blo, bestJ]);
    }
    if (bestI + bestSize < ahi && bestJ + bestSize < bhi) {
      queue.push([bestI + bestSize, ahi, bestJ + bestSize, bhi]);
    }
  }
  return (2 * matched) / (a.length + b.length);
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

async function wishDocFiles(root: string): Promise<string[]> {
  const dir = `${root}/docs`;
  if (!(await exists(dir))) return [];
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && /^wish_.*\.md$/u.test(entry.name)) {
      files.push(`${dir}/${entry.name}`);
    }
  }
  return files.sort();
}

async function scanWishDocs(
  root: string,
): Promise<{ tasks: TaskNode[]; wishes: WishBlock[] }> {
  const tasks: TaskNode[] = [];
  const wishes: WishBlock[] = [];
  for (const path of await wishDocFiles(root)) {
    const rel = path.slice(root.length + 1);
    const lines = (await Deno.readTextFile(path)).split(/\r?\n/u);
    let block: WishBlock | null = null;
    let headEnd = -1;
    const finish = (endLine: number): void => {
      if (block === null) return;
      const head = lines.slice(
        block.line,
        headEnd < 0 ? endLine : Math.min(headEnd, endLine),
      );
      block = {
        ...block,
        closedNote: head.find((l) => CLOSE_ANNOTATION.test(l))?.trim() ?? null,
      };
      wishes.push(block);
    };
    lines.forEach((line, index) => {
      const wishAnchor = line.match(WISH_ANCHOR) ??
        line.match(WISH_HEADING_ANCHOR);
      if (wishAnchor) {
        finish(index);
        block = {
          id: `w-${wishAnchor[1]}`,
          file: rel,
          line: index + 1,
          closedNote: null,
          tasks: [],
          unanchoredOpen: 0,
        };
        headEnd = -1;
        return;
      }
      if (block === null) return;
      if (headEnd < 0 && HEADING_LINE.test(line)) headEnd = index;
      const taskMatch = line.match(TASK_LINE);
      if (taskMatch) {
        const norm = taskMatch[2].toLocaleLowerCase("en-US")
          .replace(/\s+/gu, " ").trim();
        const tokenSeq = tokenize(taskMatch[2]);
        const node: TaskNode = {
          id: `t-${taskMatch[3]}`,
          marker: taskMatch[1].trim(),
          title: taskMatch[2].trim(),
          norm,
          tokenSet: new Set(tokenSeq),
          tokenSeq,
          file: rel,
          line: index + 1,
        };
        tasks.push(node);
        block.tasks.push(node);
        return;
      }
      const check = line.match(CHECKBOX_LINE);
      if (
        check &&
        !TERMINAL_MARKERS.has(check[1].trim().toLocaleLowerCase("en-US"))
      ) {
        block.unanchoredOpen += 1;
      }
    });
    finish(lines.length);
  }
  return { tasks, wishes };
}

type ComponentRow = {
  readonly component_id: string;
  readonly kind?: string;
  readonly status?: string;
  readonly document_locator?: string;
  readonly title_projection?: string;
};

type CoreList = {
  readonly rows: ComponentRow[];
  readonly available: boolean;
  readonly truncated: boolean;
  readonly note: string;
};

async function coreList(
  root: string,
  componentKind: string,
): Promise<CoreList> {
  const wf4 = `${root}/.agents/workflow-v4/wf4.sh`;
  if (!(await exists(wf4))) {
    return {
      rows: [],
      available: false,
      truncated: false,
      note: ".agents/workflow-v4/wf4.sh missing (unprovisioned repo)",
    };
  }
  const request = JSON.stringify({
    kind: "component.list",
    component_kind: componentKind,
    limit: COMPONENT_LIMIT,
  });
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(wf4, {
      cwd: root,
      args: ["cli", request],
      stdout: "piped",
      stderr: "null",
    }).output();
  } catch (error) {
    return {
      rows: [],
      available: false,
      truncated: false,
      note: `wf4.sh cli spawn failed: ${error}`,
    };
  }
  const raw = new TextDecoder().decode(output.stdout);
  try {
    const response = JSON.parse(raw) as Record<string, unknown>;
    const result = response.result as Record<string, unknown> | undefined;
    const rows = result?.components;
    if (response.ok !== true || !Array.isArray(rows)) {
      const error = response.error as Record<string, unknown> | undefined;
      return {
        rows: [],
        available: false,
        truncated: false,
        note: `component.list failed: ${error?.code ?? output.code}`,
      };
    }
    return {
      rows: rows as ComponentRow[],
      available: true,
      truncated: result?.truncated === true,
      note: "",
    };
  } catch {
    return {
      rows: [],
      available: false,
      truncated: false,
      note: "component.list returned unparseable output",
    };
  }
}

type ConditionRow = {
  readonly scope: string;
  readonly subject: string;
  readonly condition_type: string;
  readonly state: string;
  readonly opened_at: number;
  readonly last_seen: number;
  readonly holds_n: number;
  readonly alerted: number;
};

type ConditionRead = {
  readonly rows: ConditionRow[];
  readonly available: boolean;
  readonly note: string;
};

async function monitorConditions(dbPath: string): Promise<ConditionRead> {
  if (!(await exists(dbPath))) {
    return {
      rows: [],
      available: false,
      note: `monitor DB missing: ${dbPath}`,
    };
  }
  const sql =
    "SELECT scope, subject, condition_type, state, opened_at, last_seen, holds_n, alerted " +
    "FROM conditions WHERE condition_type LIKE 'bloat%' " +
    "OR condition_type LIKE 'conform%' " +
    "OR subject LIKE 'wave:bloat%' OR subject LIKE 'wave:conform%' " +
    "ORDER BY condition_type, subject";
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("sqlite3", {
      args: ["-readonly", "-json", dbPath, sql],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    return {
      rows: [],
      available: false,
      note: `sqlite3 spawn failed: ${error}`,
    };
  }
  if (!output.success) {
    return {
      rows: [],
      available: false,
      note: `sqlite3 exit ${output.code}: ${
        new TextDecoder().decode(output.stderr).trim().slice(0, 200)
      }`,
    };
  }
  try {
    const rows = JSON.parse(new TextDecoder().decode(output.stdout));
    return {
      rows: Array.isArray(rows) ? rows as ConditionRow[] : [],
      available: true,
      note: "",
    };
  } catch {
    return {
      rows: [],
      available: false,
      note: "sqlite3 -json output unparseable",
    };
  }
}

async function hostName(): Promise<string> {
  const override = Deno.env.get("WISH_TIDY_HOST");
  if (override) return override;
  try {
    const out = await new Deno.Command("hostname", {
      stdout: "piped",
      stderr: "null",
    }).output();
    const name = new TextDecoder().decode(out.stdout).trim();
    if (out.success && name) return name;
  } catch {
    // fall through
  }
  return "unknown";
}

type IntakeDoc = {
  readonly path: string;
  readonly tokenSet: ReadonlySet<string>;
  readonly anchors: readonly string[];
};

async function intakeDocs(root: string): Promise<IntakeDoc[]> {
  const found: IntakeDoc[] = [];
  for (const path of await markdownFiles(`${root}/.agent-state/intake`)) {
    const rel = path.slice(root.length + 1);
    const text = await Deno.readTextFile(path);
    const name = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/u, "");
    const headingTokens = text.split(/\r?\n/u)
      .filter((line) => HEADING_LINE.test(line)).join(" ");
    found.push({
      path: rel,
      tokenSet: new Set(tokenize(`${name} ${headingTokens}`)),
      anchors: [...text.matchAll(/\bt-[0-9A-Z]{6,}\b/gu)].map((m) => m[0]),
    });
  }
  return found;
}

function epochToIso(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? `${value}` : date.toISOString();
}

const SECTION_HEADINGS = {
  "check2": "## check 2 — duplicate-request detection",
  "check3-light": "## check 3 light — all-terminal open-wish sweep",
  "check4": "## check 4 — pollution consumption",
} as const;

async function upsertReportSection(
  root: string,
  generatedAt: string,
  mode: keyof typeof SECTION_HEADINGS,
  body: readonly string[],
): Promise<string> {
  const day = generatedAt.slice(0, 10).replace(/-/gu, "");
  const outputDir = `${root}/.agent-state/tidy`;
  await Deno.mkdir(outputDir, { recursive: true });
  const path = `${outputDir}/${day}-wish-tidy.md`;
  let text = "";
  if (await exists(path)) {
    text = await Deno.readTextFile(path);
  } else {
    const host = await hostName();
    text = [
      `# wish-tidy report — ${generatedAt.slice(0, 10)} (host ${host})`,
      "",
      "Wish: Repeatable wish-tidying skill `w-01M3ZDTTDR`. Report-only; no wish-doc or DB",
      "mutation outside sanctioned seams. Sections accumulate per check.",
      "",
    ].join("\n");
  }
  const heading = SECTION_HEADINGS[mode];
  const lines = text.replace(/\n+$/u, "").split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  const section = [heading, "", ...body, ""];
  if (start < 0) {
    lines.push("", ...section);
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /u.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start, ...section);
  }
  await Deno.writeTextFile(
    path,
    `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").replace(/\n$/u, "")}\n`,
  );
  return path;
}

type Pair = {
  readonly a: TaskNode;
  readonly b: TaskNode;
  readonly score: number;
  readonly jaccard: number;
  readonly ratio: number;
  readonly kind: "exact" | "intra" | "cross";
};

function taskLoc(node: TaskNode): string {
  return `${node.file}:${node.line} \`^${node.id}\``;
}

function pairLine(pair: Pair): string {
  const hint = pair.kind !== "exact" &&
      commonPrefix(pair.a.tokenSeq, pair.b.tokenSeq) >= 6 &&
      commonPrefix(pair.a.tokenSeq, pair.b.tokenSeq) >=
        0.5 * Math.min(pair.a.tokenSeq.length, pair.b.tokenSeq.length)
    ? " — shared template prefix (distinct findings may share a template; judgment)"
    : "";
  return `  - score ${pair.score.toFixed(2)} (jaccard ${
    pair.jaccard.toFixed(2)
  } / ratio ${pair.ratio.toFixed(2)})${hint}\n    - [\`${
    pair.a.marker || " "
  }\`] ${taskLoc(pair.a)} — "${pair.a.title.slice(0, 140)}"\n    - [\`${
    pair.b.marker || " "
  }\`] ${taskLoc(pair.b)} — "${pair.b.title.slice(0, 140)}"`;
}

async function runCheck2(
  root: string,
  generatedAt: string,
): Promise<{ incomplete: boolean }> {
  const { tasks } = await scanWishDocs(root);
  const intake = await intakeDocs(root);

  const exactGroups = new Map<string, TaskNode[]>();
  for (const node of tasks) {
    const group = exactGroups.get(node.norm) ?? [];
    group.push(node);
    exactGroups.set(node.norm, group);
  }
  const exactPairs: Pair[] = [];
  for (const group of exactGroups.values()) {
    if (group.length < 2 || group[0]?.norm === "") continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a === undefined || b === undefined) continue;
        exactPairs.push({
          a,
          b,
          score: 1,
          jaccard: jaccard(a.tokenSet, b.tokenSet),
          ratio: 1,
          kind: "exact",
        });
      }
    }
  }
  const exactKey = new Set(exactPairs.map((p) => `${p.a.id}|${p.b.id}`));

  const intraPairs: Pair[] = [];
  const byFile = new Map<string, TaskNode[]>();
  for (const node of tasks) {
    const list = byFile.get(node.file) ?? [];
    list.push(node);
    byFile.set(node.file, list);
  }
  for (const nodes of byFile.values()) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a === undefined || b === undefined || a.norm === b.norm) continue;
        if (exactKey.has(`${a.id}|${b.id}`)) continue;
        const jac = jaccard(a.tokenSet, b.tokenSet);
        const ratio = difflibRatio(a.norm, b.norm);
        if (jac >= 0.6 || ratio >= 0.75) {
          intraPairs.push({
            a,
            b,
            score: Math.max(jac, ratio),
            jaccard: jac,
            ratio,
            kind: "intra",
          });
        }
      }
    }
  }

  const crossPairs: Pair[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a === undefined || b === undefined || a.file === b.file) continue;
      if (a.norm === b.norm) continue;
      if (exactKey.has(`${a.id}|${b.id}`)) continue;
      const jac = jaccard(a.tokenSet, b.tokenSet);
      if (jac >= 0.55) {
        crossPairs.push({
          a,
          b,
          score: jac,
          jaccard: jac,
          ratio: 0,
          kind: "cross",
        });
      }
    }
  }

  const overlapPairs: { intake: IntakeDoc; task: TaskNode; score: number }[] =
    [];
  let anchorCiting = 0;
  const anchorExamples: string[] = [];
  for (const doc of intake) {
    if (doc.anchors.length > 0) {
      anchorCiting += 1;
      if (anchorExamples.length < 6) {
        anchorExamples.push(
          `${doc.path} -> ${doc.anchors.slice(0, 3).join(", ")}`,
        );
      }
    }
    for (const node of tasks) {
      const score = jaccard(doc.tokenSet, node.tokenSet);
      if (score >= 0.3) overlapPairs.push({ intake: doc, task: node, score });
    }
  }
  overlapPairs.sort((x, y) => y.score - x.score);

  const body: string[] = [
    `Method: extracted ${tasks.length} task checkbox nodes across \`docs/wish_*.md\``,
    "(regex `- [<marker>] <title> ^t-<id>`); normalized titles (lowercase / whitespace",
    "collapse); exact-duplicate grouping + within-doc near-duplicate scan (token",
    "Jaccard >= 0.60 or difflib ratio >= 0.75) + cross-doc scan (Jaccard >= 0.55);",
    "intake-vs-task overlap via heading/filename-token similarity (>= 0.30) and",
    "anchor citations.",
    "",
    "### Candidate pairs — report only, never merged",
    "",
    `Exact-duplicate pairs (score 1.00): ${exactPairs.length}`,
    ...(exactPairs.slice(0, PAIR_REPORT_MAX).map(pairLine)),
    ...(exactPairs.length > PAIR_REPORT_MAX
      ? [`  … and ${exactPairs.length - PAIR_REPORT_MAX} more`]
      : []),
    "",
    `Near-duplicate pairs, same doc: ${intraPairs.length}`,
    ...(intraPairs.slice(0, PAIR_REPORT_MAX).map(pairLine)),
    ...(intraPairs.length > PAIR_REPORT_MAX
      ? [`  … and ${intraPairs.length - PAIR_REPORT_MAX} more`]
      : []),
    "",
    `Near-duplicate pairs, cross-doc: ${crossPairs.length}`,
    ...(crossPairs.slice(0, PAIR_REPORT_MAX).map(pairLine)),
    ...(crossPairs.length > PAIR_REPORT_MAX
      ? [`  … and ${crossPairs.length - PAIR_REPORT_MAX} more`]
      : []),
    "",
    "### Intake-vs-task overlap",
    "",
    `- Lexical pairs at Jaccard >= 0.30: ${overlapPairs.length} — intake naming is`,
    "  incident-themed while task titles are work-themed; weak channel by design.",
    ...overlapPairs.slice(0, 20).map((pair) =>
      `- score ${pair.score.toFixed(2)} \`${pair.intake.path}\` vs ${
        taskLoc(pair.task)
      }`
    ),
    "",
    `- Intake files citing task anchors (\`t-…\`): ${anchorCiting} of ${intake.length}`,
    "  = proper request->task traceability, not pollution.",
    ...anchorExamples.map((line) => `  - ${line}`),
    "",
    "### Evidence",
    "",
    `- Corpus: ${tasks.length} task nodes across ${byFile.size} wish docs; ${intake.length} intake files.`,
    "- Scan script: `wish_tidy.ts check2`; thresholds ported verbatim from",
    "  `.agent-state/tidy/20261006-wish-tidy-methods-kk.md`.",
  ];
  const path = await upsertReportSection(root, generatedAt, "check2", body);
  console.log(JSON.stringify({
    kind: "wish-tidy.check2",
    ok: true,
    report_path: path,
    section: "check2",
    complete: true,
    stats: {
      task_nodes: tasks.length,
      wish_docs: byFile.size,
      intake_files: intake.length,
      exact_pairs: exactPairs.length,
      intra_pairs: intraPairs.length,
      cross_pairs: crossPairs.length,
      intake_overlap_pairs: overlapPairs.length,
      intake_anchor_citing: anchorCiting,
    },
  }));
  return { incomplete: false };
}

async function runCheck3Light(
  root: string,
  generatedAt: string,
): Promise<{ incomplete: boolean }> {
  const { wishes } = await scanWishDocs(root);
  const core = await coreList(root, "wish");
  const dbStatus = new Map<string, string>();
  for (const row of core.rows) {
    if (typeof row.status === "string") {
      dbStatus.set(row.component_id, row.status);
    }
  }
  const locator = new Map<string, string>();
  for (const row of core.rows) {
    if (typeof row.document_locator === "string") {
      locator.set(row.component_id, row.document_locator);
    }
  }

  const candidates: WishBlock[] = [];
  const closedDoc: WishBlock[] = [];
  const closedDb: WishBlock[] = [];
  const divergence: string[] = [];
  let mixed = 0;
  for (const wish of wishes) {
    const status = dbStatus.get(wish.id) ??
      (core.available ? "unregistered" : "unavailable");
    const allTerminal = wish.tasks.length > 0 &&
      wish.tasks.every((t) =>
        TERMINAL_MARKERS.has(t.marker.toLocaleLowerCase("en-US"))
      );
    const docOpen = wish.closedNote === null;
    const dbTerminal = DB_TERMINAL.has(status);
    if (docOpen !== !dbTerminal) {
      divergence.push(
        `${wish.id} ${wish.file}:${wish.line} — doc ${
          docOpen ? "open" : `closed ("${wish.closedNote}")`
        } vs db ${status}`,
      );
    }
    if (!allTerminal) {
      if (wish.tasks.length > 0) mixed += 1;
      continue;
    }
    if (!docOpen) closedDoc.push(wish);
    else if (dbTerminal) closedDb.push(wish);
    else candidates.push(wish);
  }

  const body: string[] = [
    "Method: per-`^w-` wish block in `docs/wish_*.md`, collect member task markers;",
    "all-terminal = every task `[done]`/`[x]`/`[checked]`/`[dropped]` with >=1 task;",
    '"open" = no COMPLETE/DROPPED/CLOSED annotation in the wish block head.',
    `DB status evidence via \`component.list\` (wf4.sh cli): available=${core.available},`,
    `truncated=${core.truncated} (limit ${COMPONENT_LIMIT})${
      core.note ? ` — ${core.note}` : ""
    }.`,
    "",
    `### wish.complete candidates (open, all tasks terminal) — ${candidates.length}`,
    "",
    "component_id | locator | tasks | db_status",
    ...candidates.map((wish) =>
      `- \`${wish.id}\` ${wish.file}:${wish.line} — ${wish.tasks.length}${
        wish.unanchoredOpen > 0
          ? ` (+${wish.unanchoredOpen} unanchored open checkbox)`
          : ""
      } | ${
        dbStatus.get(wish.id) ??
          (core.available ? "unregistered" : "unavailable")
      }`
    ),
    "",
    `All-terminal but already closed-annotated in doc (excluded — not candidates): ${
      closedDoc.map((w) => `\`${w.id}\` (${w.file}:${w.line})`).join(", ") ||
      "none"
    }.`,
    "",
    `Doc-open + all-terminal but DB-terminal (excluded — doc lags DB): ${
      closedDb.map((w) =>
        `\`${w.id}\` (${w.file}:${w.line}, db=${dbStatus.get(w.id)})`
      ).join(", ") || "none"
    }.`,
    "",
    `${mixed} further wishes have mixed open/terminal tasks — not candidates.`,
    "",
    "### Doc<->DB divergence notes (informational)",
    "",
    ...(divergence.length === 0
      ? ["- none"]
      : divergence.map((line) => `- ${line}`)),
    "- Authoritative checkbox<->DB divergence reporting stays with",
    "  `cutover.bind_preview` (check 3 full, t-01M3ZDYSA7); this list covers only",
    "  the open/closed head annotation vs lifecycle status axis.",
    "",
    "### Caveats for the user review",
    "",
    '- "Open" is inferred from missing close annotation; a `wish.complete` call',
    "  stays user-instruction-only — this section is a review list, not an action",
    "  queue.",
    "- Candidates include umbrella/design wishes; all-terminal tasks do not prove",
    "  the wish's intent closed.",
    "- Membership comes from the doc layer (`component.list` carries no parent",
    "  edge); the doc is the same source `cutover.bind` projects from.",
  ];
  const path = await upsertReportSection(
    root,
    generatedAt,
    "check3-light",
    body,
  );
  console.log(JSON.stringify({
    kind: "wish-tidy.check3-light",
    ok: true,
    report_path: path,
    section: "check3-light",
    complete: core.available && !core.truncated,
    stats: {
      wishes: wishes.length,
      candidates: candidates.length,
      closed_doc: closedDoc.length,
      closed_db: closedDb.length,
      mixed,
      divergence: divergence.length,
      core_available: core.available,
      core_truncated: core.truncated,
    },
  }));
  return { incomplete: !core.available || core.truncated };
}

async function runCheck4(
  root: string,
  generatedAt: string,
): Promise<{ incomplete: boolean }> {
  const dbPath = Deno.env.get("WISH_TIDY_MONITOR_DB") ??
    `${
      Deno.env.get("HOME") ?? ""
    }/.local/state/ai-agents/ai-monitor/state.sqlite`;
  const conditions = await monitorConditions(dbPath);
  const { wishes } = await scanWishDocs(root);

  const terminalCountByFile = new Map<string, number>();
  for (const wish of wishes) {
    const allTerminal = wish.tasks.length > 0 &&
      wish.tasks.every((t) =>
        TERMINAL_MARKERS.has(t.marker.toLocaleLowerCase("en-US"))
      );
    if (allTerminal && wish.closedNote === null) {
      terminalCountByFile.set(
        wish.file,
        (terminalCountByFile.get(wish.file) ?? 0) + 1,
      );
    }
  }

  const flaggedDocs = new Map<string, ConditionRow[]>();
  const flaggedOther = new Map<string, ConditionRow[]>();
  const conform = conditions.rows.filter((r) =>
    r.condition_type.startsWith("conform")
  );
  for (const row of conditions.rows) {
    if (row.scope === "wave") continue;
    const path = row.subject.split(":").slice(1).join(":");
    const target = path.endsWith(".md") || path.startsWith("docs/")
      ? flaggedDocs
      : flaggedOther;
    const list = target.get(path) ?? [];
    list.push(row);
    target.set(path, list);
  }

  const body: string[] = [
    "Inputs consumed (read-only; no own metric):",
    "",
    `- **Bloat sentinel conditions** — \`conditions\` rows where`,
    "  `condition_type LIKE 'bloat%' / 'conform%'` or the matching `wave:*`",
    `  aggregate subjects. Source: \`${dbPath}\``,
    `  (${
      conditions.available
        ? `${conditions.rows.length} rows`
        : `UNAVAILABLE — ${conditions.note}`
    }).`,
    `- **w-01M3QWEE0J conformance output** — ${
      conform.length > 0
        ? `${conform.length} conform* rows present`
        : "ABSENT (evaluator in plan)"
    }.`,
    "",
    "### Conditions observed",
    "",
    ...(conditions.rows.length === 0
      ? ["- none within the declared filter"]
      : conditions.rows.slice(0, 80).map((row) =>
        `- \`${row.condition_type}\` \`${row.scope}/${row.subject}\` state=${row.state} holds_n=${row.holds_n} alerted=${row.alerted} opened=${
          epochToIso(row.opened_at)
        } last=${epochToIso(row.last_seen)}`
      )),
    ...(conditions.rows.length > 80
      ? [`- … and ${conditions.rows.length - 80} more`]
      : []),
    "",
    "### Pollution picture (doc join)",
    "",
    ...(flaggedDocs.size === 0
      ? ["- no flagged doc subjects in scope"]
      : [...flaggedDocs.entries()].map(([path, rows]) => {
        const types = [
          ...new Set(rows.map((r) => `${r.condition_type}=${r.state}`)),
        ].join(", ");
        const sweep = terminalCountByFile.get(path) ?? 0;
        return `- \`${path}\` — ${types}; all-terminal open wishes inside: ${sweep}`;
      })),
    ...[...flaggedOther.entries()].map(([path, rows]) =>
      `- \`${path}\` — ${
        [...new Set(rows.map((r) => `${r.condition_type}=${r.state}`))].join(
          ", ",
        )
      } (component scope — no wish nodes inside)`
    ),
    "- Sweep candidates are the actionable half of a bloat signal: closing",
    "  terminal wishes shrinks doc size and live-wish count together.",
    "",
    "### Boundaries honored",
    "",
    "Read-only consumption: conditions read from monitor state (sqlite3",
    "-readonly), no metric created, no mutation of wish docs / DB / monitor",
    "state.",
  ];
  const path = await upsertReportSection(root, generatedAt, "check4", body);
  console.log(JSON.stringify({
    kind: "wish-tidy.check4",
    ok: true,
    report_path: path,
    section: "check4",
    complete: conditions.available,
    stats: {
      conditions: conditions.rows.length,
      flagged_docs: flaggedDocs.size,
      conform_rows: conform.length,
      monitor_available: conditions.available,
    },
  }));
  return { incomplete: !conditions.available };
}

const parsed = parseArgs(Deno.args);
const root = await repoRoot();
const generatedAt = Deno.env.get("WISH_TIDY_NOW") ?? new Date().toISOString();

if (parsed.mode === "check2") {
  const result = await runCheck2(root, generatedAt);
  if (result.incomplete) Deno.exit(3);
} else if (parsed.mode === "check3-light") {
  const result = await runCheck3Light(root, generatedAt);
  if (result.incomplete) Deno.exit(3);
} else if (parsed.mode === "check4") {
  const result = await runCheck4(root, generatedAt);
  if (result.incomplete) Deno.exit(3);
} else if (parsed.mode === "lineage") {
  const returnsIndex = Deno.env.get("WISH_TIDY_RETURNS_INDEX") ??
    `${Deno.env.get("HOME") ?? ""}/.local/state/ai-agents/returns/index.jsonl`;
  const [intake, decision, returnsIndexRows, git, workflow] = await Promise.all(
    [
      intakeEvidence(root, parsed.query),
      decisionEvidence(root, parsed.query),
      returnsEvidence(returnsIndex, parsed.query),
      gitEvidence(root, parsed.query),
      workflowEvidence(root, parsed.query, parsed.kind),
    ],
  );
  const groups = [intake, decision, returnsIndexRows, git, workflow.events];
  const allEvents = groups.flat().sort((a, b) => {
    const time = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return time || a.source.localeCompare(b.source) ||
      a.evidence.localeCompare(b.evidence);
  });
  const truncated = allEvents.length > MAX_FINDINGS || workflow.truncated;
  const complete = !truncated && workflow.complete;
  const events = allEvents.slice(0, MAX_FINDINGS);
  const outputDir = `${root}/.agent-state/tidy`;
  await Deno.mkdir(outputDir, { recursive: true });
  const reportPath = `${outputDir}/${compactStamp(generatedAt)}-lineage-${
    safeName(parsed.query)
  }.md`;
  await Deno.writeTextFile(
    reportPath,
    report(
      parsed.query,
      parsed.kind,
      generatedAt,
      events,
      truncated,
      groups.map((group) => group.length),
      workflow,
    ),
  );
  console.log(JSON.stringify({
    kind: "wish-tidy.lineage",
    ok: true,
    report_path: reportPath,
    findings: events.length,
    truncated,
    complete,
    bounds: { max_findings: MAX_FINDINGS, observed_findings: allEvents.length },
    sources: {
      intake: groups[0].length,
      decision: groups[1].length,
      returns_index: groups[2].length,
      git: groups[3].length,
      workflow_query: groups[4].length,
    },
  }));
  if (!complete) Deno.exit(3);
}
