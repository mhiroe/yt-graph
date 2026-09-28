// task node の block を読む codec (artifact 0.11.0、task 自身の callout は 0.12.0)。**task の所属を Markdown へ書くための境界。**
//
// **pure である。** file を読まない。`region.ts` / `children.ts` と同じく、引数の文字列だけで決まる。
//
// task の所属は `children` では表さない (`my-wish-data.md` :24 / :49 / :267)。**task は checkbox 行で、
// どの wish の file / section に置かれているかが所属である。**task を別の wish へ移すとは、
// checkbox 行を `^t-...` anchor と nest した子 task ごと、移動先 wish の section へ運ぶこと。
//
// 実測 (mon_wish 2026-09-21、`.trash` を除く): task 行 256 件はすべて `- [<state>] ` で始まり、
// 行末 anchor ` ^t-<id>` を持つものが 64 件。nest は 2 space だけ (tab 0 件)。anchor 付き task の
// 下には、より深い indent の補足 bullet / 継続行 / indent した引用が続き、それらの間に空行を挟む。

import { err, ok, type Result } from "./result.ts";
import { documentHash } from "./document.ts";
import { closesFence, type Line, openingFence, type Span, splitLines } from "./region.ts";

/** task 行。`- [<state>] <text>`。marker は実測が全件 `-` なので `-` だけを読む。 */
const TASK_LINE = /^([ \t]*)-[ \t]+\[([^\]\r\n]*)\][ \t]+(.*?)[ \t]*$/;
/** 行末の block id。Obsidian の block reference と同じ形。 */
const LINE_END_ANCHOR = /[ \t]\^([A-Za-z0-9][A-Za-z0-9._-]{0,63})[ \t]*$/;
/** 単独行の block id。heading / file root node の identity。 */
const STANDALONE_ANCHOR = /^[ \t]*\^([A-Za-z0-9][A-Za-z0-9._-]{0,63})[ \t]*$/;
/**
 * list の中へ indent された callout も含めて数える。title (node の id) を取る。
 *
 * **title が運ぶ task 自身か block 内の子孫 task の id なら、その task の property として
 * block と一緒に運ぶ** (裁定 root PM 2026-09-21、子 task への適用は bugfix 9)。
 * `my-wish-data.md` の例が task の callout を `> [!meta]- t-01M0RQPF3K` (title = task id、
 * task 行の下に indent) と定めている。**title が空か別 id のものは止める。**位置から所有者が
 * 決まらない。
 */
const META_CALLOUT = /^[ \t]*>[ \t]*\[!meta\][-+]?[ \t]*(.*?)[ \t]*$/i;
const TASK_ID_PREFIX = "t-";

/** block の中に見つかった、運んではいけない identity。 */
export type TaskForeignIdentity = {
  readonly kind: "property_callout" | "id_anchor";
  readonly line: string;
  readonly id?: string;
};

export type TaskBlock = {
  /** task 行頭から block 最終行の次の行頭まで。**行終端まで含む。** */
  readonly span: Span;
  /** task 行の indent。運ぶ時に block 全体からこれを外す。 */
  readonly indent: string;
  /** checkbox の中身 (`done` / ` ` / `ready` など)。未知の値も壊さずそのまま返す。 */
  readonly state: string;
  /** block の raw text。`expected_hash` の入力。 */
  readonly text: string;
  readonly hash: string;
  /** nest した子 task の id。block と一緒に運ぶ。 */
  readonly child_task_ids: readonly string[];
  /** 運んではいけない identity。**あれば move は止まる。** */
  readonly foreign?: TaskForeignIdentity;
};

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function leading(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

/** `base` より深い indent か。**prefix で比べる。**tab と space を混ぜた indent を幅で換算しない。 */
function deeper(text: string, base: string): boolean {
  const indent = leading(text);
  return indent.startsWith(base) && indent.length > base.length;
}

/**
 * fence の外にある task 行で、行末 anchor が `taskId` のもの。
 *
 * **code 例の中の task 行を数えない。**`my-wish-data.md` 自身が ```ts の中に `^t-...` を持つ。
 */
function taskLineIndices(lines: readonly Line[], taskId: string): number[] {
  const found: number[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
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
    if (!TASK_LINE.test(line.text)) continue;
    if (LINE_END_ANCHOR.exec(line.text)?.[1] === taskId) found.push(index);
  }
  return found;
}

/**
 * task の block を引く。
 *
 * **範囲は list nest で決める。**task 行より深い indent の行と、深い行が後ろに続く空行までが block。
 * 同じか浅い indent の行 (次の task、heading、本文) で終わる。
 */
export function locateTaskBlock(raw: string, taskId: string): Result<TaskBlock> {
  const lines = splitLines(raw);
  const indices = taskLineIndices(lines, taskId);
  if (indices.length === 0) {
    return err("document_not_found", `task ^${taskId} の checkbox 行が無い`, "component_id");
  }
  if (indices.length > 1) {
    // 一意に決まらない。**先着順で解決しない。**
    return err(
      "ambiguous_locator",
      `task ^${taskId} の checkbox 行が ${indices.length} 件ある`,
      "component_id",
    );
  }
  const start = indices[0] as number;
  const head = lines[start] as Line;
  const match = TASK_LINE.exec(head.text);
  const indent = match?.[1] ?? "";
  let end = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as Line;
    if (isBlank(line.text)) {
      // 空行は、その後ろに深い行が続く時だけ block に入れる。末尾の空行は block の外に残す。
      const next = lines.slice(i + 1).find((candidate) => !isBlank(candidate.text));
      if (next === undefined || !deeper(next.text, indent)) break;
      continue;
    }
    if (!deeper(line.text, indent)) break;
    end = i;
  }
  const last = lines[end] as Line;
  const span = { start: head.start, end: last.next };
  const text = raw.slice(span.start, span.end);

  const childTaskIds: string[] = [];
  // callout の title が自分か子孫 task の id かは、block を最後まで走査して子孫を全部拾って
  // からでないと決まらない。出現順を保って一旦全部溜め、判定は走査後に行う。
  const suspects: {
    readonly kind: "property_callout" | "id_anchor";
    readonly line: string;
    readonly title?: string;
    readonly id?: string;
  }[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of lines.slice(start + 1, end + 1)) {
    const body = line.text.trimStart();
    const opened = fence;
    if (opened === undefined) {
      const marker = openingFence(body);
      if (marker !== undefined) {
        fence = marker;
        continue;
      }
    } else {
      if (closesFence(body, opened)) fence = undefined;
      continue;
    }
    const callout = META_CALLOUT.exec(line.text);
    if (callout !== null) {
      suspects.push({ kind: "property_callout", line: line.text, title: callout[1] ?? "" });
      continue;
    }
    const standalone = STANDALONE_ANCHOR.exec(line.text);
    if (standalone !== null) {
      suspects.push({ kind: "id_anchor", line: line.text, ...idOf(standalone[1]) });
      continue;
    }
    const anchor = LINE_END_ANCHOR.exec(line.text);
    if (anchor === null) continue;
    const id = anchor[1] ?? "";
    // nest した子 task の anchor は block の一部なので一緒に運ぶ。それ以外の anchor は他 node。
    if (TASK_LINE.test(line.text) && id.startsWith(TASK_ID_PREFIX)) {
      childTaskIds.push(id);
    } else {
      suspects.push({ kind: "id_anchor", line: line.text, id });
    }
  }
  // block に含まれる子孫 task の id は、その task の property callout として一緒に運べる。
  const ownCalloutIds = new Set([taskId, ...childTaskIds]);
  let foreign: TaskForeignIdentity | undefined;
  for (const suspect of suspects) {
    if (suspect.kind === "property_callout") {
      if (ownCalloutIds.has(suspect.title ?? "")) continue;
      foreign = {
        kind: "property_callout",
        line: suspect.line,
        ...idOf(suspect.title || undefined),
      };
    } else {
      foreign = { kind: "id_anchor", line: suspect.line, ...idOf(suspect.id) };
    }
    break;
  }

  return ok({
    span,
    indent,
    state: match?.[2] ?? "",
    text,
    hash: documentHash(text),
    child_task_ids: childTaskIds,
    ...(foreign === undefined ? {} : { foreign }),
  });
}

function idOf(value: string | undefined): { id?: string } {
  return value === undefined ? {} : { id: value };
}

/**
 * 運ぶ block を移動先の形へ直す。**task 行の indent だけを外し、nest の相対深度は保つ。**
 *
 * 改行は移動先 document に揃える。file を跨ぐと改行の流儀が違うことがあり、揃えないと
 * 1 file に LF と CRLF が混ざる。
 */
export function relocatedTaskText(block: TaskBlock, newline: string): Result<string> {
  const lines = block.text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    if (isBlank(line)) {
      out.push("");
      continue;
    }
    if (!line.startsWith(block.indent)) {
      return err(
        "document_structure_unreadable",
        "task block の行が task 行の indent で始まらない。nest を保って運べない",
        "component_id",
      );
    }
    out.push(line.slice(block.indent.length));
  }
  return ok(out.map((line) => `${line}${newline}`).join(""));
}

/** 比較用。indent を外し、改行を揃えた block。 */
export function taskBlockShape(block: TaskBlock): string {
  const relocated = relocatedTaskText(block, "\n");
  return relocated.ok ? relocated.value : `(unreadable) ${block.text}`;
}

/** list の行か。移動先で直前が list なら空行を挟まずに続ける。 */
export function isListLine(text: string): boolean {
  return /^[ \t]*[-*+][ \t]/.test(text) || /^[ \t]+\S/.test(text);
}
