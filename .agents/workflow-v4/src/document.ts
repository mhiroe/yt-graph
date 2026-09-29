// DocumentPort と DocumentProjectionPort の共有型。
//
// **この file は pure contract である。** filesystem、hash binding、SQL を辿らない。
// 実際の file 読み書きは `adapters/fs_document.ts`、projection の永続化は
// `sql/document_projection.ts` が持つ。
//
// `docs/candidate/workflow-v4/interfaces.md` の DocumentPort / DocumentProjectionPort が正本。
// raw body 全置換と field 名指定の generic patch は**公開しない**。公開するのは
// 「どの component の、どの region を、どの hash の上で書き換えるか」という typed intent だけ。

import { err, ok, type Result, type WorkflowErrorCode } from "./result.ts";
import { type ComponentId, joinPath, parseComponentId } from "./ids.ts";
import type { Disposition } from "./responses.ts";
import type { ComponentKind, Revision } from "./components.ts";
import type { ChildEntry } from "./children.ts";
import type { IterationProperties } from "./iterations.ts";

/**
 * Markdown 上の位置。**identity ではない。** identity は `repository_id + component_id`。
 *
 * 形は `path#heading`。wishboard 側 observer の `locatorOf(path, heading)` と同じ形にしてある
 * (`visualiser5/v4/src/model/vault-observation.ts`)。両側が別の形を持つと、observer が通知した
 * locator で document を開けなくなる。
 */
export type DocumentLocator = {
  /** repo root からの相対 path。絶対 path と親 escape は受け付けない。 */
  readonly path: string;
  /**
   * heading text。`#` marker を含まない。
   *
   * **未設定は file root node を指す** (裁定 Slice E)。`my-wish-data.md` の node model が
   * 「Markdown file は file root node を表す」と定めており、実 vault の `^<id>` anchor は
   * 17 file すべてが file root 直下にある (Slice E 第 1 段の実測)。heading 形だけを受けると
   * 実データの node の大半を指せない。
   */
  readonly heading?: string;
};

/** file root node かどうか。`heading` の有無を毎回書かないための 1 か所。 */
export function isFileRootLocator(locator: DocumentLocator): boolean {
  return locator.heading === undefined;
}

/**
 * locator を文字列へ戻す。**file root node は `#` ごと省いた bare path。**
 *
 * `path#` (空 heading) を file root の表現に採らない。「heading があって名前が空」とも読めて
 * 曖昧になる (root PM 裁定)。
 */
export function formatDocumentLocator(locator: DocumentLocator): string {
  return locator.heading === undefined ? locator.path : `${locator.path}#${locator.heading}`;
}

/**
 * locator string を分解する。repo root の外を指す path をここで落とす。
 *
 * path 側に `#` を許さないので、最初の `#` で切る。`#` を含む path を作らないのは
 * Obsidian の link 形式と衝突するため。
 *
 * **`#` を持たない文字列は file root node として受ける** (裁定 Slice E)。`#` があって heading が
 * 空の `path#` は**受けない**。file root を指す形を 1 つに保つ。
 */
export function parseDocumentLocator(value: unknown, path?: string): Result<DocumentLocator> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "locator は string である必要がある", path);
  }
  const index = value.indexOf("#");
  if (index === 0) {
    return err("invalid_locator", `locator の path が空である: ${value}`, path);
  }
  if (index < 0) {
    // file root node。`#` が無い形だけがこれを表す。
    const checked = checkRelativePath(value, path);
    if (!checked.ok) return checked;
    return ok({ path: checked.value });
  }
  const filePath = value.slice(0, index);
  const heading = value.slice(index + 1).trim();
  if (heading.length === 0) {
    return err(
      "invalid_locator",
      `locator の heading が空である。file root node は \`#\` ごと省いた path で指す: ${value}`,
      path,
    );
  }
  const checked = checkRelativePath(filePath, path);
  if (!checked.ok) return checked;
  return ok({ path: checked.value, heading });
}

/**
 * repo root の外へ出る path を拒否する。**lexical な検査で、symlink までは見ない。**
 * symlink 越えの検査は filesystem を触れる adapter 側が持つ。
 */
export function checkRelativePath(value: string, path?: string): Result<string> {
  if (value.length === 0) {
    return err("invalid_locator", "locator の path が空である", path);
  }
  if (value.includes("\0")) {
    return err("invalid_locator", "locator の path に NUL が含まれる", path);
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return err("locator_escapes_repository", `絶対 path は受け付けない: ${value}`, path);
  }
  const segments = value.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "..") {
      return err("locator_escapes_repository", `repo root の外を指す path: ${value}`, path);
    }
  }
  return ok(value);
}

/**
 * `document.create_file` / `document.create_task` が受け付ける path の検査 (kind 名は
 * error message だけに使う)。
 *
 * identity を書く file は scan / bind / audit の対象でなければならない — **見えない場所に
 * identity を書くと audit が追えない**。範囲は `fs_scan.ts` の走査対象と同じ: `.md` file で、
 * `.` で始まる segment と `node_modules` を含まない。`checkRelativePath` の root escape /
 * NUL / 絶対 path 検査の上に載せる。symlink 越えは adapter 側が見る。
 */
function checkScannableMarkdownPath(
  value: string,
  kind: string,
  path?: string,
): Result<string> {
  const checked = checkRelativePath(value, path);
  if (!checked.ok) return checked;
  if (!value.toLowerCase().endsWith(".md")) {
    return err(
      "invalid_locator",
      `${kind} の対象は .md file のみ: ${value}`,
      path,
    );
  }
  for (const segment of value.split("/")) {
    if (segment.startsWith(".")) {
      return err(
        "invalid_locator",
        `scan 対象外の directory / file を指す path: ${value}`,
        path,
      );
    }
    if (segment === "node_modules") {
      return err(
        "invalid_locator",
        `scan 対象外の directory を指す path: ${value}`,
        path,
      );
    }
  }
  return checked;
}

export function checkCreateFilePath(value: string, path?: string): Result<string> {
  return checkScannableMarkdownPath(value, "create_file", path);
}

/** `document.create_task` の置き先 file の検査。task 行も scan / audit の対象。 */
export function checkCreateTaskPath(value: string, path?: string): Result<string> {
  return checkScannableMarkdownPath(value, "create_task", path);
}

/**
 * named region の語彙。`interfaces.md` の「User、Agent、Plan を named region として区別する」。
 *
 * **裁定 (Slice E): この 3 つは Markdown region ではない。** 記法が未確定だったのではなく、
 * Markdown に存在しなかった。実 vault 199 file、shared skill `wish-chat`、`my-wish-data.md` の
 * 「正本の切り分け」が揃って、User の原文と Plan を object 側 (`chat_graph` / `decision_tree` /
 * `<id>.chat.md`) に置いている。
 *
 * **語彙は union に残す。** 落とすと、どの領域を指した呼び出しだったかが分からなくなり、
 * 呼び出し側が `component_body` で代用しはじめる。codec は `document_region_not_in_markdown`
 * で落とし、**「本文全体」へ倒さない**。
 *
 * 読み口の新設先 (`WorkflowReadPort` か別 port か) はまだ決めない。実際に読む側が現れた時に
 * その実測で決める (root PM 裁定)。
 */
export const DOCUMENT_REGION_NAMES = ["user", "agent", "plan"] as const;
export type DocumentRegionName = (typeof DOCUMENT_REGION_NAMES)[number];

/**
 * 書き換え対象の region。
 *
 * - `component_body`: component 自身の heading section 本文。**現在唯一 addressable な region。**
 *   heading 行と identity block (property callout / `^<id>` anchor) を含まない。範囲の正本は
 *   `region.ts` の `Section`。wishboard observer の `observed_hash` 入力範囲と一致する保証は
 *   まだ無い (向こうも未確定)。実 vault reader を作る時に揃える。
 * - `named`: User / Agent / Plan。記法未確定のため codec が解決できない。
 */
export type RegionTarget =
  | { readonly kind: "component_body" }
  | { readonly kind: "named"; readonly name: DocumentRegionName };

export const COMPONENT_BODY_REGION: RegionTarget = { kind: "component_body" };

export function parseRegionName(value: unknown, path?: string): Result<DocumentRegionName> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "region name は string である必要がある", path);
  }
  const name = DOCUMENT_REGION_NAMES.find((candidate) => candidate === value);
  if (name === undefined) {
    return err("unknown_region_name", `未知の named region: ${JSON.stringify(value)}`, path);
  }
  return ok(name);
}

/** wire 形は `"component_body"` か `{ named: "user" }`。unknown 値を既定値へ落とさない。 */
export function parseRegionTarget(value: unknown, path?: string): Result<RegionTarget> {
  if (value === "component_body") return ok(COMPONENT_BODY_REGION);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === "named") {
      const name = parseRegionName(raw["named"], joinPath(path, "named"));
      if (!name.ok) return name;
      return ok({ kind: "named", name: name.value });
    }
  }
  return err(
    "unknown_region_name",
    `target_region は "component_body" か { named: ... } である必要がある`,
    path,
  );
}

export function formatRegionTarget(target: RegionTarget): string {
  return target.kind === "component_body" ? "component_body" : `named:${target.name}`;
}

/**
 * document content の hash。
 *
 * **FNV-1a 32bit。** wishboard 側 observer (`stableHash`) と**同じ algorithm を使う**。
 * observer が出した `observed_hash` を DocumentPort の `expected_hash` としてそのまま渡せないと、
 * 正しい read-modify-write が毎回 conflict になる。crypto を import しないのは、artifact が
 * `node:` / URL import を禁じているのと、用途が「前回と変わったか」の判定だけで衝突耐性を
 * 要求しないため。**署名にも同一性証明にも使わない。**
 */
export function documentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `document.read_raw` の戻り。raw は component 自身の section だけで、file 全体ではない。 */
export type DocumentView = {
  readonly component_id: ComponentId;
  readonly locator: string;
  readonly title: string;
  /** heading 行を含む section の raw text。 */
  readonly raw: string;
  /** heading 行を含まない本文。`observed_hash` の入力。 */
  readonly body: string;
  readonly observed_hash: string;
};

/**
 * document operation の結果。`CommandResponse` を再利用しない。
 * document operation は workflow command ではなく、`operation_id` も receipt も持たない。
 */
export type DocumentOutcome = {
  readonly disposition: Disposition;
  readonly component_id?: ComponentId;
  readonly locator?: string;
  /** write 後 (noop なら現在) の本文 hash。次の read-modify-write がそのまま使える。 */
  readonly observed_hash?: string;
  /**
   * 落ちた理由の機械可読な code (裁定 root PM 2026-09-15、Slice F1 の O5-1)。
   *
   * **`rejected` を散文だけで返さない。**以前は `document_region_not_in_markdown` /
   * `document_region_contains_foreign_identity` / `title_rename_requires_file_move` を
   * `WorkflowErrorCode` に持ちながら、`disposition=rejected` + 日本語の `reason` へ畳んでいた。
   * 呼び出し側は理由を機械的に区別できず、reason を読むしかなかった。
   *
   * `applied` / `noop` では設定しない。`conflict` は disposition 自体が理由なので設定しない。
   */
  readonly code?: WorkflowErrorCode;
  readonly reason?: string;
};

/**
 * locator が指す node 1 件の観測 (裁定 root PM 2026-09-15、Slice F1 の O1-2)。
 *
 * **`register_component_id` へ渡す `expected_hash` を、register 前に引くための口。**
 * `readRaw` は component_id 解決が前提なので、**まだ register していない node には使えない**。
 * これが無いと、codec を import できない consumer (shell / skill) は register できなかった。
 */
export type DocumentNodeView = {
  readonly locator: string;
  readonly node: "heading" | "file_root";
  /** heading の深さ。file root node は `0`。 */
  readonly level: number;
  readonly title: string;
  /** `path#heading` で一意に指せるか。同名 heading が複数ある node は `false`。 */
  readonly addressable: boolean;
  /** 本文 hash。`expected_hash` / `expected_region_hash` へそのまま渡せる。 */
  readonly body_hash: string;
  /** 既に付いている stable ID。未 register の node では未設定。 */
  readonly component_id?: ComponentId;
};

/** file 1 つ分の node 一覧 (`listSections` の DocumentPort 側の顔)。 */
export type DocumentFileNodes = {
  readonly path: string;
  readonly nodes: readonly DocumentNodeView[];
  /**
   * codec がどの node にも結び付けられなかった `^<id>`。
   * **空でなければ、その file に codec が読めない node がある。**
   */
  readonly unclaimed_anchors: readonly string[];
};

/**
 * `document.create_file` の入力 (iPhone write channel の新規 file 作成口)。
 *
 * **`component_id` は caller ではなく Core が採番した値を受け取る** (発番点 1 つの規則 —
 * `RegisterComponentIdInput` と同じ裁定)。path は `checkCreateFilePath` を通した、
 * scan 対象内の repo 相対 `.md` path。
 */
export type CreateFileInput = {
  readonly path: string;
  readonly component_id: ComponentId;
  /** frontmatter `kind:` に書く component kind。採番した id の prefix と一致する。 */
  readonly component_kind: ComponentKind;
  /** identity block の後に置く本文。空文字も許す (空の node file を作れる)。 */
  readonly content: string;
  /**
   * generated iteration key (`iteration` / `iteration_label` / `iteration_created`、schema 6)。
   *
   * **caller が DB の membership から導出して渡す。**Core 側は与えられた値を書くだけで、
   * ここで iteration を推測しない。iteration dir の外に作る file では未設定のままにする
   * (key が無い = pre-iteration scope)。
   */
  readonly iteration_properties?: IterationProperties;
};

/**
 * `stampIterationProperties` の入力。member doc は component でないので `path` で指す
 * (schema 6 の `iteration_doc_members` と同じく path-keyed)。
 */
export type StampIterationPropertiesInput = {
  /** repo root 相対の `.md` path。`#` fragment は受けない (file 全体への書き込み)。 */
  readonly path: string;
  readonly properties: IterationProperties;
};

export type RegisterComponentIdInput = {
  readonly locator: DocumentLocator;
  readonly expected_hash: string;
  /**
   * 付与する stable ID。
   *
   * **裁定 (Slice C)**: `interfaces.md` の 2 引数表記に対し、component_id を入力として受け取る。
   * 発番点は 1 つに集約する規則があり (`my-wish-data.md` の `id`)、DocumentPort が独自に採番すると
   * 発番点が 2 つになる。wishboard 側 `ports.md` の `document.register_stable_id` も
   * component_id を引数に持っている。
   */
  readonly component_id: ComponentId;
};

export type RenameTitleInput = {
  readonly component_id: ComponentId;
  readonly expected_hash: string;
  readonly title: string;
};

export type ReplaceRegionInput = {
  readonly component_id: ComponentId;
  readonly target_region: RegionTarget;
  readonly expected_region_hash: string;
  readonly content: string;
};

/**
 * 親 node の `children` property の観測 (artifact 0.10.0)。
 *
 * **所属の正本は親 node の `children` property** (`my-wish-data.md` の hierarchy 節)。
 * `attach_child` / `detach_child` へ渡す `expected_hash` はここの `children_hash` を使う。
 */
export type DocumentChildrenView = {
  readonly component_id: ComponentId;
  readonly locator: string;
  /**
   * frontmatter に `children` key があるか。**false でも空 list と同じ意味で読める**が、
   * frontmatter 自体が無い file (`writable=false`) には attach できない。
   */
  readonly present: boolean;
  /** attach で書けるか。frontmatter を持たない file では false。 */
  readonly writable: boolean;
  readonly children: readonly ChildEntry[];
  /** `children` property の raw text の hash。key が無ければ空文字の hash。 */
  readonly children_hash: string;
};

/**
 * 所属の書き。**親を component_id で、子を vault 上の link target か wish の id で指す。**
 *
 * - `child_link`: node link (`[[...]]`)。link の形 (vault root からの path) を Core が決められない
 *   ので、bridge が vault 上の link target を渡す。
 * - `child_id` (artifact 0.13.0): **mind が wish を id で持つ要素。**親は `kind: mind` の file だけ。
 *   id は wish の移動・改名で変わらないので、mind の file を書き直さずに済む
 *   (`my-wish-data.md` の hierarchy 節)。**どちらか 1 つだけを渡す。**
 */
export type ChildLinkInput =
  & {
    /** 親 node。**file root node だけ**が `children` を持てる。 */
    readonly component_id: ComponentId;
    readonly expected_hash: string;
  }
  & (
    | {
      /** `[[` `]]` を含まない link target。例: `wishboard/docs/wish_wishboard`。 */
      readonly child_link: string;
      readonly child_id?: undefined;
    }
    | {
      /**
       * attach では vault 形の wish id (`w-...`)。detach では要素の値そのもの
       * (形が不正な broken 要素も明示の操作で外せる)。
       */
      readonly child_id: string;
      readonly child_link?: undefined;
    }
  );

/**
 * file 内の heading node の移動 (artifact 0.10.0)。
 *
 * **file 内の所属は heading hierarchy が表す** (`my-wish-data.md` の hierarchy 節)。移動する
 * node を親の最後の子として subtree ごと運び、heading の深さを親の 1 段下へ揃える。
 *
 * `expected_hash` は移動する node の本文 hash (`component_body`、子 heading を含む)。
 * 運ぶ範囲そのものなので、ここが変わっていれば `conflict`。
 */
export type MoveHeadingInput = {
  /** 移動する heading node。file root node は動かせない (所属は親 file の `children`)。 */
  readonly component_id: ComponentId;
  readonly expected_hash: string;
  /** 新しい親。**同じ file の** file root node か heading node。 */
  readonly new_parent_component_id: ComponentId;
};

/**
 * task node の観測 (artifact 0.11.0)。`move_task` の `expected_hash` の取得口。
 *
 * **task の locator は `path#^<task_id>`** (Obsidian の block reference の形)。task は heading を
 * 持たないので、heading 形の locator では指せない。
 */
export type DocumentTaskView = {
  readonly component_id: ComponentId;
  readonly locator: string;
  /** checkbox の中身。未知の値もそのまま返す。 */
  readonly state: string;
  /** task 行と nest した子 task / 補足行を含む block の hash。 */
  readonly block_hash: string;
  /** block と一緒に運ばれる子 task。 */
  readonly child_task_ids: readonly string[];
  /** task が今置かれている wish node の locator。**これが task の所属。** */
  readonly owner_locator: string;
};

/**
 * task node の移動 (artifact 0.11.0)。checkbox 行を `^t-...` anchor と nest した子 task ごと、
 * 移動先 wish の section へ運ぶ。**file 内でも file 跨ぎでもよい。**
 */
export type MoveTaskInput = {
  readonly component_id: ComponentId;
  /** `read_task` の `block_hash`。運ぶ block そのものの hash。 */
  readonly expected_hash: string;
  /** 移動先の wish node (file root node か heading node)。 */
  readonly new_parent_component_id: ComponentId;
};

/**
 * task node の作成 (Lane I、wish `w-01M3N7RV5K`)。`task.create_planned` が採番した
 * `^t-...` anchor を、checkbox 行 (`- [ ] <title> ^<component_id>`) として `locator` の
 * section へ書く口。planner が plan 時に task の document node を mint/bind する経路。
 * ID は引数として受ける (発番点を 1 つに集約する規則 — `register_component_id` と同じ)。
 */
export type CreateTaskInput = {
  /** 書く task の component_id。`task.create_planned` が返した vault 形。 */
  readonly component_id: ComponentId;
  /** checkbox 行の表示 text。行末 `^<id>` はこちらが付ける — title に `^` を含めない。 */
  readonly title: string;
  /** 置き先の section (file root node か heading node)。通常は owner wish の node。 */
  readonly locator: DocumentLocator;
};

/** task の locator。`path#^<task_id>` だけを受ける。**heading 形や bare path から推測しない。** */
export function parseTaskLocator(
  value: string,
  componentId: ComponentId,
): Result<DocumentLocator> {
  const locator = parseDocumentLocator(value, "locator");
  if (!locator.ok) return locator;
  if (locator.value.heading !== `^${componentId}`) {
    return err(
      "invalid_locator",
      `task の locator は path#^${componentId} である必要がある: ${value}`,
      "locator",
    );
  }
  return locator;
}

/**
 * Document operation の境界。
 *
 * handler は write 直前に最新 Markdown を読み直す。target region が変わっていれば `conflict` に
 * し、**非対象 region の変更は保持する**。generic な body 置換と field patch を持たない。
 */
export interface DocumentPort {
  /**
   * 新規 Markdown file を 1 つ作る。**既存 path は上書きしない** (`conflict`)。
   * 同じ `component_id` の anchor を持つ file が既に在れば `noop` (再送)。
   */
  createFile(input: CreateFileInput): Result<DocumentOutcome>;
  registerComponentId(input: RegisterComponentIdInput): Result<DocumentOutcome>;
  renameTitle(input: RenameTitleInput): Result<DocumentOutcome>;
  replaceRegion(input: ReplaceRegionInput): Result<DocumentOutcome>;
  readRaw(componentId: ComponentId): Result<DocumentView>;
  /** locator が指す node を register 前に観測する。`expected_hash` の取得口。 */
  inspectLocator(locator: DocumentLocator): Result<DocumentNodeView>;
  /** file 内の node をすべて列挙する。observer の入口。 */
  listNodes(path: string): Result<DocumentFileNodes>;
  /** 親 node の `children` を読む。`attach_child` / `detach_child` の hash の取得口。 */
  readChildren(componentId: ComponentId): Result<DocumentChildrenView>;
  /** 親 node の `children` へ link を 1 件足す。既にあれば `noop`。 */
  attachChild(input: ChildLinkInput): Result<DocumentOutcome>;
  /** 親 node の `children` から link を外す。無ければ `noop`。path pattern 要素は触らない。 */
  detachChild(input: ChildLinkInput): Result<DocumentOutcome>;
  /** file 内の heading node を別の親の下へ subtree ごと移す。既にその親の子なら `noop`。 */
  moveHeading(input: MoveHeadingInput): Result<DocumentOutcome>;
  /** task node を観測する。`move_task` の hash の取得口。 */
  readTask(componentId: ComponentId): Result<DocumentTaskView>;
  /**
   * task node を別の wish の section へ運ぶ。既にその wish に居れば `noop`。
   * **file 跨ぎは移動先へ書いてから移動元から外す。**途中で落ちたら task は両方に残り、消えない。
   */
  moveTask(input: MoveTaskInput): Result<DocumentOutcome>;
  /**
   * task node を新規に置く。`- [ ] <title> ^<component_id>` の checkbox 行を `locator` の
   * section の自分の本文の末尾へ足す。同じ `component_id` の task 行が同じ owner に
   * 正しく在れば `noop` (再送)、別の形 / 別の owner に在れば `conflict`。
   * **既存行は書き直さない。**
   */
  createTask(input: CreateTaskInput): Result<DocumentOutcome>;
  /**
   * generated iteration 3 key を `path` の file へ surgical に upsert する (schema 6)。
   *
   * **`path` は repo 相対の `.md`。**member doc は component でないので id ではなく path で指す。
   * `kind` / `children` / `^<id>` など generated でない行は触らない。frontmatter の無い
   * file には書かない (`frontmatter_missing`)。
   * **optional:** 未実装の port を持つ consumer はこの口を提供しない。呼び出し側は
   * `undefined` を「この環境では書けない」として扱い、operation の成否にはしない
   * (property は DB membership から `iteration.repair` で再投影できる派生値)。
   */
  stampIterationProperties?(
    input: StampIterationPropertiesInput,
  ): Result<{ readonly changed: boolean }>;
}

/** VaultFileObserver からの観測 1 件。`interfaces.md` の `document_projection.observe` の引数。 */
export type DocumentProjectionObservation = {
  readonly component_id: ComponentId;
  readonly title: string;
  readonly locator: string;
  readonly observed_hash: string;
  /**
   * file root node の `children` の要素の値 (`locateChildren` の `entries[].value`、artifact 0.13.0)。
   *
   * **mind の観測でだけ projection へ写す** (mind -> wish の id 要素)。未設定なら所属の projection に
   * 触らない (`children` を読めなかった観測で、既存の所属を消さない)。空 array は「所属 0 件」。
   */
  readonly children?: readonly string[];
};

const OBSERVATION_FIELDS = [
  "component_id",
  "title",
  "locator",
  "observed_hash",
  "children",
] as const;

export function parseDocumentProjectionObservation(
  value: unknown,
  path?: string,
): Result<DocumentProjectionObservation> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "observation は object である必要がある", path);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(OBSERVATION_FIELDS as readonly string[]).includes(key)) {
      return err(
        "unexpected_field",
        `observation に未知の field がある: ${key}`,
        joinPath(path, key),
      );
    }
  }
  const componentId = parseComponentId(raw["component_id"], joinPath(path, "component_id"));
  if (!componentId.ok) return componentId;
  for (const key of ["title", "locator", "observed_hash"] as const) {
    if (typeof raw[key] !== "string") {
      return err("invalid_field_type", `${key} は string である必要がある`, joinPath(path, key));
    }
  }
  // locator は「読めた位置」であり identity ではないが、repo 外を指す値は projection にも入れない。
  const locator = parseDocumentLocator(raw["locator"], joinPath(path, "locator"));
  if (!locator.ok) return locator;
  const children = raw["children"];
  if (
    children !== undefined &&
    (!Array.isArray(children) || children.some((value) => typeof value !== "string"))
  ) {
    return err(
      "invalid_field_type",
      "children は string の array である必要がある",
      joinPath(path, "children"),
    );
  }
  return ok({
    component_id: componentId.value,
    title: raw["title"] as string,
    locator: raw["locator"] as string,
    observed_hash: raw["observed_hash"] as string,
    ...(children === undefined ? {} : { children: [...(children as string[])] }),
  });
}

/**
 * projection 更新の結果。
 *
 * `applied` / `noop` / `not_found` だけを返す。**未登録 stable ID は `not_found` であり、
 * 推測 merge しない。** workflow command ではないので `rejected` / `conflict` を持たない
 * (この port は revision を保護しない)。
 */
export type DocumentProjectionResult = {
  readonly component_id: ComponentId;
  readonly disposition: "applied" | "noop" | "not_found";
  readonly document_projection_revision?: Revision;
  readonly reason?: string;
};

/**
 * local read model の document projection だけを更新する境界。
 * `state_revision`、activity、DomainEvent、outbox、operation receipt を変更しない。
 * DB projection から Markdown title へ逆書きしない。
 */
export interface DocumentProjectionPort {
  observe(observation: DocumentProjectionObservation): Result<DocumentProjectionResult>;
}
