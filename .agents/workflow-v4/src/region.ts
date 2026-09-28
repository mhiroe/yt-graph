// RegionCodec。Markdown 上で「どこが component で、どこが region か」を決める唯一の境界。
//
// **pure である。** file を読まない。引数の文字列だけで決まるので、同じ入力からは必ず同じ結果。
// filesystem を触るのは `adapters/fs_document.ts`。
//
// この境界を持つ理由は 1 つ。**named region (User / Agent / Plan) の記法が未確定だから**である。
// 記法が決まったら codec を 1 つ足すだけで済み、DocumentPort の signature も contract も動かない。
// 逆に記法を codec の外へ散らすと、決める時に adapter と CLI と test を同時に触ることになる。

import { err, ok, type Result } from "./result.ts";
import { documentHash, formatRegionTarget, type RegionTarget } from "./document.ts";

/** 文字 offset の半開区間。行番号ではなく offset を使うのは、改行を 1 byte も動かさないため。 */
export type Span = {
  readonly start: number;
  readonly end: number;
};

/**
 * component 1 件に対応する heading section。
 *
 * 3 つに分ける。**identity と本文を同じ region にしない。**
 *
 * - `heading`: heading 行。`rename_title` だけが触る。
 * - `identity`: heading 直下の property callout と `^<id>` anchor。**どの region にも含めない。**
 *   本文 region に含めると、本文の全置換が stable ID を消す。identity を content の書き換えで
 *   失わせない。
 * - `body`: 残りの本文。`component_body` region の実体。
 *
 * **`body` の範囲が wishboard observer の `observed_hash` 入力と一致する保証は無い。**
 * 向こうの README も「region の定義 (heading を含むのか本文だけか) は共有仕様に無い」と
 * 書いている。実 vault reader を作る時に揃える必要がある。未確定なので、ここでは
 * 「write が identity を壊さない」を優先して切った。
 */
export type Section = {
  /**
   * この section が表す node の種別 (裁定 Slice E)。
   *
   * - `heading`: Markdown heading が表す wish node。
   * - `file_root`: file 自身が表す node。実 vault の `^<id>` anchor は 17 file すべてが
   *   この位置にある。`my-wish-data.md` の node model が第一級に定めている形。
   */
  readonly node: "heading" | "file_root";
  /** heading の level。`file_root` では `0`。 */
  readonly level: number;
  /**
   * heading 行の text。**`file_root` では空文字。**
   *
   * file root node の表示 title は file basename から導出すると `my-wish-data.md` が定めており、
   * codec は path を受け取らない (pure で、file も path も知らない)。導出は caller が行う。
   */
  readonly title: string;
  /** heading 行そのものの span。改行を含まない。**`file_root` では持たない。** */
  readonly heading?: Span;
  /** node 直下の identity block (property callout と block id anchor)。空のこともある。 */
  readonly identity: Span;
  /** identity の次から section の本文終端まで。末尾の空行を含まない。 */
  readonly body: Span;
  /** 末尾の空行まで含めた section 全体の終端。非対象 region の保全判定に使う。 */
  readonly section_end: number;
};

/** section 内で見つかった block id anchor 行。 */
export type IdAnchor = {
  readonly id: string;
  readonly span: Span;
};

/**
 * identity を挿入する指示 (裁定 Slice E、P3-a)。
 *
 * **offset だけでなく挿入する text も codec が持つ。** 記法を知っているのはこの file だけで、
 * caller が `^<id>` や `> [!meta]-` を組み立てると記法が 2 か所に散る。
 */
export type IdentityInsertion = {
  readonly offset: number;
  /** 挿入する文字列。document の改行で終わる。 */
  readonly text: string;
  /** property callout を新規に作ったか。既存 callout の直後へ anchor だけ足す場合は false。 */
  readonly creates_callout: boolean;
};

/**
 * region 内に見つかった他 node の identity (裁定 Slice E、裁定 1)。
 *
 * `component_body` は「次の同 level 以浅 heading の直前まで」なので**子 heading node を含む**。
 * 親の body を全置換すると子 component の identity が消える。**read の範囲は変えず、write を
 * 止める**ことで防ぐ (root PM 裁定)。
 */
export type ForeignIdentity = {
  readonly kind: "property_callout" | "id_anchor";
  /** その行の span。reason に位置を出すために持つ。 */
  readonly span: Span;
  /** `id_anchor` なら anchor の id。callout なら callout title。 */
  readonly id?: string;
};

/**
 * `listSections` が返す node 1 件 (裁定 root PM 2026-09-15、wishboard gap 1)。
 *
 * observer が node 一覧を作るための口。これが無いと、observer 側が ATX heading の行形を
 * 自前で判定することになり、**heading を読む規則が 2 か所へ散る。**
 */
export type ListedSection = Section & {
  /** `path#heading` で一意に指せるか。同名 heading が複数ある node は `false`。 */
  readonly addressable: boolean;
  /** node 直下にある stable ID anchor。未 register の node では未設定。 */
  readonly anchor?: IdAnchor;
};

export type SectionListing = {
  /** file root node を先頭に、出現順の heading node が続く。 */
  readonly sections: readonly ListedSection[];
  /**
   * どの node の identity block にも属さない `^<id>` 行。
   *
   * **setext heading の下に置かれた anchor がここに出る。**現行 codec は setext を heading として
   * 読まないので、section 経由では痕跡が 1 つも残らない。空でない listing は
   * 「この file に codec が読めない node がある」ことを表す。
   */
  readonly unclaimed_anchors: readonly IdAnchor[];
};

export interface RegionCodec {
  readonly codec_id: string;
  /**
   * section を引く。**`heading` 未設定は file root node。**
   * heading 形は一意に決まらなければ失敗させる。先着順で解決しない。
   */
  locateSection(raw: string, heading?: string): Result<Section>;
  /** target region の span。解決できない region は失敗として返す。既定値へ倒さない。 */
  locateRegion(raw: string, section: Section, target: RegionTarget): Result<Span>;
  /** section 直下に置かれた stable ID anchor。 */
  findIdAnchor(raw: string, section: Section): Result<IdAnchor | undefined>;
  /**
   * identity を挿入する位置と text。**property callout が無ければ callout ごと作る。**
   * 置き場は未定義ではなく未作成なので、失敗させずに作る (裁定 Slice E)。
   */
  identityInsertion(raw: string, section: Section, componentId: string): Result<IdentityInsertion>;
  /** span 内にある「この section 以外の」identity。無ければ undefined。 */
  findForeignIdentity(raw: string, section: Section, span: Span): ForeignIdentity | undefined;
  /**
   * file 内の node をすべて列挙する。**observer が node 一覧を作るための口。**
   * `locateSection` は 1 件を引く口なので、一覧は作れない。
   */
  listSections(raw: string): Result<SectionListing>;
}

const ATX_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
/** fence の開始 / 終了候補。marker の種別と長さの両方を取る。 */
// backtick fence の info string は backtick を含められない (CommonMark)。tilde fence は含められる。
const FENCE = /^[ \t]{0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
/**
 * identity を担う property callout の開始行。**`[!meta]` に限定する** (裁定 Slice E)。
 *
 * 以前は任意の callout 種別を identity として扱っていた。`> [!note]` を heading 直下へ書いた
 * 散文が identity block に入り、`^<id>` anchor がその note の後ろへ付いてしまう。
 *
 * **狭めても実データの範囲は動かない。** mon_wish + dotfiles/docs の 38 md を計測した結果、
 * heading 直下の最初の block が callout だったものは `[!meta]` の 10 件だけで、他種別は 0 件。
 * `my-wish-data.md` の `node property` も `[!meta]-` を形として示している。
 */
const META_CALLOUT_OPEN = /^[ \t]{0,3}>[ \t]*\[!meta\][-+]?[ \t]*(.*?)[ \t]*$/i;
const QUOTE_LINE = /^[ \t]{0,3}>/;
const ID_ANCHOR_LINE = /^\^([A-Za-z0-9][A-Za-z0-9._-]{0,63})[ \t]*$/;

export type Line = {
  /**
   * **行終端を含まない内容。CR を落としてある。**
   *
   * CRLF の `\r` を残すと、`$` で終わる heading / callout / anchor の判定が全て外れる。
   * CRLF の Markdown で `locateSection()` が `document_not_found` になっていた原因がこれ。
   * 判定はこの CR 無しの text で行い、**書き換えは offset で行う**ので file 側の改行は動かない。
   */
  readonly text: string;
  /** 行頭の offset。 */
  readonly start: number;
  /** 行終端 (`\n` / `\r\n`) の直前の offset。CR もこの外側に置く。 */
  readonly end: number;
  /** 次の行頭の offset。file 末尾なら raw.length。 */
  readonly next: number;
};

/**
 * 行へ分ける。**LF と CRLF を両方扱う。**
 *
 * `end` を CR の手前に置くのが要点。`rename_title` は heading 行の span を splice するので、
 * ここに CR が入っていると CRLF の file でその 1 行だけ LF になる。対象外 byte を変えない。
 */
export function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  let cursor = 0;
  while (cursor <= raw.length) {
    const breakAt = raw.indexOf("\n", cursor);
    if (breakAt < 0) {
      if (cursor < raw.length) {
        // 終端改行の無い最終行。CR だけで終わる file も CR を内容に含めない。
        const end = raw.endsWith("\r") ? raw.length - 1 : raw.length;
        lines.push({ text: raw.slice(cursor, end), start: cursor, end, next: raw.length });
      }
      break;
    }
    const end = breakAt > cursor && raw[breakAt - 1] === "\r" ? breakAt - 1 : breakAt;
    lines.push({ text: raw.slice(cursor, end), start: cursor, end, next: breakAt + 1 });
    cursor = breakAt + 1;
  }
  return lines;
}

/**
 * この document が使っている改行。**新しく足す行の終端**にだけ使う。
 *
 * 混在 file では CRLF を優先する。挿入した 1 行だけが LF になるより、既にある CRLF へ揃える方が
 * diff が小さい。**既存行の改行は書き換えない。**
 */
export function detectNewline(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * heading 行の index を集める。
 *
 * fenced code block と YAML frontmatter の中の `#` を heading にしない。ここを飛ばさないと、
 * code 例を含む docs で存在しない component が見えてしまう。
 *
 * **fence は marker の種別と長さの両方で閉じる (CommonMark 相当)。**
 * 種別しか持っていなかった時、外側 ` ```` ` で開いた block を内側の ` ``` ` が閉じてしまい、
 * code 例の中の `##` が heading として拾われて `ambiguous_locator` になっていた。
 * closing になれるのは **同じ文字で、opening 以上の長さで、marker の後ろに info string が無い行**だけ。
 */
function headingIndices(lines: readonly Line[]): { index: number; level: number; title: string }[] {
  const found: { index: number; level: number; title: string }[] = [];
  /** 開いている fence の marker 文字と長さ。閉じていなければ undefined。 */
  let fence: { char: string; length: number } | undefined;
  let inFrontmatter = false;
  for (const [index, line] of lines.entries()) {
    if (index === 0 && line.text.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.text.trim() === "---") inFrontmatter = false;
      continue;
    }
    const opened = fence;
    if (opened === undefined) {
      const marker = openingFence(line.text);
      if (marker !== undefined) {
        fence = marker;
        continue;
      }
    } else {
      if (closesFence(line.text, opened)) fence = undefined;
      // fence の中身は heading にしない。closing 行自体も heading ではない。
      continue;
    }
    const match = ATX_HEADING.exec(line.text);
    if (match === null) continue;
    found.push({ index, level: (match[1] ?? "").length, title: (match[2] ?? "").trim() });
  }
  return found;
}

/**
 * fence の開始行なら marker を返す。
 *
 * backtick fence は info string に backtick を含められない (CommonMark)。tilde fence は制限が
 * 無いが、この用途では info string の中身を見ないので同じ形で扱う。
 */
export function openingFence(text: string): { char: string; length: number } | undefined {
  const match = FENCE.exec(text);
  if (match === null) return undefined;
  const marker = match[1] ?? match[3] ?? "";
  if (marker.length === 0) return undefined;
  const char = marker[0];
  if (char === undefined) return undefined;
  return { char, length: marker.length };
}

/**
 * closing fence か。**同じ文字で、opening 以上の長さで、後ろが空白だけ**の行に限る。
 * 外側 4 個で開いた block を内側 3 個で閉じないのはこの長さ比較による。
 */
export function closesFence(text: string, opened: { char: string; length: number }): boolean {
  const marker = openingFence(text);
  if (marker === undefined) return false;
  if (marker.char !== opened.char) return false;
  if (marker.length < opened.length) return false;
  // closing fence は info string を持てない。marker の後ろに空白以外があれば closing ではない。
  const rest = text.trimStart().slice(marker.length);
  return rest.trim().length === 0;
}

/**
 * 行列を走査して、末尾で開いたままの fence の marker を返す。全て閉じていれば undefined。
 *
 * **閉じていない fence は CommonMark どおり container の末尾まで続く。** `headingIndices` と
 * 同じ規則 (marker の種別と長さの両方で閉じる) で追う。先頭行が fence の中に無い span —
 * たとえば heading 行から始まる subtree — にだけ使う。
 */
export function fenceOpenAtEnd(
  lines: readonly Line[],
): { char: string; length: number } | undefined {
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    if (fence === undefined) {
      const marker = openingFence(line.text);
      if (marker !== undefined) fence = marker;
    } else if (closesFence(line.text, fence)) {
      fence = undefined;
    }
  }
  return fence;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * heading 直下の prelude (空行 + property callout + block id anchor) の終端を返す。
 *
 * 形は `my-wish-data.md` の `node property` が定めるもの。
 *
 * ```markdown
 * ## おやつをやめたい
 * > [!meta]- w-01M0R8QW2C
 * > status: doing
 * ^w-01M0R8QW2C
 * ```
 *
 * callout 行の連続と、それに続く `^<id>` 行、および後続の空行までを identity として扱う。
 * **どちらも無ければ identity は空**で、body が heading の直後から始まる。
 */
function identityBlockEnd(
  sectionLines: readonly Line[],
  bodyStart: number,
  sectionEnd: number,
): number {
  let index = 0;
  let end = bodyStart;
  const skipBlank = (): void => {
    while (index < sectionLines.length && isBlank(sectionLines[index]?.text ?? "")) index += 1;
  };

  // heading 直後の空行は prelude 側へ寄せる。callout の有無で body の開始位置が変わると、
  // 同じ「本文」を指しているのに hash と置換範囲がずれる。
  skipBlank();
  end = sectionLines[index]?.start ?? sectionEnd;
  const first = sectionLines[index];
  if (first !== undefined && META_CALLOUT_OPEN.test(first.text)) {
    end = first.next;
    index += 1;
    while (index < sectionLines.length) {
      const line = sectionLines[index];
      if (line === undefined || !QUOTE_LINE.test(line.text)) break;
      end = line.next;
      index += 1;
    }
  }

  const beforeAnchor = index;
  skipBlank();
  const anchor = sectionLines[index];
  if (anchor !== undefined && ID_ANCHOR_LINE.test(anchor.text)) {
    end = anchor.next;
    index += 1;
  } else {
    index = beforeAnchor;
  }
  // identity の直後の空行も prelude 側へ寄せる。body の置換で「anchor と本文の間の空行」が
  // 消えたり増えたりしないようにする。
  while (index < sectionLines.length) {
    const line = sectionLines[index];
    if (line === undefined || !isBlank(line.text)) break;
    end = line.next;
    index += 1;
  }
  return Math.min(end, sectionEnd);
}

/**
 * YAML frontmatter の終端 offset。frontmatter が無ければ 0。
 *
 * file root node の identity block は frontmatter の**後ろ**から始まる。実 vault の 17 file が
 * すべてこの形 (`---` block -> `> [!meta]- <id>` -> `^<id>` -> 本文)。
 */
export function frontmatterEnd(lines: readonly Line[]): number {
  const first = lines[0];
  if (first === undefined || first.text.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.text.trim() === "---") return line.next;
  }
  // 閉じていない frontmatter。file 全体を frontmatter にせず、無かったものとして扱う。
  return 0;
}

/**
 * 現行 Markdown の形をそのまま読む codec。
 *
 * 実装している形は次の 5 つ。
 *
 * 1. **locator = `path#heading` または bare `path`**。後者は file root node (裁定 Slice E)。
 * 2. **component の本文 region = heading 行と identity block を除いた section 本文**、
 *    末尾の空行を含まない。identity を region に入れると本文の全置換が stable ID を消す。
 * 3. **stable ID = node 直下の `^<id>` 行**。現行 Markdown (`docs/wish_dotfiles.md`) と
 *    `my-wish-data.md` の「node 単位の値は node 直下へ折りたたみ callout として置く」が根拠。
 * 4. **identity の置き場は未作成なら作る** (裁定 Slice E)。`> [!meta]- <id>` と `^<id>` の
 *    2 行を node 直下へ挿入する。実 heading 564 件のうち 554 件が callout を持たないので、
 *    作らない限り register が 98.2% で失敗する。
 * 5. **他 node の identity を含む span への write は止める** (裁定 Slice E)。read の範囲は変えない。
 *
 * **User / Agent / Plan は Markdown region ではない** (裁定 Slice E)。記法が未確定なのではなく
 * 存在しなかったので、`document_region_not_in_markdown` で落とす。
 */
export const headingSectionCodec: RegionCodec = {
  codec_id: "heading-section/v1",

  locateSection(raw: string, heading?: string): Result<Section> {
    const lines = splitLines(raw);
    const headings = headingIndices(lines);
    if (heading === undefined) return locateFileRoot(raw, lines, headings);
    const wanted = heading.trim();
    const matches = headings.filter((candidate) => candidate.title === wanted);
    if (matches.length === 0) {
      return err(
        "document_not_found",
        `heading が見つからない: ${JSON.stringify(wanted)}`,
        "locator",
      );
    }
    if (matches.length > 1) {
      // 一意に決まらないときは先着順で解決せず、何もせずに報告する。
      return err(
        "ambiguous_locator",
        `heading ${JSON.stringify(wanted)} が ${matches.length} 件ある`,
        "locator",
      );
    }
    const match = matches[0];
    if (match === undefined) {
      return err("document_not_found", "heading が見つからない", "locator");
    }
    return headingSectionAt(raw, lines, headings, match);
  },

  listSections(raw: string): Result<SectionListing> {
    return listSectionsOf(raw);
  },

  locateRegion(_raw: string, section: Section, target: RegionTarget): Result<Span> {
    if (target.kind === "component_body") return ok(section.body);
    // 「本文全体」へ倒さない。倒すと、User 宛の write が Agent 領域まで消す。
    return err(
      "document_region_not_in_markdown",
      `named region ${target.name} は Markdown region ではない。User / Agent / Plan は ` +
        `object 側 (chat_graph / decision_tree) が持つ (target=${formatRegionTarget(target)})`,
      "target_region",
    );
  },

  findIdAnchor(raw: string, section: Section): Result<IdAnchor | undefined> {
    const found: IdAnchor[] = [];
    for (const line of splitLines(raw)) {
      if (line.start < section.identity.start) continue;
      if (line.start >= section.identity.end) break;
      const match = ID_ANCHOR_LINE.exec(line.text);
      if (match === null) continue;
      found.push({ id: match[1] ?? "", span: { start: line.start, end: line.next } });
    }
    if (found.length > 1) {
      return err("ambiguous_locator", `section に block id anchor が ${found.length} 件ある`);
    }
    return ok(found[0]);
  },

  /**
   * identity を挿入する位置と text。
   *
   * **callout が有るか無いかで 2 通りに分かれる。**
   *
   * - 有る: その callout の直後へ `^<id>` 行だけを足す。
   * - 無い: `> [!meta]- <id>` と `^<id>` の 2 行を node 直下へ作る (裁定 Slice E、P3-a)。
   *
   * anchor 単独を heading 行の直後へ置くと Obsidian では次の block へ付くので意味が変わる。
   * **callout を先に作ればその問題が起きない。** anchor が callout の直後になる。
   */
  identityInsertion(raw: string, section: Section, componentId: string): Result<IdentityInsertion> {
    const newline = detectNewline(raw);
    const lines = splitLines(raw).filter((line) =>
      line.start >= section.identity.start && line.start < section.section_end
    );
    let index = 0;
    while (index < lines.length && isBlank(lines[index]?.text ?? "")) index += 1;
    const first = lines[index];
    if (first === undefined || !META_CALLOUT_OPEN.test(first.text)) {
      // 置き場は未定義ではなく未作成。register は identity を新規に付ける operation なので、
      // 置き場を作るのはこの operation の仕事 (裁定 Slice E)。
      return ok({
        offset: section.identity.start,
        text: `> [!meta]- ${componentId}${newline}^${componentId}${newline}`,
        creates_callout: true,
      });
    }
    let end = first.next;
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || !QUOTE_LINE.test(line.text)) break;
      end = line.next;
    }
    return ok({ offset: end, text: `^${componentId}${newline}`, creates_callout: false });
  },

  /**
   * span 内にある「この section 以外の」identity。
   *
   * `section.identity` の範囲は自分のものなので除く。それ以外の位置に `[!meta]` callout か
   * `^<id>` anchor があれば、それは子 heading node の identity である。
   *
   * **fence の中は見ない。** code 例の中の `^id` を identity として数えると、正当な write が
   * 落ちる。heading の判定と同じ理由で fence を飛ばす。
   */
  findForeignIdentity(raw: string, section: Section, span: Span): ForeignIdentity | undefined {
    let fence: { char: string; length: number } | undefined;
    for (const line of splitLines(raw)) {
      if (line.next <= span.start) continue;
      if (line.start >= span.end) break;
      const opened = fence;
      if (opened === undefined) {
        const marker = openingFence(line.text);
        if (marker !== undefined) {
          fence = marker;
          continue;
        }
      } else {
        if (closesFence(line.text, opened)) fence = undefined;
        continue;
      }
      // 自分の identity block は自分のものなので数えない。
      if (line.start >= section.identity.start && line.start < section.identity.end) continue;
      const anchor = ID_ANCHOR_LINE.exec(line.text);
      if (anchor !== null) {
        return {
          kind: "id_anchor",
          span: { start: line.start, end: line.end },
          ...(anchor[1] === undefined ? {} : { id: anchor[1] }),
        };
      }
      const callout = META_CALLOUT_OPEN.exec(line.text);
      if (callout !== null) {
        const title = (callout[1] ?? "").trim();
        return {
          kind: "property_callout",
          span: { start: line.start, end: line.end },
          ...(title.length === 0 ? {} : { id: title }),
        };
      }
    }
    return undefined;
  },
};

/**
 * file root node の section (裁定 Slice E、P3-b)。
 *
 * - `identity`: frontmatter の後ろから、`> [!meta]-` callout と `^<id>` anchor まで。
 * - `body`: identity の次から**最初の heading 行の直前**まで。
 * - `section_end`: 最初の heading 行の開始 (無ければ file 末尾)。
 *
 * **body を file 全体にしない。** heading は子 wish node なので、file 全体にすると file root の
 * body がすべての子 node を飲み込む。飲み込んだ範囲へ write すると必ず子の identity を含むので、
 * 裁定 1 の check で常に `rejected` になり、operation が使えなくなる。
 * 既存の reader がこの範囲に依存していないので、ここは使える形を選べる。
 */
/**
 * heading section 1 件の span を組む。**`locateSection` と `listSections` が同じ計算を使う。**
 * 2 か所に書くと、引いた section と一覧に出る section がずれる。
 */
function headingSectionAt(
  raw: string,
  lines: readonly Line[],
  headings: readonly { index: number; level: number; title: string }[],
  match: { index: number; level: number; title: string },
): Result<Section> {
  const headingLine = lines[match.index];
  if (headingLine === undefined) {
    return err("document_not_found", "heading 行を解決できない", "locator");
  }

  const next = headings.find((candidate) =>
    candidate.index > match.index && candidate.level <= match.level
  );
  const sectionEnd = next === undefined ? raw.length : (lines[next.index]?.start ?? raw.length);

  const sectionLines = lines.filter((line) =>
    line.start >= headingLine.next && line.start < sectionEnd
  );
  const identityEnd = identityBlockEnd(sectionLines, headingLine.next, sectionEnd);
  const bodyStart = identityEnd;
  let bodyEnd = sectionEnd;
  // 末尾の空行を region から外す。ここを含めると、本文を書き換えるたびに次の heading との
  // 間隔が動く。空行は非対象として file 側に残す。
  for (let i = sectionLines.length - 1; i >= 0; i -= 1) {
    const line = sectionLines[i];
    if (line === undefined || line.start < bodyStart) break;
    if (!isBlank(line.text)) {
      bodyEnd = Math.min(line.next, sectionEnd);
      break;
    }
    bodyEnd = line.start;
  }
  if (bodyEnd < bodyStart) bodyEnd = bodyStart;

  return ok({
    node: "heading",
    level: match.level,
    title: match.title,
    heading: { start: headingLine.start, end: headingLine.end },
    identity: { start: headingLine.next, end: identityEnd },
    body: { start: bodyStart, end: bodyEnd },
    section_end: sectionEnd,
  });
}

function listSectionsOf(raw: string): Result<SectionListing> {
  const lines = splitLines(raw);
  const headings = headingIndices(lines);
  const sections: ListedSection[] = [];

  const push = (section: Section, addressable: boolean): Result<undefined> => {
    const anchor = headingSectionCodec.findIdAnchor(raw, section);
    if (!anchor.ok) return anchor;
    sections.push({
      ...section,
      addressable,
      ...(anchor.value === undefined ? {} : { anchor: anchor.value }),
    });
    return ok(undefined);
  };

  const fileRoot = locateFileRoot(raw, lines, headings);
  if (!fileRoot.ok) return fileRoot;
  // file root node は heading を持たないので locator は常に一意。
  const rootPushed = push(fileRoot.value, true);
  if (!rootPushed.ok) return rootPushed;

  const counts = new Map<string, number>();
  for (const heading of headings) counts.set(heading.title, (counts.get(heading.title) ?? 0) + 1);

  for (const match of headings) {
    const section = headingSectionAt(raw, lines, headings, match);
    if (!section.ok) return section;
    // 同名 heading が複数ある node は `path#heading` で一意に指せない。**一覧からは落とさず、
    // 指せないことを field で示す。** 落とすと、その node が「無い」ように見える。
    const pushed = push(section.value, (counts.get(match.title) ?? 0) === 1);
    if (!pushed.ok) return pushed;
  }

  // どの section の identity block にも入らなかった `^<id>` 行。
  // **setext heading の下に置かれた anchor がここに出る。**現行 codec は setext を heading として
  // 読まないので、section 側からは痕跡が 1 つも残らない。一覧に出さないと静かに全部消える。
  const claimed = new Set<number>();
  for (const section of sections) {
    if (section.anchor !== undefined) claimed.add(section.anchor.span.start);
  }
  const unclaimed: IdAnchor[] = [];
  // **fence の中は見ない。** code 例の中の `^id` は anchor ではない。heading の判定と同じ理由で
  // fence を飛ばす — 閉じていない fence は文書末まで続くので、その中の `^id` も中身になる。
  let fence: { char: string; length: number } | undefined;
  let inFrontmatter = false;
  for (const [index, line] of lines.entries()) {
    if (index === 0 && line.text.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.text.trim() === "---") inFrontmatter = false;
      continue;
    }
    if (fence === undefined) {
      const marker = openingFence(line.text);
      if (marker !== undefined) {
        fence = marker;
        continue;
      }
    } else {
      if (closesFence(line.text, fence)) fence = undefined;
      continue;
    }
    const found = ID_ANCHOR_LINE.exec(line.text);
    if (found === null) continue;
    if (claimed.has(line.start)) continue;
    unclaimed.push({ id: found[1] ?? "", span: { start: line.start, end: line.next } });
  }

  return ok({ sections, unclaimed_anchors: unclaimed });
}

function locateFileRoot(
  raw: string,
  lines: readonly Line[],
  headings: readonly { index: number; level: number; title: string }[],
): Result<Section> {
  const start = frontmatterEnd(lines);
  const firstHeading = headings[0];
  const sectionEnd = firstHeading === undefined
    ? raw.length
    : (lines[firstHeading.index]?.start ?? raw.length);
  const sectionLines = lines.filter((line) => line.start >= start && line.start < sectionEnd);
  const identityEnd = identityBlockEnd(sectionLines, start, sectionEnd);
  let bodyEnd = sectionEnd;
  for (let i = sectionLines.length - 1; i >= 0; i -= 1) {
    const line = sectionLines[i];
    if (line === undefined || line.start < identityEnd) break;
    if (!isBlank(line.text)) {
      bodyEnd = Math.min(line.next, sectionEnd);
      break;
    }
    bodyEnd = line.start;
  }
  if (bodyEnd < identityEnd) bodyEnd = identityEnd;
  return ok({
    node: "file_root",
    level: 0,
    // title は file basename から導出すると `my-wish-data.md` が定めており、codec は path を
    // 知らない。導出は caller が行う。
    title: "",
    identity: { start, end: identityEnd },
    body: { start: identityEnd, end: bodyEnd },
    section_end: sectionEnd,
  });
}

/** region 置換後の文字列。非対象 region を 1 byte も触らない。 */
export function spliceSpan(raw: string, span: Span, replacement: string): string {
  return raw.slice(0, span.start) + replacement + raw.slice(span.end);
}

/**
 * 本文 content の唯一の正規化。
 *
 * 空でない content が改行で終わっていなければ改行を 1 つ足す。これをしないと、置換した本文が
 * 直後の空行や heading と同じ行で連結する。**これ以外の整形はしない。** 空行の数、indent、
 * 行末空白を勝手に直すと、非対象 region の保全と区別が付かなくなる。
 *
 * 足す改行は `newline` (呼び出し側が `detectNewline()` で取る)。**content 内部の改行は変えない。**
 * caller が LF で書いた本文を CRLF へ変換すると、caller の bytes を書き換えたことになる。
 * 揃えるのは「こちらが足した 1 つ」だけ。
 */
export function normalizeRegionContent(content: string, newline: string = "\n"): string {
  if (content.length === 0) return "";
  return content.endsWith("\n") ? content : `${content}${newline}`;
}

export function hashSpan(raw: string, span: Span): string {
  return documentHash(raw.slice(span.start, span.end));
}
