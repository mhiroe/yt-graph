// 親 node の `children` property を読む codec。**所属を Markdown へ書くための唯一の境界。**
//
// **pure である。** file を読まない。`region.ts` と同じく、引数の文字列だけで決まる。
//
// 所属の正本は親 node の `children` property (`my-wish-data.md` の hierarchy 節)。frontmatter は
// file root node の持ち物なので、**書けるのは file root node の `children` だけ**である。
//
// **YAML parser ではない。** 実 vault で実際に使われている形だけを読み、それ以外は
// `children_shape_unsupported` で止める。推測で読める形を広げると、読めたつもりで別の値を
// 書き戻す。実測 (mon_wish 2026-09-21、frontmatter に `children` を持つ 91 md) は次の 3 形。
//
// | 形 | 件数 |
// | --- | --- |
// | `children: []` | 42 |
// | `children:` + 次行 `  []` | 49 |
// | `children:` + `  - "[[...]]"` の block list | 2 file / 11 要素 |
//
// 要素は `"[[wishboard/docs/wish_wishboard]]"` の形 (double quote、2 space indent) が 10 件、
// project node の path pattern `"docs/spec_*.md"` が 1 件。**書く形はこの実測に揃える。**
//
// artifact 0.13.0 で **mind が wish を id で持つ要素** (`"w-01M10QRBYR"`) を足した
// (`my-wish-data.md` の hierarchy 節)。3 形の中の要素の形が増えただけで、list の形は変えていない。
// 既存の `[[...]]` 要素は今までどおり link として読む (後方互換)。

import { err, ok, type Result } from "./result.ts";
import { documentHash } from "./document.ts";
import { frontmatterEnd, type Line, type Span, splitLines } from "./region.ts";
import { isVaultComponentId } from "./vault_ids.ts";

/**
 * `children` の要素 1 件。
 *
 * - `value`: YAML scalar の quote を外した値。
 * - `link_target`: `[[...]]` の中身から alias を除いたもの。**node link でない要素
 *   (project node の path pattern、id 要素) では未設定。**link 操作は path pattern を触らない。
 * - `component_id`: 値が vault 形の id (`w-<10 桁>` など) のとき、その id (artifact 0.13.0)。
 *   **形だけを見る。**指す node が在るか、wish かは codec が決めない (projection が決める)。
 */
export type ChildEntry = {
  readonly value: string;
  readonly link_target?: string;
  readonly component_id?: string;
};

/**
 * `children` property の形。書き戻す時に形を選ぶので、値だけでなく形も持つ。
 *
 * - `no_frontmatter`: frontmatter が無い (または閉じていない)。**書けない。**
 * - `absent`: frontmatter はあるが key が無い。
 * - `null`: `children:` だけで値が無い。
 * - `inline_empty`: `children: []`。
 * - `block_empty`: `children:` + 次行 `  []`。
 * - `block`: `children:` + `  - <item>` の block list。
 */
export type ChildrenForm =
  | "no_frontmatter"
  | "absent"
  | "null"
  | "inline_empty"
  | "block_empty"
  | "block";

export type ChildrenProperty = {
  readonly form: ChildrenForm;
  /**
   * property 全体の span (key 行から最後の継続行の次の行頭まで)。**hash の入力。**
   * `absent` では閉じ `---` 行頭の空 span、`no_frontmatter` では file 先頭の空 span。
   */
  readonly span: Span;
  readonly entries: readonly ChildEntry[];
  /** 各要素行の span (行終端まで含む)。`entries` と同じ順。 */
  readonly item_spans: readonly Span[];
  /** block list の要素行の indent。`block` 以外では既定の 2 space。 */
  readonly item_indent: string;
};

/** 実測の block list が全件 2 space indent なので、新しく作る list もこれに揃える。 */
const DEFAULT_ITEM_INDENT = "  ";
const CHILDREN_KEY = /^children[ \t]*:(.*)$/;
const ITEM_LINE = /^([ \t]*)-[ \t]+(.*?)[ \t]*$/;
const BLOCK_EMPTY_LINE = /^[ \t]+\[\][ \t]*$/;
const WIKILINK = /^\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]$/;
/** plain scalar の先頭に来ると YAML の別構文になる文字。これで始まる要素は読まない。 */
const PLAIN_FORBIDDEN_START = /^[[\]{}&*!|>'"%@`#,?:-]/;

/** property の hash。`expected_hash` と比べる値。**span の raw text をそのまま入力にする。** */
export function childrenHash(raw: string, property: ChildrenProperty): string {
  return documentHash(raw.slice(property.span.start, property.span.end));
}

/**
 * YAML scalar 1 つを読む。**読めない形は undefined。** escape と複数行 scalar は読まない。
 * 実測の要素は全件 double quote の 1 行で、escape を含むものは無い。
 */
function parseScalar(text: string): string | undefined {
  if (text.length === 0) return undefined;
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return undefined;
    const inner = text.slice(1, -1);
    if (inner.includes('"') || inner.includes("\\")) return undefined;
    return inner;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) return undefined;
    const inner = text.slice(1, -1);
    if (inner.includes("'")) return undefined;
    return inner;
  }
  // plain scalar。`[[x]]` を quote 無しで書くと YAML では入れ子の flow sequence になるので、
  // `[` で始まる要素はここで落ちる (link として読まない)。
  if (PLAIN_FORBIDDEN_START.test(text)) return undefined;
  if (text.includes(" #") || text.includes(": ")) return undefined;
  return text;
}

function entryOf(value: string): ChildEntry {
  const link = WIKILINK.exec(value);
  const target = link?.[1];
  if (target !== undefined) return { value, link_target: target };
  return isVaultComponentId(value) ? { value, component_id: value } : { value };
}

/**
 * mind の `children` の要素 1 件の読み (artifact 0.13.0)。
 *
 * - `id`: vault 形の id。**wish を指すかは prefix だけで決めない** — 解決は projection の仕事。
 * - `link`: 既存の `[[...]]` 要素。後方互換で読む。file を指すので Core は解決しない。
 * - `malformed`: どちらでもない。**mind は path pattern を持たない** (project node だけの形) ので、
 *   mind の要素で id でも link でもないものは id の書き損じとして **broken** に数える。
 *   黙って無視しない (`my-wish-data.md` の hierarchy 節)。
 */
export type MindChildReading =
  | { readonly kind: "id"; readonly value: string; readonly component_id: string }
  | { readonly kind: "link"; readonly value: string; readonly link_target: string }
  | { readonly kind: "malformed"; readonly value: string };

export function readMindChild(value: string): MindChildReading {
  const entry = entryOf(value);
  if (entry.link_target !== undefined) {
    return { kind: "link", value, link_target: entry.link_target };
  }
  if (entry.component_id !== undefined) {
    return { kind: "id", value, component_id: entry.component_id };
  }
  return { kind: "malformed", value };
}

function unsupported(message: string): Result<ChildrenProperty> {
  return err("children_shape_unsupported", message, "children");
}

/**
 * `children` property を引く。
 *
 * **frontmatter の判定は `region.ts` の `frontmatterEnd` と同じ規則を使う。** 2 か所で別の規則を
 * 持つと、codec が frontmatter と読んだ範囲の外へ `children` を書くことになる。
 */
export function locateChildren(raw: string): Result<ChildrenProperty> {
  const lines = splitLines(raw);
  const end = frontmatterEnd(lines);
  if (end === 0) {
    return ok({
      form: "no_frontmatter",
      span: { start: 0, end: 0 },
      entries: [],
      item_spans: [],
      item_indent: DEFAULT_ITEM_INDENT,
    });
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.next === end);
  const closing = lines[closingIndex];
  if (closing === undefined) return unsupported("frontmatter の閉じ行を解決できない");
  const inner = lines.slice(1, closingIndex);

  const keyIndices = inner.flatMap((line, index) => CHILDREN_KEY.test(line.text) ? [index] : []);
  if (keyIndices.length > 1) {
    // 一意に決まらない。**先着順で解決しない。**
    return unsupported(`frontmatter に children key が ${keyIndices.length} 件ある`);
  }
  const keyIndex = keyIndices[0];
  if (keyIndex === undefined) {
    return ok({
      form: "absent",
      span: { start: closing.start, end: closing.start },
      entries: [],
      item_spans: [],
      item_indent: DEFAULT_ITEM_INDENT,
    });
  }
  const keyLine = inner[keyIndex] as Line;
  const rest = (CHILDREN_KEY.exec(keyLine.text)?.[1] ?? "").trim();

  // key 行の後ろに続く継続行 (indent 付き、または `-` で始まる行)。空行で止める。
  const continuation: Line[] = [];
  for (let i = keyIndex + 1; i < inner.length; i += 1) {
    const line = inner[i] as Line;
    if (!/^[ \t-]/.test(line.text) || line.text.trim().length === 0) break;
    continuation.push(line);
  }
  // 空行を挟んで続きがある形は読まない。list の後半を見落として書き戻すと要素が消える。
  const after = inner.slice(keyIndex + 1 + continuation.length).find((line) =>
    line.text.trim().length > 0
  );
  if (continuation.length > 0 || rest.length === 0) {
    if (after !== undefined && /^[ \t-]/.test(after.text)) {
      return unsupported("children の list が空行で途切れている");
    }
  }
  const lastLine = continuation.at(-1) ?? keyLine;
  const span = { start: keyLine.start, end: lastLine.next };

  if (rest.length > 0) {
    if (continuation.length > 0) return unsupported("children の値が key 行と次行の両方にある");
    if (rest === "[]") {
      return ok({
        form: "inline_empty",
        span,
        entries: [],
        item_spans: [],
        item_indent: DEFAULT_ITEM_INDENT,
      });
    }
    return unsupported(`children の値の形を読めない: ${rest}`);
  }
  if (continuation.length === 0) {
    return ok({
      form: "null",
      span,
      entries: [],
      item_spans: [],
      item_indent: DEFAULT_ITEM_INDENT,
    });
  }
  if (continuation.length === 1 && BLOCK_EMPTY_LINE.test(continuation[0]?.text ?? "")) {
    return ok({
      form: "block_empty",
      span,
      entries: [],
      item_spans: [],
      item_indent: DEFAULT_ITEM_INDENT,
    });
  }

  const entries: ChildEntry[] = [];
  const itemSpans: Span[] = [];
  let indent: string | undefined;
  for (const line of continuation) {
    const item = ITEM_LINE.exec(line.text);
    if (item === null) return unsupported(`children の要素行を読めない: ${line.text}`);
    const lineIndent = item[1] ?? "";
    if (indent === undefined) indent = lineIndent;
    if (lineIndent !== indent) return unsupported("children の要素行の indent が揃っていない");
    const value = parseScalar(item[2] ?? "");
    if (value === undefined) return unsupported(`children の要素を読めない: ${item[2] ?? ""}`);
    entries.push(entryOf(value));
    itemSpans.push({ start: line.start, end: line.next });
  }
  return ok({
    form: "block",
    span,
    entries,
    item_spans: itemSpans,
    item_indent: indent ?? DEFAULT_ITEM_INDENT,
  });
}

/**
 * caller が渡す child link の target を検める。**`[[` `]]` を含まない target だけを受ける。**
 *
 * vault 上の link 形 (vault root からの path、`.md` の有無) を Core は決めない。repo root と
 * vault root が一致する保証が無いので、**Core が locator から link を組み立てると推測になる。**
 * bridge (plugin) が vault 上の link target を渡す。
 */
export function parseChildLink(value: unknown, path?: string): Result<string> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "child_link は string である必要がある", path);
  }
  if (value.length === 0 || value.trim() !== value) {
    return err("invalid_child_link", "child_link は前後に空白を持たない空でない文字列", path);
  }
  if (/[[\]|"\\\r\n]/.test(value)) {
    return err(
      "invalid_child_link",
      `child_link は link target だけを渡す ([[ ]] / | / " / \\ / 改行を含めない): ${value}`,
      path,
    );
  }
  return ok(value);
}

/**
 * 同じ node を指す link target か。
 *
 * **`.md` の有無だけを同一視する。** 実測で `[[.../wish_google_keep_widget.md]]` と `.md` 無しの
 * 形が同じ vault に混在しており、Obsidian はどちらも同じ file へ解決する。これ以上 (大文字小文字、
 * basename だけの短縮 link) は同一視しない。推測で同一視すると別 node の要素を消す。
 */
export function sameLinkTarget(left: string, right: string): boolean {
  return normalizeTarget(left) === normalizeTarget(right);
}

function normalizeTarget(target: string): string {
  const index = target.indexOf("#");
  const path = index < 0 ? target : target.slice(0, index);
  const heading = index < 0 ? "" : target.slice(index);
  return `${path.replace(/\.md$/i, "")}${heading}`;
}

/**
 * caller が渡す child id を検める (artifact 0.13.0)。
 *
 * - attach (`for_attach=true`): **vault 形の wish id だけ**を受ける。mind が id で持つのは wish だけ
 *   (`my-wish-data.md` の hierarchy 節)。**指す wish が在るかは検めない** (mind は wish を検めない)。
 * - detach: 形が不正な要素 (broken) も明示の操作で外せるよう、**要素の値そのもの**を受ける。
 *   YAML scalar として書ける値 (quote / escape / 改行 / `[` `]` を含まない) に限る。
 */
export function parseChildId(value: unknown, forAttach: boolean, path?: string): Result<string> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "child_id は string である必要がある", path);
  }
  if (value.length === 0 || value.trim() !== value || /[[\]|"'\\\r\n]/.test(value)) {
    return err(
      "invalid_child_id",
      `child_id は前後に空白を持たない、quote / escape / 改行 / [ ] を含まない値: ${value}`,
      path,
    );
  }
  if (forAttach && !(isVaultComponentId(value) && value.startsWith("w-"))) {
    return err(
      "invalid_child_id",
      `attach する child_id は vault 形の wish id (w-<Crockford base32 10 桁>): ${value}`,
      path,
    );
  }
  return ok(value);
}

/** frontmatter の `kind` の値。**`kind: mind` の行だけを見る。** YAML parser ではない。 */
export function frontmatterKind(raw: string): string | undefined {
  const lines = splitLines(raw);
  const end = frontmatterEnd(lines);
  if (end === 0) return undefined;
  const kinds = lines.slice(1).filter((line) => line.next <= end).flatMap((line) => {
    const match = /^kind[ \t]*:[ \t]*(\S+)[ \t]*$/.exec(line.text);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  // 重複 key は一意に決まらないので読まない。
  return kinds.length === 1 ? kinds[0] : undefined;
}

/** id 要素の行。**double quote で書く。** plain でも YAML として読めるが、既存要素の形に揃える。 */
export function formatChildIdItem(indent: string, id: string, newline: string): string {
  return `${indent}- "${id}"${newline}`;
}

/** 新しく書く要素行。**実測の形 (double quote の wikilink) に揃える。** */
export function formatChildItem(indent: string, target: string, newline: string): string {
  return `${indent}- "[[${target}]]"${newline}`;
}

/** 空になった list を書く形。`my-wish-data.md` の frontmatter 基本形 `children: []` に揃える。 */
export function formatEmptyChildren(newline: string): string {
  return `children: []${newline}`;
}
