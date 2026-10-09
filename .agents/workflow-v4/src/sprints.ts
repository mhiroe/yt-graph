// Sprint (schema 8、docs/candidate/workflow-v4/sprints.md) の pure contract。
//
// **この file は pure である。** SQL / filesystem / clock を触らない。
// Sprint は component aggregate ではなく DB row で、iteration と同じく
// command -> decide -> apply の ledger 経路を通る (domain_events は出さない)。
// ここに置くのは wire / document / registry の形だけ:
//
// - `SprintInfo` / `SprintMember`: response と read が返す row 形。
// - `SprintLookup`: decide が現在 state を読む口 (storage 側が adapter を供給する)。
// - `docs/sprints.md` registry (v2) の parse / render / issue 時の surgical write。
//   **v1 (asakai interim) の registry も parse でだけ読む** — 書き出しは常に v2。
// - `> sprint: <id>` callout key の upsert (`applySprintBinding`) と scan
//   (`scanSprintBindings`)。registry と同じく generated 投影であり、本文は正本ではない。

import { err, ok, type Result } from "./result.ts";
import type { ComponentId } from "./ids.ts";
import type { Revision } from "./components.ts";
import type { IterationInfo, IterationScope } from "./iterations.ts";
import {
  detectNewline,
  frontmatterEnd,
  headingSectionCodec,
  type Line,
  splitLines,
} from "./region.ts";

// ---------------------------------------------------------------------------
// row 形 / lookup
// ---------------------------------------------------------------------------

export const SPRINT_ID_PREFIX = "sp-";
export const SPRINT_ID_PATTERN = /^sp-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `docs/sprints.md` — scope 横断の 1 枚の append-only registry。 */
export const SPRINT_REGISTRY_PATH = "docs/sprints.md";
/** 書き出し側の version。parse は 1 と 2 の両方を読む。 */
export const SPRINT_REGISTRY_VERSION = 2;

/**
 * `sprints` row + join で埋まる派生 field (scope / component_path / label)。
 * `label` は `<iteration label>-<seq 2桁>` — sprint_id とは別の人間向け名。
 */
export type SprintInfo = {
  readonly sprint_id: string;
  readonly iteration_id: string;
  /** 所有 iteration からの派生 (row には持たない)。 */
  readonly scope: IterationScope;
  readonly component_path: string;
  readonly label: string;
  /** iteration 内の順序 (1 から)。iteration を跨いで振り直さない。 */
  readonly seq: number;
  /** repo 全体の発行順。read / audit の並びの正本。 */
  readonly issued_seq: number;
  /** 同じ iteration の前の sprint。最初の 1 件は undefined。 */
  readonly previous_sprint_id?: string;
  readonly goal: string;
  readonly accepted: string;
  readonly baseline_ref?: string;
  readonly issued_at: string;
};

/** 発行時に stamp された roster の 1 件 (immutable)。 */
export type SprintMember = {
  readonly component_id: ComponentId;
  readonly state_revision: number;
};

/**
 * `sprint.issue` の typed payload の roster 1 件。
 * 「この revision を見て member に入れた」を残す同時実行検査の入力。
 */
export type SprintRosterEntry = {
  readonly component_id: ComponentId;
  readonly expected_revision: Revision;
};

/** sprint の人間向け label。`init-01` のように `<iteration label>-<NN>`。 */
export function sprintLabel(
  iteration: Pick<IterationInfo, "name">,
  seq: number,
): string {
  return `${iteration.name}-${String(seq).padStart(2, "0")}`;
}

/**
 * decide が sprint の現在 state を読む口。`IterationLookup` と同じく
 * 「現在 state は storage から渡す」形。
 *
 * - `head(iteration_id)`: `current_sprints` の head pointer。無ければ undefined
 *   (**前の iteration の sprint へは落ちない** — sprint.current の `none` はここ)。
 * - `nextSeq` / `nextIssuedSeq`: 採番の正本。decide / dry-run plan が共有する。
 */
export type SprintLookup = {
  readonly byId: (sprintId: string) => SprintInfo | undefined;
  readonly head: (iterationId: string) => SprintInfo | undefined;
  readonly members: (sprintId: string) => readonly SprintMember[];
  readonly nextSeq: (iterationId: string) => number;
  readonly nextIssuedSeq: () => number;
};

/** `goal` / `accepted` は registry へ 1 行で書く — 改行と連続空白は畳む (v1 と同じ規則)。 */
export function normalizeSprintLine(value: string): string {
  return value.split(/\s+/).filter((part) => part.length > 0).join(" ");
}

// ---------------------------------------------------------------------------
// registry (docs/sprints.md)
// ---------------------------------------------------------------------------
//
// v2 の形:
//
//   ---
//   sprint_registry: 2
//   ---
//   # sprint registry — <repo>
//   ...preamble...
//   ## current
//   - scope: project
//     component_path:
//     iteration: v9
//     iteration_id: it-...
//     sprint_id: sp-...
//     label: v9-01
//   ## sp-01M...
//   - label: v9-01
//   - iteration: v9
//   ...entry fields...
//   - roster:
//     - w-01M... r3
//
// v1 (asakai interim、spec_ai-agent-workflow-v4.md "Sprint registry"): head は
// frontmatter の `current_sprint` / `current_sprint_iteration` /
// `current_sprint_iteration_id` に、entry は scope / component_path / seq / label を
// 持たない。parse は読めるが、欠けた field は undefined のまま残す — 埋めるのは
// repair (scope default の iteration へ畳む裁定) の仕事で、parse は invent しない。

/** `## current` 節の head 1 件 (iteration ごとの現在位置)。 */
export type SprintRegistryHead = {
  readonly scope: IterationScope;
  readonly component_path: string;
  /** iteration の display label。 */
  readonly iteration: string;
  readonly iteration_id: string;
  readonly sprint_id: string;
  readonly label: string;
};

/** `## <sprint_id>` 節 1 件。v1 source では scope / component_path / seq / label が欠ける。 */
export type SprintRegistryEntry = {
  readonly sprint_id: string;
  readonly label?: string;
  readonly iteration: string;
  readonly iteration_id: string;
  readonly scope?: IterationScope;
  readonly component_path?: string;
  readonly seq?: number;
  readonly issued_seq: number;
  readonly previous_sprint_id?: string;
  readonly goal: string;
  readonly issued_at: string;
  readonly baseline_ref?: string;
  readonly accepted: string;
  /**
   * registry の roster は**未検証の text** — component の実在・kind・revision の
   * 検査は adoption (sprint.repair) 側が担うので、ここでは `ComponentId` にしない。
   */
  readonly roster: readonly { component_id: string; state_revision: number }[];
};

export type SprintRegistry = {
  /** file の `sprint_registry:` version (1 = asakai interim head 形)。 */
  readonly version: number;
  readonly heads: readonly SprintRegistryHead[];
  readonly entries: readonly SprintRegistryEntry[];
};

const REGISTRY_ENTRY_FIELDS = [
  "label",
  "iteration",
  "iteration_id",
  "scope",
  "component_path",
  "seq",
  "issued_seq",
  "previous_sprint_id",
  "goal",
  "issued_at",
  "baseline",
  "accepted",
] as const;

/**
 * `key: value` 1 行を parse。`- key: value` (bullet) と `  key: value`
 * (`## current` head の continuation) の両方を受ける。
 * `component_path:` のように空の値は空文字を返す。
 */
function fieldLine(text: string): { key: string; value: string } | undefined {
  const trimmed = text.trim();
  const body = trimmed.startsWith("-") ? trimmed.slice(1).trim() : trimmed;
  const index = body.indexOf(":");
  if (index <= 0) return undefined;
  return { key: body.slice(0, index).trim(), value: body.slice(index + 1).trim() };
}

const REGISTRY_VERSION_PATTERN = /^sprint_registry\s*:/;
const REGISTRY_HEAD_KEYS = [
  "scope",
  "component_path",
  "iteration",
  "iteration_id",
  "sprint_id",
  "label",
] as const;
const ROSTER_LINE = /^-\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+r(\d+)\s*$/;
const NONE_SENTINEL = "none";

/**
 * `docs/sprints.md` を parse する。**v1 / v2 両対応、失敗は err。**
 *
 * fail closed 条件: frontmatter 欠落 / `sprint_registry` が 1・2 以外 / entry の
 * 必須 field 欠落 / `issued_seq` 重複・非整数 / `previous_sprint_id` の指す先が
 * 無い・別 iteration / roster 行の形崩れ。default 値で丸める箇所は無い。
 *
 * `undefined` (file 無し) を渡すと空の v2 registry を返す — 呼び出し側が
 * 「無い file = まだ sprint を発行していない」と見なす既定はここで共有する。
 */
export function parseSprintRegistry(raw: string | undefined): Result<SprintRegistry> {
  const fail = (message: string, path?: string): Result<SprintRegistry> =>
    err("document_structure_unreadable", message, path ?? SPRINT_REGISTRY_PATH);
  if (raw === undefined) {
    return ok({ version: SPRINT_REGISTRY_VERSION, heads: [], entries: [] });
  }
  const lines = splitLines(raw);
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd === 0) {
    return fail(`${SPRINT_REGISTRY_PATH} に frontmatter が無い`);
  }
  let version: number | undefined;
  for (const line of lines) {
    if (line.start >= fmEnd) break;
    if (!REGISTRY_VERSION_PATTERN.test(line.text)) continue;
    const value = line.text.slice(line.text.indexOf(":") + 1).trim();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SPRINT_REGISTRY_VERSION) {
      return fail(`sprint_registry version が解読不能 / 未対応: ${JSON.stringify(value)}`);
    }
    version = parsed;
  }
  if (version === undefined) {
    return fail(`${SPRINT_REGISTRY_PATH} に sprint_registry version が無い`);
  }
  if (version === 1) return parseRegistryV1(lines, fmEnd);
  return parseRegistryV2(lines, fmEnd);
}

/** v1: head は frontmatter の `current_sprint*` 4 key、entry 節は v2 と同じ形 (欠け field あり)。 */
function parseRegistryV1(
  lines: readonly Line[],
  fmEnd: number,
): Result<SprintRegistry> {
  const fail = (message: string): Result<SprintRegistry> =>
    err("document_structure_unreadable", message, SPRINT_REGISTRY_PATH);
  const headFields = new Map<string, string>();
  for (const line of lines) {
    if (line.start >= fmEnd) break;
    const index = line.text.indexOf(":");
    if (index <= 0) continue;
    headFields.set(line.text.slice(0, index).trim(), line.text.slice(index + 1).trim());
  }
  const heads: SprintRegistryHead[] = [];
  const currentSprint = headFields.get("current_sprint");
  if (currentSprint !== undefined && currentSprint !== NONE_SENTINEL) {
    const iterationId = headFields.get("current_sprint_iteration_id");
    if (iterationId === undefined || iterationId === NONE_SENTINEL) {
      return fail("v1 head の current_sprint_iteration_id が無い");
    }
    heads.push({
      scope: "project",
      component_path: "",
      iteration: headFields.get("current_sprint_iteration") ?? "",
      iteration_id: iterationId,
      sprint_id: currentSprint,
      // v1 head に label は無い。entry 側 (同じく欠落) と合わせて repair が派生する。
      label: "",
    });
  }
  const entries = parseRegistryEntries(lines, fmEnd);
  if (!entries.ok) return entries;
  return ok({ version: 1, heads, entries: entries.value });
}

function parseRegistryV2(
  lines: readonly Line[],
  fmEnd: number,
): Result<SprintRegistry> {
  const fail = (message: string): Result<SprintRegistry> =>
    err("document_structure_unreadable", message, SPRINT_REGISTRY_PATH);
  const heads: SprintRegistryHead[] = [];
  // `## ` 節の境界を先に切る。`## current` と `## sp-*` だけを読み、それ以外の
  // `## ` 節は generated file への書き損じとして fail closed にする。
  const sections: { title: string; from: number; to: number }[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.start < fmEnd) continue;
    if (!line.text.startsWith("## ")) continue;
    sections.push({ title: line.text.slice(3).trim(), from: index, to: lines.length });
    const prev = sections[sections.length - 2];
    if (prev !== undefined) prev.to = index;
  }
  const entryRanges: { id: string; from: number; to: number }[] = [];
  for (const section of sections) {
    if (section.title === "current") {
      let head: Record<string, string> | undefined;
      const closeHead = (): Result<void> => {
        if (head === undefined) return ok(undefined);
        for (const key of REGISTRY_HEAD_KEYS) {
          if (key === "component_path") {
            if (head[key] === undefined) head[key] = "";
            continue;
          }
          if (head[key] === undefined) {
            return err(
              "document_structure_unreadable",
              `## current の head に ${key} が無い`,
              SPRINT_REGISTRY_PATH,
            );
          }
        }
        heads.push({
          scope: head["scope"] === "component" ? "component" : "project",
          component_path: head["component_path"] ?? "",
          iteration: head["iteration"] ?? "",
          iteration_id: head["iteration_id"] ?? "",
          sprint_id: head["sprint_id"] ?? "",
          label: head["label"] ?? "",
        });
        return ok(undefined);
      };
      for (let i = section.from + 1; i < section.to; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.text.trim().length === 0) continue;
        const field = fieldLine(line.text);
        if (field === undefined) {
          return fail(`## current の解読不能な行: ${line.text.trim()}`);
        }
        // head の境界は `- scope:` bullet — continuation の `  key:` は indent がある。
        if (line.text.trimStart().startsWith("-") && field.key === "scope") {
          const closed = closeHead();
          if (!closed.ok) return closed;
          head = {};
        }
        if (head === undefined) {
          return fail(`## current の先頭が head bullet ではない: ${line.text.trim()}`);
        }
        if (!(REGISTRY_HEAD_KEYS as readonly string[]).includes(field.key)) {
          return fail(`## current に未知の key: ${field.key}`);
        }
        head[field.key] = field.value;
      }
      const closed = closeHead();
      if (!closed.ok) return closed;
      continue;
    }
    if (!section.title.startsWith(SPRINT_ID_PREFIX) || !SPRINT_ID_PATTERN.test(section.title)) {
      return fail(`registry の節は ## current か ## sp-* のみ: ${section.title}`);
    }
    entryRanges.push({ id: section.title, from: section.from, to: section.to });
  }
  const entries = parseEntryRanges(lines, entryRanges);
  if (!entries.ok) return entries;
  return ok({ version: 2, heads, entries: entries.value });
}

/** v1/v2 共通の `## sp-*` 節 parse。`section.title` を持たない側 (v1) は `## ` 走査から拾う。 */
function parseRegistryEntries(
  lines: readonly Line[],
  fmEnd: number,
): Result<readonly SprintRegistryEntry[]> {
  const ranges: { id: string; from: number; to: number }[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.start < fmEnd) continue;
    if (!line.text.startsWith("## ")) continue;
    const id = line.text.slice(3).trim();
    const prev = ranges.at(-1);
    if (prev !== undefined) prev.to = index;
    ranges.push({ id, from: index, to: lines.length });
  }
  for (const range of ranges) {
    if (!SPRINT_ID_PATTERN.test(range.id)) {
      return err(
        "document_structure_unreadable",
        `registry の節は ## sp-* のみ (v1): ${range.id}`,
        SPRINT_REGISTRY_PATH,
      );
    }
  }
  return parseEntryRanges(lines, ranges);
}

function parseEntryRanges(
  lines: readonly Line[],
  ranges: readonly { id: string; from: number; to: number }[],
): Result<readonly SprintRegistryEntry[]> {
  const fail = (message: string): Result<readonly SprintRegistryEntry[]> =>
    err("document_structure_unreadable", message, SPRINT_REGISTRY_PATH);
  const entries: SprintRegistryEntry[] = [];
  const issuedSeqs = new Set<number>();
  const ids = new Set<string>();
  for (const range of ranges) {
    const fields = new Map<string, string>();
    const roster: { component_id: string; state_revision: number }[] = [];
    let inRoster = false;
    for (let i = range.from + 1; i < range.to; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const text = line.text;
      if (inRoster) {
        const member = /^\s+-\s/.test(text) ? ROSTER_LINE.exec(text.trimStart()) : null;
        if (member !== null) {
          roster.push({
            component_id: member[1] ?? "",
            state_revision: Number(member[2] ?? "0"),
          });
          continue;
        }
        inRoster = false;
      }
      if (/^\s*$/.test(text)) continue;
      const field = fieldLine(text);
      if (field !== undefined && field.key === "roster") {
        inRoster = true;
        continue;
      }
      if (field === undefined || /^\s/.test(text)) {
        return fail(`## ${range.id}: 解読不能な行: ${text.trim()}`);
      }
      if (
        !(REGISTRY_ENTRY_FIELDS as readonly string[]).includes(field.key) &&
        field.key !== "roster"
      ) {
        return fail(`## ${range.id}: 未知の key: ${field.key}`);
      }
      if (fields.has(field.key)) {
        return fail(`## ${range.id}: key ${field.key} が重複している`);
      }
      fields.set(field.key, field.value);
    }
    const required = ["iteration", "iteration_id", "issued_seq", "goal", "issued_at", "accepted"];
    for (const key of required) {
      if (fields.get(key) === undefined || fields.get(key) === "") {
        return fail(`## ${range.id}: ${key} が無い`);
      }
    }
    const issuedSeq = Number(fields.get("issued_seq") ?? "");
    if (!Number.isInteger(issuedSeq) || issuedSeq < 1) {
      return fail(`## ${range.id}: issued_seq が非整数: ${fields.get("issued_seq") ?? ""}`);
    }
    if (issuedSeqs.has(issuedSeq)) {
      return fail(`issued_seq ${issuedSeq} が重複している`);
    }
    issuedSeqs.add(issuedSeq);
    if (ids.has(range.id)) {
      return fail(`sprint_id ${range.id} の節が重複している`);
    }
    ids.add(range.id);
    const seqRaw = fields.get("seq");
    const seq = seqRaw === undefined ? undefined : Number(seqRaw);
    if (seq !== undefined && (!Number.isInteger(seq) || seq < 1)) {
      return fail(`## ${range.id}: seq が非整数: ${seqRaw}`);
    }
    const scopeRaw = fields.get("scope");
    if (scopeRaw !== undefined && scopeRaw !== "project" && scopeRaw !== "component") {
      return fail(`## ${range.id}: scope が解読不能: ${scopeRaw}`);
    }
    const previous = fields.get("previous_sprint_id");
    const baseline = fields.get("baseline");
    entries.push({
      sprint_id: range.id,
      ...(fields.get("label") === undefined ? {} : { label: fields.get("label") ?? "" }),
      iteration: fields.get("iteration") ?? "",
      iteration_id: fields.get("iteration_id") ?? "",
      ...(scopeRaw === undefined ? {} : { scope: scopeRaw as IterationScope }),
      ...(fields.get("component_path") === undefined
        ? {}
        : { component_path: fields.get("component_path") ?? "" }),
      ...(seq === undefined ? {} : { seq }),
      issued_seq: issuedSeq,
      ...(previous === undefined || previous === NONE_SENTINEL
        ? {}
        : { previous_sprint_id: previous }),
      goal: fields.get("goal") ?? "",
      issued_at: fields.get("issued_at") ?? "",
      ...(baseline === undefined || baseline === NONE_SENTINEL ? {} : { baseline_ref: baseline }),
      accepted: fields.get("accepted") ?? "",
      roster,
    });
  }
  // previous_sprint_id の鎖検査: 指す先が entries に在ること、同じ iteration 内であること。
  // file 内だけで閉じる検査なのでここで畳む (DB との整合は repair 側)。
  for (const entry of entries) {
    if (entry.previous_sprint_id === undefined) continue;
    const previous = entries.find((other) => other.sprint_id === entry.previous_sprint_id);
    if (previous === undefined) {
      return fail(`## ${entry.sprint_id}: previous_sprint_id ${entry.previous_sprint_id} が無い`);
    }
    if (previous.iteration_id !== entry.iteration_id) {
      return fail(
        `## ${entry.sprint_id}: previous_sprint_id が別 iteration を指す ` +
          `(${previous.iteration_id} != ${entry.iteration_id})`,
      );
    }
  }
  return ok(entries);
}

/** `## current` head 1 件の render。 */
function renderHead(head: SprintRegistryHead): string {
  return `- scope: ${head.scope}\n` +
    `  component_path: ${head.component_path}\n` +
    `  iteration: ${head.iteration}\n` +
    `  iteration_id: ${head.iteration_id}\n` +
    `  sprint_id: ${head.sprint_id}\n` +
    `  label: ${head.label}\n`;
}

/** `## <sprint_id>` entry 1 件の render (v2 形 — 全 field を書く)。 */
export function renderSprintEntry(entry: SprintRegistryEntry): string {
  const fields: [string, string][] = [
    ["label", entry.label ?? ""],
    ["iteration", entry.iteration],
    ["iteration_id", entry.iteration_id],
    ["scope", entry.scope ?? "project"],
    ["component_path", entry.component_path ?? ""],
    ["seq", String(entry.seq ?? "")],
    ["issued_seq", String(entry.issued_seq)],
    ["previous_sprint_id", entry.previous_sprint_id ?? NONE_SENTINEL],
    ["goal", entry.goal],
    ["issued_at", entry.issued_at],
    ["baseline", entry.baseline_ref ?? NONE_SENTINEL],
    ["accepted", entry.accepted],
  ];
  const body = fields.map(([key, value]) => `- ${key}: ${value}\n`).join("");
  const roster = entry.roster
    .map((member) => `  - ${member.component_id} r${member.state_revision}\n`)
    .join("");
  return `## ${entry.sprint_id}\n${body}- roster:\n${roster}`;
}

const REGISTRY_PREAMBLE = `# sprint registry — {repo}

Append-only. Each \`##\` entry is one issued Sprint (Sprint = immutable roster
of iteration members + one-line goal). The \`## current\` section holds the
head pointer per iteration. Never edit or delete an entry by hand; \`sprint:\`
keys in each bound component's \`[!meta]\` callout carry the binding.
Contract: dotfiles \`docs/candidate/workflow-v4/sprints.md\`.
`;

/**
 * registry 全体を v2 の canonical 形で render する (sprint.repair の DB -> fs 再投影用)。
 * issue 時の surgical write は `applySprintIssueText` を使う — こちらは全件を一貫した
 * 形で書き切るので、v1 source や手編集の残滓を canonical へ畳む。
 */
export function renderSprintRegistry(
  repositoryLabel: string,
  heads: readonly SprintRegistryHead[],
  entries: readonly SprintRegistryEntry[],
): string {
  const ordered = [...entries].sort((a, b) => a.issued_seq - b.issued_seq);
  let out = `---\nsprint_registry: ${SPRINT_REGISTRY_VERSION}\n---\n\n`;
  out += REGISTRY_PREAMBLE.replace("{repo}", repositoryLabel);
  out += "\n## current\n";
  for (const head of heads) out += renderHead(head);
  for (const entry of ordered) out += `\n${renderSprintEntry(entry)}`;
  return out;
}

/**
 * 既存 registry (v1/v2/不在) へ issue 1 件を反映した新しい本文を返す。
 *
 * surgical にやること: frontmatter を `sprint_registry: 2` のみに畳み直し、
 * `## current` 節を heads で置き換え (無ければ最初の `## ` 節の直前へ挿入)、
 * entry を末尾へ append。**既存の entry 節は残す** — registry は正本の投影だが、
 * generated file としての既存内容を書き損じで消さない限り温存する。
 *
 * `existing` が v1 の場合は entries をそのまま温存したまま head 形だけ v2 へ上げる
 * (v1 frontmatter head keys は消え、`## current` が正本になる)。
 */
export function applySprintIssueText(
  existing: string | undefined,
  repositoryLabel: string,
  heads: readonly SprintRegistryHead[],
  entry: SprintRegistryEntry,
): Result<{ raw: string; changed: boolean }> {
  if (existing === undefined || existing.trim().length === 0) {
    return ok({
      raw: renderSprintRegistry(repositoryLabel, heads, [entry]),
      changed: true,
    });
  }
  const parsed = parseSprintRegistry(existing);
  if (!parsed.ok) return parsed;
  const newline = detectNewline(existing);
  const lines = splitLines(existing);
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd === 0) {
    return err(
      "document_structure_unreadable",
      `${SPRINT_REGISTRY_PATH} に frontmatter が無い`,
      SPRINT_REGISTRY_PATH,
    );
  }

  // `## current` 節の行 index 範囲と、最初の `## ` entry 節の index。
  let currentFrom = -1;
  let currentTo = -1;
  let firstEntryHeading = -1;
  for (const [index, line] of lines.entries()) {
    if (line.start < fmEnd) continue;
    if (!line.text.startsWith("## ")) continue;
    const title = line.text.slice(3).trim();
    if (title === "current") {
      currentFrom = index;
      continue;
    }
    if (currentFrom !== -1 && currentTo === -1) currentTo = index;
    if (firstEntryHeading === -1) firstEntryHeading = index;
  }
  if (currentFrom !== -1 && currentTo === -1) currentTo = lines.length;

  const headLines = [
    "## current",
    ...heads.flatMap((head) => renderHead(head).trimEnd().split("\n")),
  ];
  const entryLines = renderSprintEntry(entry).trimEnd().split("\n");

  // frontmatter は version だけへ畳み直す。`## current` は同位置へ差し替え、
  // 節が無ければ最初の `## ` 節の直前 (それも無ければ末尾) へ挿入する。
  const out: string[] = ["---", `sprint_registry: ${SPRINT_REGISTRY_VERSION}`, "---"];
  let inserted = false;
  for (const [index, line] of lines.entries()) {
    if (line.start < fmEnd) continue;
    if (index === currentFrom) {
      out.push(...headLines);
      inserted = true;
      continue;
    }
    if (currentFrom !== -1 && index > currentFrom && index < currentTo) continue;
    if (currentFrom === -1 && !inserted && index === firstEntryHeading) {
      out.push("", ...headLines, "");
      inserted = true;
    }
    out.push(line.text);
  }
  if (!inserted) out.push("", ...headLines);
  while (out.length > 0 && (out.at(-1) ?? "").trim() === "") out.pop();
  out.push("", "", ...entryLines, "");
  return ok({ raw: out.join(newline), changed: true });
}

// ---------------------------------------------------------------------------
// `> sprint: <id>` callout key
// ---------------------------------------------------------------------------

const SPRINT_KEY_LINE = /^[ \t]*>[ \t]*sprint[ \t]*:/;

/**
 * component の `[!meta]` callout 内の `> sprint:` key を upsert する。
 *
 * - component の node は `headingSectionCodec.listSections` の anchor で引く
 *   (file root / heading 両方 — `^<id>` が identity block に在る形だけが対象)。
 * - callout が無ければ `^<id>` の直前へ `> [!meta]- <id>` + `> sprint:` を作る
 *   (identity block の形は region.ts の裁定に揃える)。
 * - 同一 id の anchor が 2 か所 / callout title が id と違う / anchor が
 *   section の外 (unclaimed) なら fail closed — 推測で書き場を選ばない。
 *
 * `> sprint:` の値が既に `sprintId` と同じなら `changed: false`。
 */
export function applySprintBinding(
  raw: string,
  componentId: ComponentId,
  sprintId: string,
): Result<{ raw: string; changed: boolean }> {
  const listing = headingSectionCodec.listSections(raw);
  if (!listing.ok) return listing;
  const hits = listing.value.sections.filter((section) => section.anchor?.id === componentId);
  if (hits.length > 1) {
    return err("ambiguous_locator", `^${componentId} anchor が ${hits.length} か所にある`);
  }
  const section = hits[0];
  if (section === undefined) {
    if (listing.value.unclaimed_anchors.some((anchor) => anchor.id === componentId)) {
      return err(
        "document_structure_unreadable",
        `^${componentId} は node の identity block の外にある (unclaimed) — sprint key の置き場を推測しない`,
      );
    }
    return err("document_not_found", `^${componentId} anchor が見つからない`);
  }
  const lines = splitLines(raw).filter((line) =>
    line.start >= section.identity.start && line.start < section.identity.end
  );
  const newline = detectNewline(raw);
  const META_OPEN = /^[ \t]{0,3}>[ \t]*\[!meta\][-+]?[ \t]*(.*?)[ \t]*$/i;
  const QUOTE = /^[ \t]{0,3}>/;
  const openIndex = lines.findIndex((line) => META_OPEN.test(line.text));
  if (openIndex === -1) {
    // callout 無し — anchor 行の直前へ `> [!meta]- <id>` と `> sprint:` を挿入する。
    const anchor = section.anchor;
    if (anchor === undefined) {
      return err("document_structure_unreadable", `^${componentId} の位置を特定できない`);
    }
    const insertion = `> [!meta]- ${componentId}${newline}> sprint: ${sprintId}${newline}`;
    const next = raw.slice(0, anchor.span.start) + insertion + raw.slice(anchor.span.start);
    return ok({ raw: next, changed: true });
  }
  const openLine = lines[openIndex];
  if (openLine === undefined) {
    return err("document_structure_unreadable", "callout 行を読めない");
  }
  const title = (META_OPEN.exec(openLine.text)?.[1] ?? "").trim();
  if (title !== componentId) {
    return err(
      "document_region_contains_foreign_identity",
      `^${componentId} の identity block の callout は ${title} のもの — 書き混ぜない`,
    );
  }
  // callout run の終端 (連続する `>` 行) を探し、その中の `sprint:` key を upsert。
  let runEnd = openIndex;
  while (runEnd + 1 < lines.length && QUOTE.test(lines[runEnd + 1]?.text ?? "")) runEnd += 1;
  const indentMatch = /^([ \t]*)>/.exec(openLine.text);
  const indent = `${indentMatch?.[1] ?? ""}`;
  const sprintIndexes: number[] = [];
  for (let i = openIndex + 1; i <= runEnd; i += 1) {
    if (SPRINT_KEY_LINE.test(lines[i]?.text ?? "")) sprintIndexes.push(i);
  }
  if (sprintIndexes.length > 1) {
    return err(
      "document_structure_unreadable",
      `^${componentId} の callout に sprint: が ${sprintIndexes.length} 行ある`,
    );
  }
  const existing = sprintIndexes[0];
  if (existing !== undefined) {
    const line = lines[existing];
    if (line === undefined) {
      return err("document_structure_unreadable", "sprint: 行を読めない");
    }
    if (line.text.trim() === `> sprint: ${sprintId}`) return ok({ raw, changed: false });
    const next = raw.slice(0, line.start) + `${indent}> sprint: ${sprintId}` +
      raw.slice(line.end);
    return ok({ raw: next, changed: true });
  }
  // open 行の直後へ挿入。
  const next = raw.slice(0, openLine.next) + `${indent}> sprint: ${sprintId}${newline}` +
    raw.slice(openLine.next);
  return ok({ raw: next, changed: true });
}

/**
 * file 内の全 component の `> sprint:` 値を拾う (audit / repair の scan 側)。
 * `[!meta]` callout の title を component id として読む — anchor が無い node の
 * callout も拾えるよう section ではなく行走査で取る。
 */
export function scanSprintBindings(
  raw: string,
): readonly { component_id: string; sprint_id: string }[] {
  const lines = splitLines(raw);
  const fmEnd = frontmatterEnd(lines);
  const META_OPEN = /^[ \t]{0,3}>[ \t]*\[!meta\][-+]?[ \t]*(.*?)[ \t]*$/i;
  const QUOTE = /^[ \t]{0,3}>/;
  const bindings: { component_id: string; sprint_id: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.start < fmEnd) continue;
    const open = META_OPEN.exec(line.text);
    if (open === null) continue;
    const componentId = (open[1] ?? "").trim();
    for (let i = index + 1; i < lines.length; i += 1) {
      const inner = lines[i];
      if (inner === undefined || !QUOTE.test(inner.text)) break;
      if (!SPRINT_KEY_LINE.test(inner.text)) continue;
      const value = inner.text.slice(inner.text.indexOf(":") + 1).trim();
      if (componentId.length > 0 && value.length > 0) {
        bindings.push({ component_id: componentId, sprint_id: value });
      }
    }
  }
  return bindings;
}
