// iteration (schema 7、docs/candidate/workflow-v4/iterations.md) の pure contract。
//
// iteration は component aggregate ではなく DB row。dir 名は caller が渡す自由 label で
// display に過ぎない。順序の正本は `seq`、系譜は `predecessor_iteration_id`、
// `created_at` / `last_modified` は Core clock が stamp する (終了 stamp は存在しない)。
// いずれの op も domain_events を出さない (この cut では replication 対象外)。
//
// **複数の iteration が同時に active になり得る** (user 裁定 2026-09-23)。
// active set の正本は `active_iterations`、default はその `is_default` (optional)。
// `current` symlink は default が在る時だけ存在する派生 state。
//
// Markdown frontmatter の 3 key (`iteration` / `iteration_label` / `iteration_created`) は
// **generated property**。正本は DB の membership で、file への写しは projection の責務。
// 古い値が残っていたら projection の bug であり、第二の正本ではない。

import { err, ok, type Result } from "./result.ts";
import { detectNewline, frontmatterEnd, spliceSpan, splitLines } from "./region.ts";

// ---------------------------------------------------------------------------
// scope / label
// ---------------------------------------------------------------------------

export const ITERATION_SCOPES = ["project", "component"] as const;
export type IterationScope = (typeof ITERATION_SCOPES)[number];

export function parseIterationScope(value: unknown, path?: string): Result<IterationScope> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "scope は string である必要がある", path);
  }
  const scope = ITERATION_SCOPES.find((candidate) => candidate === value);
  if (scope === undefined) {
    return err(
      "invalid_iteration_scope",
      `未知の iteration scope: ${JSON.stringify(value)} (project | component)`,
      path,
    );
  }
  return ok(scope);
}

/**
 * dir 名として使える label の形。`^[a-z0-9][a-z0-9-]*$`。
 *
 * **順序を名から読ませないための制約ではなく、path / symlink を安全に保つための制約。**
 * 順序の正本は `seq` であり、label の lexical 順に意味は無い。
 */
export const ITERATION_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * iteration dir と同じ階層に在る名前。label として使うと dir が衝突するので予約する。
 * `active` は schema 7 の active link dir (`<component>/active/<label>`)。
 */
export const RESERVED_ITERATION_LABELS = ["current", "docs", "spec", "app", "active"] as const;

export function validateIterationLabel(value: unknown, path?: string): Result<string> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "label は string である必要がある", path);
  }
  if (!ITERATION_LABEL_PATTERN.test(value)) {
    return err(
      "invalid_iteration_label",
      `label は ^[a-z0-9][a-z0-9-]*$ の単一 path segment である必要がある: ${
        JSON.stringify(value)
      }`,
      path,
    );
  }
  if ((RESERVED_ITERATION_LABELS as readonly string[]).includes(value)) {
    return err(
      "reserved_iteration_label",
      `label ${JSON.stringify(value)} は予約名 (${RESERVED_ITERATION_LABELS.join(" | ")})`,
      path,
    );
  }
  return ok(value);
}

/**
 * `component_path` の検査。label より緩い (`.` / `_` も許す) が、**repo root を出る形は
 * 受けない**: 空、絶対 path、`..` segment、空 segment は拒否する。
 */
export function validateComponentPath(value: unknown, path?: string): Result<string> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "component_path は string である必要がある", path);
  }
  const segments = value.split("/");
  const valid = value.length > 0 &&
    segments.every((segment) => /^[a-z0-9][a-z0-9._-]*$/.test(segment) && segment !== "..");
  if (!valid) {
    return err(
      "invalid_component_path",
      `component_path は repo 内の安全な相対 dir である必要がある: ${JSON.stringify(value)}`,
      path,
    );
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// row shape / layout
// ---------------------------------------------------------------------------

/**
 * `iterations` の 1 行。`component_path` は project scope では空文字列 (schema と同じ)。
 * schema 7: `closed_at` は存在しない — iteration が持つのは `created_at` と
 * `last_modified` だけで、終了を表す stamp は無い。
 */
export type IterationInfo = {
  readonly iteration_id: string;
  readonly scope: IterationScope;
  readonly component_path: string;
  readonly name: string;
  readonly seq: number;
  readonly predecessor_iteration_id?: string;
  readonly created_at: string;
  readonly last_modified: string;
  readonly disposed_at?: string;
};

/** iteration dir がぶら下がる親 dir。project scope は `docs/iterations/` に置く。 */
export function iterationBaseDir(scope: IterationScope, componentPath: string): string {
  return scope === "project" ? "docs/iterations" : componentPath;
}

/** `<component>/<label>` / `docs/iterations/<label>`。 */
export function iterationDirOf(
  iteration: Pick<IterationInfo, "scope" | "component_path" | "name">,
): string {
  return `${iterationBaseDir(iteration.scope, iteration.component_path)}/${iteration.name}`;
}

/**
 * DB が正本で、symlink は派生。`<component>/current` / `docs/current`。
 *
 * **project scope の current は `docs/iterations/` の外に置く** (`docs/current`)。
 * `docs/iterations/` の中に置くと `current` が iteration dir と同じ階層に立ち、
 * scanner / human が「iterations 一覧の中の 1 dir」として読んでしまう。
 */
export function currentLinkPath(scope: IterationScope, componentPath: string): string {
  return scope === "project" ? "docs/current" : `${componentPath}/current`;
}

/**
 * active set の link dir の中の 1 link。`<component>/active/<label>` /
 * `docs/active/<label>`。**active な iteration ごとに 1 本**あり、default かどうかと
 * 無関係に存在する (current は default の時だけ)。
 */
export function activeLinkPath(
  scope: IterationScope,
  componentPath: string,
  label: string,
): string {
  const dir = scope === "project" ? "docs/active" : `${componentPath}/active`;
  return `${dir}/${label}`;
}

/** iteration dir の直下にぶら下がる骨格 dir。両 scope で同じ形にする。 */
export const ITERATION_SKELETON_DIRS = ["docs", "spec", "app"] as const;

/**
 * locator の path 部がどの iteration dir の中にあるか。
 *
 * **一致規則は `<dir>/{docs|spec|app}/...` だけ。**`<dir>` 直下の file (README 等) は
 * iteration の中身とは見なさない。membership の推測には使わず、birth の判定だけに使う。
 */
export function iterationContainingPath(
  path: string,
  iterations: readonly IterationInfo[],
): IterationInfo | undefined {
  const plain = path.split("#", 1)[0] ?? path;
  for (const iteration of iterations) {
    const dir = `${iterationDirOf(iteration)}/`;
    if (!plain.startsWith(dir)) continue;
    const inner = plain.slice(dir.length).split("/", 1)[0] ?? "";
    if ((ITERATION_SKELETON_DIRS as readonly string[]).includes(inner)) return iteration;
  }
  return undefined;
}

/**
 * `<iterDir>` 内で member file を再露出する link の置き場所。canonical path の
 * 直前 dir (`docs` / `spec` / `app`) を引き継ぎ、それ以外は `docs/` へ置く。
 * `#` 以降の fragment は落とす。
 */
export function memberLinkPath(iterDir: string, canonicalPath: string): string {
  const plain = canonicalPath.split("#", 1)[0] ?? canonicalPath;
  const segments = plain.split("/").filter((segment) => segment.length > 0);
  const name = segments.at(-1) ?? plain;
  const parent = segments.at(-2);
  const sub = parent === "spec" || parent === "app" ? parent : "docs";
  return `${iterDir}/${sub}/${name}`;
}

/**
 * `link` の dir から `target` への相対 path (symlink の中身として書く値)。
 * 両方 repo root 相対で受ける。`..` segment は挿入するが link 自身の位置からの
 * 計算なので escape 判定は呼び出し側の path 検査が担う。
 */
export function relativeSymlinkTarget(link: string, target: string): string {
  const from = link.split("/").slice(0, -1);
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  const ups = Array.from({ length: from.length - common }, () => "..");
  const rest = to.slice(common);
  const rel = [...ups, ...rest].join("/");
  return rel === "" ? target : rel;
}

// ---------------------------------------------------------------------------
// generated frontmatter property
// ---------------------------------------------------------------------------

/** file root の frontmatter に書く 3 つの generated key。人は書かない。 */
export const ITERATION_PROPERTY_KEYS = [
  "iteration",
  "iteration_label",
  "iteration_created",
] as const;

export type IterationProperties = {
  /** `iterations.seq` (numeric)。Bases の比較・sort が効く形。 */
  readonly iteration: number;
  readonly iteration_label: string;
  readonly iteration_created: string;
};

export function iterationPropertiesOf(
  iteration: Pick<IterationInfo, "seq" | "name" | "created_at">,
): IterationProperties {
  return {
    iteration: iteration.seq,
    iteration_label: iteration.name,
    iteration_created: iteration.created_at,
  };
}

const ITERATION_KEY_PATTERN = /^(iteration|iteration_label|iteration_created)\s*:/;

/** 1 行が generated key のどれかなら key 名を返す。 */
function iterationKeyOf(text: string): string | undefined {
  const matched = ITERATION_KEY_PATTERN.exec(text);
  return matched?.[1];
}

/**
 * frontmatter から generated key の現在値を読む (audit の比較経路)。
 * frontmatter 自体が無ければ undefined。key が無い file は空 object。
 */
export function readIterationProperties(raw: string): Partial<IterationProperties> | undefined {
  const lines = splitLines(raw);
  if (frontmatterEnd(lines) === 0) return undefined;
  const found: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.text.trim() === "---") break;
    const key = iterationKeyOf(line.text);
    if (key === undefined) continue;
    const value = line.text.slice(line.text.indexOf(":") + 1).trim();
    // 引用符は generated 側が出さないが、人が書いた残滓は剥がして読む。
    found[key] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  // IterationProperties は readonly なので、local に組んでから 1 回で返す。
  const seq = found["iteration"];
  const parsedSeq = seq === undefined ? undefined : Number(seq);
  return {
    // 読めない値も audit が差分として拾えるよう -1 で残す。
    ...(seq === undefined
      ? {}
      : { iteration: parsedSeq !== undefined && Number.isInteger(parsedSeq) ? parsedSeq : -1 }),
    ...(found["iteration_label"] === undefined
      ? {}
      : { iteration_label: found["iteration_label"] }),
    ...(found["iteration_created"] === undefined
      ? {}
      : { iteration_created: found["iteration_created"] }),
  };
}

/**
 * generated 3 key を frontmatter へ surgical に upsert する。
 *
 * - 既存の key はその行だけを置き換える。無い key は閉じ `---` の直前へ追加する。
 * - `kind` / `children` / `tags` / `^<id>` など、generated でない行は一切触らない。
 * - 同じ key が 2 行以上ある形は読み間違いを避けて `document_structure_unreadable` で止める。
 * - frontmatter が無い file は `frontmatter_missing` (本文を壊してまで書かない)。
 */
export function applyIterationProperties(
  raw: string,
  properties: IterationProperties,
): Result<{ raw: string; changed: boolean }> {
  const lines = splitLines(raw);
  if (frontmatterEnd(lines) === 0) {
    return err(
      "frontmatter_missing",
      "generated iteration key を書く frontmatter が無い",
      "frontmatter",
    );
  }
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.text.trim() === "---");
  if (closeIndex <= 0) {
    return err(
      "document_structure_unreadable",
      "frontmatter の閉じ行を特定できない",
      "frontmatter",
    );
  }

  const desired: Record<string, string> = {
    iteration: `iteration: ${properties.iteration}`,
    iteration_label: `iteration_label: ${properties.iteration_label}`,
    iteration_created: `iteration_created: ${properties.iteration_created}`,
  };

  // 既存行の index を key ごとに集める。重複は fail closed。
  const present = new Map<string, number[]>();
  for (let i = 1; i < closeIndex; i += 1) {
    const key = iterationKeyOf(lines[i]?.text ?? "");
    if (key === undefined) continue;
    const indexes = present.get(key) ?? [];
    indexes.push(i);
    present.set(key, indexes);
  }
  for (const [key, indexes] of present) {
    if (indexes.length > 1) {
      return err(
        "document_structure_unreadable",
        `generated key ${key} が frontmatter に重複して在る`,
        "frontmatter",
      );
    }
  }

  const newline = detectNewline(raw);
  let changed = false;
  // 行単位の置換を末尾から順に行う (offset が前からずれないように)。
  const edits: { index: number; text: string }[] = [];
  const missing: string[] = [];
  for (const [key, text] of Object.entries(desired)) {
    const existing = present.get(key)?.[0];
    if (existing === undefined) {
      missing.push(text);
      continue;
    }
    const current = lines[existing];
    if (current === undefined) continue;
    if (current.text === text) continue;
    edits.push({ index: existing, text });
    changed = true;
  }
  if (missing.length > 0) changed = true;
  if (!changed) return ok({ raw, changed: false });

  let next = raw;
  for (const edit of edits.sort((a, b) => b.index - a.index)) {
    const line = lines[edit.index];
    if (line === undefined) continue;
    next = spliceSpan(next, { start: line.start, end: line.next }, `${edit.text}${newline}`);
  }
  if (missing.length > 0) {
    const close = lines[closeIndex];
    if (close === undefined) {
      return err(
        "document_structure_unreadable",
        "frontmatter の閉じ行を特定できない",
        "frontmatter",
      );
    }
    next = spliceSpan(
      next,
      { start: close.start, end: close.start },
      `${missing.join(newline)}${newline}`,
    );
  }
  return ok({ raw: next, changed: true });
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

/**
 * decide が iteration の現在 state を読む口。`ComponentLookup` と同じく
 * 「現在 state は storage から渡す」形。storage を持たない consumer は fake を置ける。
 */
export type IterationLookup = {
  readonly byId: (iterationId: string) => IterationInfo | undefined;
  readonly byName: (
    scope: IterationScope,
    componentPath: string,
    name: string,
  ) => IterationInfo | undefined;
  /**
   * scope の default iteration (schema 7 では `active_iterations.is_default`)。
   * **optional** — 無い時は caller が iteration を明示するか fail closed。
   * ここから auto-pick / fallback は絶対にしない。
   */
  readonly defaultIteration: (
    scope: IterationScope,
    componentPath: string,
  ) => IterationInfo | undefined;
  /** scope の active set を seq 順で返す。default が無くても返る。 */
  readonly activeIterations: (
    scope: IterationScope,
    componentPath: string,
  ) => readonly IterationInfo[];
  /** path が `<dir>/{docs|spec|app}/` の内側にある iteration (register の scope 判定用)。 */
  readonly containing: (path: string) => IterationInfo | undefined;
  /** `scope + component_path` 内の次の seq。採番の正本はここ。 */
  readonly nextSeq: (scope: IterationScope, componentPath: string) => number;
  readonly members: (
    iterationId: string,
  ) => { readonly components: readonly string[]; readonly documents: readonly string[] };
};

/**
 * iteration の fs side effect の境界。`DocumentPort` は Markdown 本文だけを書くので、
 * dir の skeleton と symlink はこの port が担う。
 *
 * **DB commit 後に呼ぶ。** fs は SQLite transaction に乗らないので、失敗時は
 * `iteration.repair` で DB state から組み直す。
 */
export interface IterationFsPort {
  /** repo root 相対 path が存在するか (symlink も存在として数える)。 */
  exists(relPath: string): boolean;
  /**
   * `<dir>/{docs,spec,app}` を作る。`<dir>` が既に在れば fail closed —
   * 既存 dir の中を勝手に埋めない。
   */
  createSkeleton(iterDir: string): Result<{ created: boolean }>;
  /**
   * symlink `link` を `target` (link の dir からの相対) へ張る/張り替える。
   * 既存が symlink でない実体なら fail closed (上書きしない)。
   */
  writeSymlink(link: string, target: string): Result<{ changed: boolean }>;
  /** symlink の target を読む。無ければ undefined、symlink でなければ error。 */
  readSymlink(link: string): Result<string | undefined>;
  /**
   * symlink `link` を外す (deactivate / stale link の prune)。
   * 無ければ changed=false。symlink でない実体は fail closed (消さない)。
   */
  removeSymlink(link: string): Result<{ changed: boolean }>;
  /**
   * `dir` 直下の symlink entry の名前一覧 (`active/` link の棚卸し用)。
   * dir が無ければ空。symlink でない entry が混ざっていれば fail closed。
   */
  listSymlinks(dir: string): Result<readonly string[]>;
  /**
   * `<dir>` と欠けている skeleton subdir を作る。既存でも失敗しない —
   * `createSkeleton` の fail closed は `iteration.open` 用で、repair は
   * git が空 dir を commit しない都合で欠けた subdir を補う側に回る。
   */
  ensureSkeleton(iterDir: string): Result<{ created: boolean }>;
  /**
   * committed tree の iteration 関連 fact を走査する (tree -> DB rebuild の入力)。
   * symlink は辿らない。実装は `node:fs` を持つ adapter (`fs_iteration.ts`)。
   *
   * **走査範囲の限界 (裁定済みの default)。** hidden dir (`.x` 始まり) と
   * `node_modules` の下は走査しない — generated stamp がそこに置かれる committed
   * tree は想定しない。仮に置かれた場合、その file の stamp は rebuild の入力に
   * ならず、membership だけ欠ける (iteration 行自体は dir skeleton から復元される)。
   */
  scanTree(): Result<IterationTreeScan>;
}

// ---------------------------------------------------------------------------
// tree -> DB rebuild (fresh device)
// ---------------------------------------------------------------------------
//
// replication Option A の裁定: DB は device-local で、committed tree (dir skeleton +
// `active/` link + optional `current` symlink + generated frontmatter) が device を
// 跨ぐ carrier。`iteration.repair` はこの scan + frontmatter から iterations /
// members / active_iterations を組み直す。**seq は `iteration:` の記録値だけを読み、
// mtime / clock / dir 列挙順 / label からは invent しない。**記録が無い、衝突する、
// tree が partial な時は fail closed で offending path を返す。

/** scan が見つけた skeleton 形の dir (`<p>/<label>/{docs|spec|app}` が 1 つ以上在る)。 */
export type IterationDirFact = {
  /** repo root 相対の dir (`docs/iterations/v8` / `visualiser/v5`)。 */
  readonly dir: string;
  /** 実際に存在する skeleton subdir。git は空 dir を commit しないので欠けは正常。 */
  readonly skeleton: readonly string[];
};

/** walk で見つけた `current` という名前の entry。 */
export type IterationCurrentFact = {
  /** `docs/current` / `<comp>/current` 等の repo root 相対 path。 */
  readonly link: string;
  /** symlink target を link の dir から解決した repo root 相対 dir。 */
  readonly target?: string;
  /** symlink でない実体 / root 外 escape の時 true (fail closed 対象)。 */
  readonly invalid?: boolean;
};

/** iteration dir の skeleton subdir 直下に在る symlink 1 件。 */
export type IterationMemberFact = {
  readonly iteration_dir: string;
  readonly link: string;
  /** 解決した repo root 相対の target。`.md` 以外や escape は planner が弾く。 */
  readonly target?: string;
  readonly escapes?: boolean;
};

/**
 * `<p>/active/<label>` / `docs/active/<label>` の下に在る entry 1 件 (schema 7)。
 * symlink なら `target` に解決後の repo root 相対 dir。symlink でない実体や
 * root 外 escape は `invalid` (fail closed 対象)。
 */
export type IterationActiveFact = {
  readonly link: string;
  readonly target?: string;
  readonly invalid?: boolean;
};

export type IterationTreeScan = {
  readonly dirs: readonly IterationDirFact[];
  readonly currents: readonly IterationCurrentFact[];
  readonly actives: readonly IterationActiveFact[];
  readonly members: readonly IterationMemberFact[];
};

/** fail closed の 1 件。offending path と理由。 */
export type IterationTreeFailure = {
  readonly path: string;
  readonly reason: string;
};

/** tree から復元する iteration 1 行分。 */
export type RebuiltIteration = {
  readonly scope: IterationScope;
  readonly component_path: string;
  readonly name: string;
  readonly seq: number;
  readonly created_at: string;
  readonly dir: string;
  /** `<p>/active/<label>` link が指していたか (active set の membership)。 */
  readonly active: boolean;
  /** `current` symlink が指していたか (optional default)。`active` 無しでは立たない。 */
  readonly is_default: boolean;
  /** member になる canonical path (component / doc の区別は DB 側で引く)。 */
  readonly member_paths: readonly string[];
};

export type IterationRebuildPlan = {
  readonly iterations: readonly RebuiltIteration[];
};

export type IterationRebuildOutcome =
  | { readonly ok: true; readonly plan: IterationRebuildPlan; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly failures: readonly IterationTreeFailure[] };

function parentDirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * dir path を (scope, component_path, label) へ解読する。
 * `docs/iterations/<label>` は project scope、それ以外の `<p>/<label>` は
 * component scope (component_path = `<p>`)。root 直下の dir は iteration に
 * なり得ない (component_path が "" になる) ので undefined。
 */
function iterationDirScope(
  dir: string,
): { scope: IterationScope; component_path: string; name: string } | undefined {
  const name = baseNameOf(dir);
  if (!ITERATION_LABEL_PATTERN.test(name)) return undefined;
  if ((RESERVED_ITERATION_LABELS as readonly string[]).includes(name)) return undefined;
  const parent = parentDirOf(dir);
  if (parent === "docs/iterations") return { scope: "project", component_path: "", name };
  if (parent === "") return undefined;
  return { scope: "component", component_path: parent, name };
}

/** path が `<dir>/{docs|spec|app}/...` の内側ならその dir、外なら undefined。 */
function containingIterationDir(path: string, dirs: ReadonlySet<string>): string | undefined {
  for (const dir of dirs) {
    if (!path.startsWith(`${dir}/`)) continue;
    const inner = path.slice(dir.length + 1).split("/", 1)[0] ?? "";
    if ((ITERATION_SKELETON_DIRS as readonly string[]).includes(inner)) return dir;
  }
  return undefined;
}

type RebuildCandidate = {
  scope: IterationScope;
  component_path: string;
  name: string;
  dir: string;
  /** active/current link / member link / stamped file / stamp claim で「iteration である」と確定したか。 */
  anchored: boolean;
  /** `<p>/active/<label>` link が在るか。 */
  active: boolean;
  /** `current` symlink が指したか (optional default。active なしでは立たない)。 */
  isDefault: boolean;
  claims: { seq: number; created: string; via: string }[];
  memberPaths: Set<string>;
};

function scopeKeyOf(scope: IterationScope, componentPath: string): string {
  return `${scope}${componentPath}`;
}

/**
 * committed tree の fact から rebuild plan を組む。**validation が全部通るまで
 * 呼び出し側は DB を書かない** (fail closed は書き込み前に畳む)。
 *
 * - candidate dir は shape (`<p>/<label>/{docs|spec|app}`) だけでは足りず、
 *   `current` target / member link / stamped file / stamp claim のいずれかで
 *   anchor されて初めて iteration と見なす。`tools/mock/docs` のような
 *   iteration でない dir が seq 要求で落ちるのを防ぐ。
 * - stamped file の `iteration_label` は file の置き場が scope を決める
 *   (`effectiveIterationOf` と同じ規則): dir 内ならその dir の scope、
 *   外 (flat file) なら project scope。
 * - membership の証拠は 3 種: member symlink、containing dir (component の
 *   birth)、stamp claim そのもの (mind / doc member は frontmatter が唯一の
 *   committed 記録になりうる)。stamp と証拠集合が食い違う時は fail ではなく
 *   warning — stamp は generated なので DB から再投影すれば直る。
 */
export function planIterationRebuild(input: {
  readonly scan: IterationTreeScan;
  /** repo 内の全 `.md` path -> readIterationProperties の結果。 */
  readonly files: ReadonlyMap<string, Partial<IterationProperties> | undefined>;
  /** 登録済み component の canonical document path (locator の `#` 前)。 */
  readonly componentPaths: ReadonlySet<string>;
}): IterationRebuildOutcome {
  const failures: IterationTreeFailure[] = [];
  const warnings: string[] = [];
  const candidates = new Map<string, RebuildCandidate>();
  const candidateDirs = new Set<string>();

  for (const fact of input.scan.dirs) {
    const scope = iterationDirScope(fact.dir);
    if (scope === undefined) continue;
    candidates.set(fact.dir, {
      ...scope,
      dir: fact.dir,
      anchored: false,
      active: false,
      isDefault: false,
      claims: [],
      memberPaths: new Set(),
    });
    candidateDirs.add(fact.dir);
  }
  const candidateParents = new Set<string>();
  for (const dir of candidateDirs) candidateParents.add(parentDirOf(dir));

  // `active/<label>` link: `<p>/active/<label>` -> `<p>/<label>` (component) /
  // `docs/active/<label>` -> `docs/iterations/<label>` (project)。link 名と
  // target の basename が一致しなければならない (target を link path から期待値で
  // 割り出して突き合わせる)。自分の namespace 外 (`<p>` に candidate が無く
  // `docs` でもない) の active dir は別 tool のものとして触らない。
  for (const fact of input.scan.actives) {
    const activeDir = parentDirOf(fact.link); // `<p>/active` or `docs/active`
    const owner = parentDirOf(activeDir); // `<p>` or `docs`
    const ours = owner === "docs" || candidateParents.has(owner);
    if (!ours) continue;
    const label = baseNameOf(fact.link);
    const expected = owner === "docs" ? `docs/iterations/${label}` : `${owner}/${label}`;
    if (fact.invalid || fact.target === undefined) {
      failures.push({
        path: fact.link,
        reason: "active link が解読できない (symlink でない / repo 外を指す)",
      });
      continue;
    }
    if (fact.target !== expected) {
      failures.push({
        path: fact.link,
        reason:
          `active link の名前と target が矛盾する: ${label} -> ${fact.target} (期待 ${expected})`,
      });
      continue;
    }
    const candidate = candidates.get(expected);
    if (candidate === undefined) {
      failures.push({
        path: fact.link,
        reason: `active link が存在しない / iteration でない dir を指す: ${expected}`,
      });
      continue;
    }
    candidate.anchored = true;
    candidate.active = true;
  }

  // `current` link: 自分の namespace のものだけを読む。`docs/current` は常に
  // project の pointer。`<p>/current` は `<p>` の直下に candidate dir があるか、
  // target が `<p>/<label>` の形をしていれば iteration の pointer と見なす。
  // それ以外の `current` symlink は別の tool のものなので触らない。
  // schema 7: current は optional default の記録で、**target は active link を
  // 持つ dir でなければならない** (active でないものへの current は矛盾)。
  const currentClaims = new Map<string, { dir: string; link: string }>();
  for (const fact of input.scan.currents) {
    const linkParent = parentDirOf(fact.link);
    const targetName = fact.target === undefined ? undefined : baseNameOf(fact.target);
    const targetLooksOurs = fact.target !== undefined &&
      parentDirOf(fact.target) === linkParent &&
      targetName !== undefined &&
      ITERATION_LABEL_PATTERN.test(targetName) &&
      !(RESERVED_ITERATION_LABELS as readonly string[]).includes(targetName);
    const ours = fact.link === "docs/current" ||
      candidateParents.has(linkParent) || targetLooksOurs;
    if (!ours) continue;
    if (fact.invalid || fact.target === undefined) {
      failures.push({
        path: fact.link,
        reason: "current が解読できない (symlink でない / repo 外を指す)",
      });
      continue;
    }
    const candidate = candidates.get(fact.target);
    if (candidate === undefined) {
      failures.push({
        path: fact.link,
        reason: `current link が存在しない / iteration でない dir を指す: ${fact.target}`,
      });
      continue;
    }
    if (!candidate.active) {
      failures.push({
        path: fact.link,
        reason: `current link が active link を持たない dir を指す: ${fact.target}`,
      });
      continue;
    }
    candidate.anchored = true;
    candidate.isDefault = true;
    const key = scopeKeyOf(candidate.scope, candidate.component_path);
    const existing = currentClaims.get(key);
    if (existing !== undefined && existing.dir !== candidate.dir) {
      failures.push({
        path: fact.link,
        reason:
          `同じ scope に 2 つの current: ${existing.link} -> ${existing.dir} / ${fact.link} -> ${candidate.dir}`,
      });
      continue;
    }
    currentClaims.set(key, { dir: candidate.dir, link: fact.link });
  }

  // member link: skeleton subdir 直下の symlink -> canonical `.md`。
  const linksByTarget = new Map<string, RebuildCandidate[]>();
  for (const fact of input.scan.members) {
    const candidate = candidates.get(fact.iteration_dir);
    if (candidate === undefined) continue;
    candidate.anchored = true;
    if (fact.escapes || fact.target === undefined) {
      failures.push({
        path: fact.link,
        reason: "member link が repo root の外を指す",
      });
      continue;
    }
    if (!fact.target.endsWith(".md")) continue; // app asset 等の foreign link は member ではない
    if (!input.files.has(fact.target)) {
      failures.push({
        path: fact.link,
        reason: `member link が dangling: -> ${fact.target}`,
      });
      continue;
    }
    candidate.memberPaths.add(fact.target);
    const bucket = linksByTarget.get(fact.target);
    if (bucket === undefined) linksByTarget.set(fact.target, [candidate]);
    else bucket.push(candidate);
  }

  // stamped file: 3 key が揃っていないものは ambiguous として fail closed。
  // claim は `iteration_label` を file の scope に解決した candidate へ集める。
  // membership の証拠 (claim / member link / containing dir) はここで畳み、
  // stamp と証拠の整合は seq が確定した後の第二 pass で検査する。
  const stampedEvidence: {
    path: string;
    claim: RebuildCandidate;
    evidence: Set<RebuildCandidate>;
  }[] = [];
  for (const [path, props] of input.files) {
    if (props === undefined) continue;
    const present = ITERATION_PROPERTY_KEYS.filter((key) => props[key] !== undefined);
    if (present.length === 0) continue;
    if (
      present.length !== ITERATION_PROPERTY_KEYS.length ||
      props.iteration === undefined ||
      props.iteration < 0
    ) {
      failures.push({
        path,
        reason:
          "generated key が部分的 / 解読不能 (iteration / iteration_label / iteration_created が揃っていない)",
      });
      continue;
    }
    const locatedDir = containingIterationDir(path, candidateDirs);
    const located = locatedDir === undefined ? undefined : candidates.get(locatedDir);
    const scope = located === undefined
      ? { scope: "project" as const, component_path: "" }
      : { scope: located.scope, component_path: located.component_path };
    if (located !== undefined) located.anchored = true;
    const claimDir = `${
      iterationBaseDir(scope.scope, scope.component_path)
    }/${props.iteration_label}`;
    const claim = candidates.get(claimDir);
    if (claim === undefined) {
      failures.push({
        path,
        reason: `stamp が未知の iteration を指す: ${props.iteration_label} (${claimDir} が無い)`,
      });
      continue;
    }
    claim.anchored = true;
    claim.claims.push({
      seq: props.iteration,
      created: props.iteration_created ?? "",
      via: path,
    });

    const evidence = new Set<RebuildCandidate>([claim]);
    for (const linker of linksByTarget.get(path) ?? []) evidence.add(linker);
    // containing dir が効くのは component (birth) と、doc が自身の dir を名乗る時だけ。
    if (located !== undefined && (input.componentPaths.has(path) || located === claim)) {
      evidence.add(located);
      if (input.componentPaths.has(path)) located.memberPaths.add(path);
    }
    claim.memberPaths.add(path);
    stampedEvidence.push({ path, claim, evidence });
  }

  // anchor の無い shape dir は iteration と見なさない (`tools/mock/docs` 等)。
  const anchored = [...candidates.values()].filter((candidate) => candidate.anchored);

  // containing dir 内の unstamped component も member に畳む (anchor 済み dir のみ)。
  for (const candidate of anchored) {
    for (const path of input.componentPaths) {
      if (containingIterationDir(path, new Set([candidate.dir])) === candidate.dir) {
        candidate.memberPaths.add(path);
      }
    }
  }

  // seq / created_at は claim の記録値だけ。複数の claim が一致しない時、
  // 記録が 1 つも無い時、別の iteration と seq が衝突する時は fail closed。
  const byScope = new Map<string, RebuildCandidate[]>();
  for (const candidate of anchored) {
    const key = scopeKeyOf(candidate.scope, candidate.component_path);
    const bucket = byScope.get(key);
    if (bucket === undefined) byScope.set(key, [candidate]);
    else bucket.push(candidate);
  }
  const rebuilt: RebuiltIteration[] = [];
  for (const bucket of byScope.values()) {
    const seqSeen = new Map<number, RebuildCandidate>();
    for (const candidate of bucket) {
      if (candidate.claims.length === 0) {
        failures.push({
          path: candidate.dir,
          reason:
            "iteration dir は在るが seq の記録 (generated frontmatter の `iteration:`) が 1 件も無い — 順序を invent しないので fail closed",
        });
        continue;
      }
      const seqs = new Set(candidate.claims.map((claim) => claim.seq));
      const createds = new Set(candidate.claims.map((claim) => claim.created));
      if (seqs.size !== 1 || createds.size !== 1) {
        failures.push({
          path: candidate.dir,
          reason: `stamp が矛盾: ${
            candidate.claims.map((claim) => `${claim.via} -> seq ${claim.seq}`).join(", ")
          }`,
        });
        continue;
      }
      const seq = candidate.claims[0]?.seq ?? 0;
      const clash = seqSeen.get(seq);
      if (clash !== undefined) {
        failures.push({
          path: candidate.dir,
          reason: `seq ${seq} が ${clash.dir} と衝突する`,
        });
        failures.push({
          path: clash.dir,
          reason: `seq ${seq} が ${candidate.dir} と衝突する`,
        });
        continue;
      }
      seqSeen.set(seq, candidate);
    }
  }

  // stamp と membership 証拠の整合。食い違いは fail ではなく warning — stamp は
  // generated なので rebuild 後の再投影で直る (fail closed は「読めない」時だけ)。
  const seqByCandidate = new Map<RebuildCandidate, number>();
  for (const bucket of byScope.values()) {
    for (const candidate of bucket) {
      if (candidate.claims.length > 0) seqByCandidate.set(candidate, candidate.claims[0]?.seq ?? 0);
    }
  }
  for (const entry of stampedEvidence) {
    const effective = [...entry.evidence]
      .filter((candidate) => seqByCandidate.has(candidate))
      .reduce<RebuildCandidate | undefined>(
        (best, candidate) =>
          best === undefined ||
            (seqByCandidate.get(candidate) ?? 0) > (seqByCandidate.get(best) ?? 0)
            ? candidate
            : best,
        undefined,
      );
    if (effective !== undefined && effective !== entry.claim) {
      warnings.push(
        `${entry.path}: stamp (label ${entry.claim.name}) と membership の証拠が不一致 — DB から再投影して直す`,
      );
    }
  }

  for (const candidate of anchored) {
    const seq = seqByCandidate.get(candidate);
    if (seq === undefined) continue; // failure 済み
    rebuilt.push({
      scope: candidate.scope,
      component_path: candidate.component_path,
      name: candidate.name,
      seq,
      created_at: candidate.claims[0]?.created ?? "",
      dir: candidate.dir,
      active: candidate.active,
      is_default: candidate.isDefault,
      member_paths: [...candidate.memberPaths].sort(),
    });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, plan: { iterations: rebuilt }, warnings };
}
