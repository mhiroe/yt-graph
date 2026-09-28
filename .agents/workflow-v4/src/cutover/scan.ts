// cutover の走査 (workflow-apm plan Phase F step 7)。
//
// repo / vault root 配下の Markdown に既に在る `^<id>` anchor をすべて分類する。
// **pure である。** file の列挙と読み取りは `VaultScanPort` の実装 (`cutover/fs_scan.ts`) が持ち、
// この file は渡された text だけで決まる。
//
// 分類は書き込まない。`^m-` / `^w-` / `^t-` の vault 形 ID は `cutover.bind` が
// `registerExistingVaultComponent` 経由で COMPONENTS へ結ぶ。**ここで採番しない。**

import type { Result } from "../result.ts";
import type { ComponentKind } from "../components.ts";
import { type DocumentLocator, formatDocumentLocator } from "../document.ts";
import { nodeTitle } from "../document_ops.ts";
import {
  closesFence,
  frontmatterEnd,
  hashSpan,
  headingSectionCodec,
  openingFence,
  splitLines,
} from "../region.ts";
import { locateTaskBlock } from "../task_block.ts";
import { isVaultComponentId, VAULT_ID_PREFIXES } from "../vault_ids.ts";

/**
 * Markdown の走査口。**dispatch は IO を持たない**ので、file 一覧と本文は port 経由で受ける。
 *
 * - `files()`: repo root からの相対 path (`/` 区切り、`.md` のみ) を返す。
 * - `read()`: file 本文を返す。読めない file は `err` で返し、呼び出し側が per-file の
 *   `unreadable` finding に畳む (crash しない)。
 */
export type VaultScanPort = {
  readonly files: () => readonly string[];
  readonly read: (path: string) => Result<string>;
};

/** anchor が document のどの位置に付いていたか。 */
export type ScannedAnchorNode =
  | "file_root"
  | "heading"
  | "task"
  | "block"
  | "unclaimed";

/** scan で見つけた `^<id>` 1 件。 */
export type ScannedAnchor = {
  /** anchor の id (`^` を除く)。vault 形とは限らない。 */
  readonly id: string;
  /** repo root からの相対 path。 */
  readonly path: string;
  readonly node: ScannedAnchorNode;
  /**
   * node を指す locator 文字列。file root は bare `path`、heading は `path#heading`、
   * task / block は `path#^<id>`。unclaimed は node を指せないので bare `path`。
   */
  readonly locator: string;
  /** `<m|w|t>-<Crockford base32 10 桁>` の形か。 */
  readonly vault_shaped: boolean;
  /** prefix から逆引きした kind 候補。`m|w|t` 以外の prefix では未設定。 */
  readonly kind_hint?: ComponentKind;
  /** node の表示 title。block / unclaimed では未設定。 */
  readonly title?: string;
  /** 観測 hash。task block が解決できない時と block / unclaimed では未設定。 */
  readonly body_hash?: string;
  /** task 行の checkbox の中身 (`x` / ` ` / `ready` など)。task node だけが持つ。 */
  readonly checkbox_state?: string;
};

/** file 1 件の走査で起きた、anchor 単位に帰属しない失敗。 */
export type ScanFileError = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

/** repo 全体の走査結果。 */
export type ScanResult = {
  readonly anchors: readonly ScannedAnchor[];
  /** id -> その id を持つ anchor 全部。重複判定と監査の照合に使う。 */
  readonly by_id: ReadonlyMap<string, readonly ScannedAnchor[]>;
  /** 2 か所以上に anchor がある id。**bind は両方を skip する (推測 merge しない)。** */
  readonly duplicates: readonly string[];
  /** file 単位の走査失敗 (section listing を構成できない等)。 */
  readonly errors: readonly ScanFileError[];
  /**
   * frontmatter が `generated` tag を持つ file の path (走査から外した派生 view)。
   * `generate_task_view.py` が書く `task_view.md` など — 正本の anchor を複写して
   * 持つので、数えると必ず duplicate になる。情報として残すが失敗ではない。
   */
  readonly skipped_derived: readonly string[];
  /** 読めた file の本文。bind の mind `children` 観測が使う。scan result には載せない。 */
  readonly sources: ReadonlyMap<string, string>;
};

// task 行と行末 anchor の判定。**`src/task_block.ts` (artifact; not editable) の private
// regex と同じ形。こちらを変える時は向こうの TASK_LINE / LINE_END_ANCHOR と sync を保つ。**
const TASK_LINE = /^([ \t]*)-[ \t]+\[([^\]\r\n]*)\][ \t]+(.*?)[ \t]*$/;
const LINE_END_ANCHOR = /[ \t]\^([A-Za-z0-9][A-Za-z0-9._-]{0,63})[ \t]*$/;

/** `<prefix>-` の prefix から kind 候補を引く。`VAULT_ID_PREFIXES` が正本。 */
function kindHintOf(id: string): ComponentKind | undefined {
  const prefix = id.slice(0, id.indexOf("-"));
  for (const kind of Object.keys(VAULT_ID_PREFIXES) as ComponentKind[]) {
    if (VAULT_ID_PREFIXES[kind] === prefix) return kind;
  }
  return undefined;
}

/**
 * anchor が vault の workflow identity を意図しているか。
 *
 * **判定は prefix だけ。** `m` / `w` / `t` で始まる id は vault-intended で、形が壊れている
 * もの (`^t-xyz` 等) は vault の書き損じとして `invalid` 側で報告する。それ以外 —
 * Excalidraw の `^OZzwVAY6` のような element id、脚注、他ツールの block id — は foreign で、
 * 実 vault には数百件ある。foreign は bind も audit も**失敗に数えない**。
 *
 * vault 形の anchor は必ず `kind_hint` を持つので、`kind_hint === undefined` ⇔ foreign。
 */
export function anchorIntent(anchor: ScannedAnchor): "vault" | "foreign" {
  return anchor.kind_hint === undefined ? "foreign" : "vault";
}

/**
 * frontmatter の `tags` が `generated` を含む file は派生 view (`task_view.md` 等)。
 * 正本の `^<id>` を複写して持つので、走査対象にすると必ず duplicate になる。
 * **`generated` 1 語だけを見る。** YAML parser ではない — `frontmatterKind`
 * (`src/children.ts`) と同じく、見慣れた 3 形 (block list / inline list / scalar) だけを読む。
 */
export function isGeneratedView(raw: string): boolean {
  const lines = splitLines(raw);
  const end = frontmatterEnd(lines);
  if (end === 0) return false;
  const fm = lines.slice(1).filter((line) => line.next <= end);
  const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");
  for (const [index, line] of fm.entries()) {
    const key = /^tags[ \t]*:[ \t]*(.*)$/.exec(line.text);
    if (key === null) continue;
    const rest = (key[1] ?? "").trim();
    if (rest.startsWith("[")) {
      // inline list: `tags: [task-view, generated]`
      const items = rest.slice(1).replace(/\]\s*$/, "").split(",");
      if (items.some((item) => unquote(item.trim()) === "generated")) return true;
      continue;
    }
    if (rest === "") {
      // block list: `tags:` の下の `- item` 行。次の top-level key で止まる。
      for (const item of fm.slice(index + 1)) {
        const entry = /^[ \t]+-[ \t]*(.*?)[ \t]*$/.exec(item.text);
        if (entry === null) break;
        if (unquote(entry[1] ?? "") === "generated") return true;
      }
      continue;
    }
    // scalar: `tags: generated`
    if (unquote(rest) === "generated") return true;
  }
  return false;
}

function base(id: string, path: string, node: ScannedAnchorNode, locator: string): ScannedAnchor {
  const vaultShaped = isVaultComponentId(id);
  const kind = kindHintOf(id);
  return {
    id,
    path,
    node,
    locator,
    vault_shaped: vaultShaped,
    ...(kind === undefined ? {} : { kind_hint: kind }),
  };
}

/**
 * file 1 件の anchor をすべて分類する。
 *
 * - section (file root / heading) の identity anchor は codec の `listSections` が拾う。
 * - checkbox 行の行末 `^<id>` は task node、それ以外の行末 `^<id>` は block node。
 * - どの node にも属さない standalone `^<id>` は unclaimed。**bind できないが必ず報告する。**
 *
 * codec が section listing を構成できない file でも、行末 anchor の走査は続ける
 * (standalone anchor の claimed/unclaimed だけは判定できず、error として報告する)。
 */
export function scanFile(raw: string, path: string): {
  readonly anchors: ScannedAnchor[];
  readonly errors: ScanFileError[];
} {
  const anchors: ScannedAnchor[] = [];
  const errors: ScanFileError[] = [];

  const listing = headingSectionCodec.listSections(raw);
  if (!listing.ok) {
    errors.push({ path, code: listing.error.code, message: listing.error.message });
  } else {
    for (const section of listing.value.sections) {
      const anchor = section.anchor;
      if (anchor === undefined) continue;
      const locator: DocumentLocator = section.node === "file_root"
        ? { path }
        : { path, heading: section.title };
      const found = base(anchor.id, path, section.node, formatDocumentLocator(locator));
      anchors.push({
        ...found,
        title: nodeTitle(section, locator),
        body_hash: hashSpan(raw, section.body),
      });
    }
    // codec がどの node の identity にも結べなかった anchor。場所は分かるが owner が無い。
    for (const unclaimed of listing.value.unclaimed_anchors) {
      anchors.push(base(unclaimed.id, path, "unclaimed", path));
    }
  }

  // 行末 anchor の走査。fence の中と frontmatter の中は見ない。
  // 規則は `listSectionsOf` (`src/region.ts`) と同じ — fence は marker の種別と長さの両方で閉じる。
  let fence: { char: string; length: number } | undefined;
  let inFrontmatter = false;
  for (const [index, line] of splitLines(raw).entries()) {
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

    const task = TASK_LINE.exec(line.text);
    if (task !== null) {
      const end = LINE_END_ANCHOR.exec(line.text);
      if (end === null) continue;
      const id = end[1] ?? "";
      // 行末の ` ^<id>` を除いた残りが task の表示 text。
      const title = (task[3] ?? "").replace(LINE_END_ANCHOR, "");
      const block = locateTaskBlock(raw, id);
      anchors.push({
        ...base(id, path, "task", `${path}#^${id}`),
        title,
        ...(block.ok ? { body_hash: block.value.hash } : {}),
        checkbox_state: task[2] ?? "",
      });
      continue;
    }
    const end = LINE_END_ANCHOR.exec(line.text);
    if (end === null) continue;
    const id = end[1] ?? "";
    anchors.push(base(id, path, "block", `${path}#^${id}`));
  }

  return { anchors, errors };
}

/** `scanFile` の anchor だけを返す薄い口。file 単位の失敗が要る caller は `scanFile` を使う。 */
export function scanFileAnchors(raw: string, path: string): ScannedAnchor[] {
  return scanFile(raw, path).anchors;
}

/**
 * repo 全体の走査。`files` は既に読み終わった `{path, raw}` の列 (読み取り失敗は
 * `VaultScanPort` の呼び出し側が畳む)。
 *
 * **重複 id はここで検出するだけ。**「同じ id が 2 か所」を勝手に 1 つへ寄せない —
 * bind 側が両方を skip して報告する。
 */
export function scanRepository(files: readonly { path: string; raw: string }[]): ScanResult {
  const anchors: ScannedAnchor[] = [];
  const errors: ScanFileError[] = [];
  const skippedDerived: string[] = [];
  const sources = new Map<string, string>();
  const byId = new Map<string, ScannedAnchor[]>();
  for (const file of files) {
    // 派生 view (`generated` tag) は正本の anchor を複写するだけなので走査から外す。
    // bind / audit のどちらにも identity source として渡さない。
    if (isGeneratedView(file.raw)) {
      skippedDerived.push(file.path);
      continue;
    }
    sources.set(file.path, file.raw);
    const scanned = scanFile(file.raw, file.path);
    errors.push(...scanned.errors);
    for (const anchor of scanned.anchors) {
      anchors.push(anchor);
      const bucket = byId.get(anchor.id);
      if (bucket === undefined) {
        byId.set(anchor.id, [anchor]);
      } else {
        bucket.push(anchor);
      }
    }
  }
  const duplicates = [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id]) => id)
    .sort();
  return {
    anchors,
    by_id: byId,
    duplicates,
    errors,
    skipped_derived: skippedDerived.sort(),
    sources,
  };
}
