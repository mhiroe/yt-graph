// Document operation の意味を決める pure 部分。
//
// **file を読まない。** 読み終わった raw text と intent を受け取り、次の raw text と disposition を
// 返すだけ。副作用が無いので、conflict 判定と非対象 region の保全を fixture で検証できる。
// 再読込と atomic replacement は `adapters/fs_document.ts` の責務。

import { err, ok, type Result } from "./result.ts";
import { type ComponentId, parseComponentId } from "./ids.ts";
import { isVaultComponentId } from "./vault_ids.ts";
import {
  type ChildLinkInput,
  type CreateFileInput,
  type CreateTaskInput,
  type DocumentChildrenView,
  type DocumentFileNodes,
  type DocumentLocator,
  type DocumentNodeView,
  type DocumentOutcome,
  type DocumentTaskView,
  type DocumentView,
  formatDocumentLocator,
  type MoveHeadingInput,
  type MoveTaskInput,
  type RegisterComponentIdInput,
  type RenameTitleInput,
  type ReplaceRegionInput,
} from "./document.ts";
import {
  detectNewline,
  fenceOpenAtEnd,
  hashSpan,
  headingSectionCodec,
  type ListedSection,
  normalizeRegionContent,
  type RegionCodec,
  type Section,
  type SectionListing,
  spliceSpan,
  splitLines,
} from "./region.ts";
import {
  isListLine,
  locateTaskBlock,
  relocatedTaskText,
  type TaskBlock,
  taskBlockShape,
} from "./task_block.ts";
import {
  type ChildEntry,
  childrenHash,
  type ChildrenProperty,
  formatChildIdItem,
  formatChildItem,
  formatEmptyChildren,
  frontmatterKind,
  locateChildren,
  parseChildId,
  parseChildLink,
  sameLinkTarget,
} from "./children.ts";
import { applyIterationProperties } from "./iterations.ts";

/**
 * node の表示 title。
 *
 * **file root node は file basename から導出する。** `my-wish-data.md` の node model が
 * 「file root node の表示 title は file basename から導出し、frontmatter `title` は使わない」と
 * 定めている (例: `健康的な食事.md` の file root node は `健康的な食事`)。codec は path を
 * 知らないので、導出はここで行う。
 *
 * **export する (裁定 root PM 2026-09-15、wishboard gap 2)。** 以前は private で、consumer 側に
 * 同じ導出の写しが存在していた。**規則が 2 か所にある**状態を消す。
 */
export function nodeTitle(section: Section, locator: DocumentLocator): string {
  if (section.node === "heading") return section.title;
  const base = locator.path.split(/[\\/]+/).at(-1) ?? locator.path;
  return base.replace(/\.md$/i, "");
}

/**
 * `document.create_file` が書く新規 file の本文を組む (pure、fs を触らない)。
 *
 * 形は実 vault の file と同じ: frontmatter (`kind` / `children: []`) → file root node の
 * identity block (`> [!meta]- <id>` + `^<id>`) → 本文。identity block の位置は自分で決めず
 * codec の `identityInsertion` に任せる — **codec だけが「どこが identity か」を決める**。
 *
 * vault 形でない id (`c-...` 等) は `invalid_id` で拒否する。`register_component_id` と同じ
 * 規則で、内部 id を Markdown の anchor へ書かせない。
 */
export function buildDocumentFile(
  input: CreateFileInput,
  codec: RegionCodec = headingSectionCodec,
): Result<string> {
  if (!isVaultComponentId(input.component_id)) {
    return err(
      "invalid_id",
      `component_id が vault 形 (<m|w|t>-<Crockford base32 10 桁>) でない: ${input.component_id}`,
      "component_id",
    );
  }
  // 本文の前に空行を 1 つ挟み、identity block と本文を分ける (実 vault の形と同じ)。
  let base = `---\nkind: ${input.component_kind}\nchildren: []\n---\n` +
    (input.content.length === 0 ? "" : `\n${input.content}`);
  // generated iteration key (schema 6)。caller が DB membership から導出した値だけを書く。
  // 値が無ければ key 自体を出さない (key が無い = pre-iteration scope)。
  if (input.iteration_properties !== undefined) {
    const stamped = applyIterationProperties(base, input.iteration_properties);
    if (!stamped.ok) return stamped;
    base = stamped.value.raw;
  }
  const section = codec.locateSection(base);
  if (!section.ok) return section;
  const insertion = codec.identityInsertion(base, section.value, input.component_id);
  if (!insertion.ok) return insertion;
  return ok(
    spliceSpan(
      base,
      { start: insertion.value.offset, end: insertion.value.offset },
      insertion.value.text,
    ),
  );
}

/**
 * 1 operation の結果。
 * `next_raw` があるときだけ file を書く。`noop` / `conflict` / `rejected` では書かない。
 */
export type DocumentEdit = {
  readonly outcome: DocumentOutcome;
  readonly next_raw?: string;
};

function conflict(
  locator: string,
  actualHash: string,
  reason: string,
  componentId?: ComponentId,
): DocumentEdit {
  return {
    outcome: {
      disposition: "conflict",
      locator,
      observed_hash: actualHash,
      reason,
      ...(componentId === undefined ? {} : { component_id: componentId }),
    },
  };
}

/** `document.read_raw`。section だけを返す。file 全体を raw として公開しない。 */
export function readDocumentView(
  raw: string,
  componentId: ComponentId,
  locator: DocumentLocator,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentView> {
  const section = codec.locateSection(raw, locator.heading);
  if (!section.ok) return section;
  const body = raw.slice(section.value.body.start, section.value.body.end);
  // raw は heading 行から本文末までを返す。file root node は heading 行を持たないので
  // identity block の先頭から始める。frontmatter は返さない (node の内容ではない)。
  const rawStart = section.value.heading?.start ?? section.value.identity.start;
  return ok({
    component_id: componentId,
    locator: formatDocumentLocator(locator),
    title: nodeTitle(section.value, locator),
    raw: raw.slice(rawStart, section.value.body.end),
    body,
    observed_hash: hashSpan(raw, section.value.body),
  });
}

/**
 * locator が指す node 1 件を observe する (Slice F1 の O1-2)。
 *
 * **register 前に呼べる。**`readDocumentView` と違い component_id を要求しない。
 * `locateSection` が曖昧な heading を拒否するので、解決できた時点で `addressable` は真。
 */
export function readNodeView(
  raw: string,
  locator: DocumentLocator,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentNodeView> {
  const section = codec.locateSection(raw, locator.heading);
  if (!section.ok) return section;
  const anchor = codec.findIdAnchor(raw, section.value);
  if (!anchor.ok) return anchor;
  const componentId = anchor.value === undefined
    ? undefined
    : parseComponentId(anchor.value.id, "component_id");
  if (componentId !== undefined && !componentId.ok) return componentId;
  return ok({
    locator: formatDocumentLocator(locator),
    node: section.value.node,
    level: section.value.level,
    title: nodeTitle(section.value, locator),
    addressable: true,
    body_hash: hashSpan(raw, section.value.body),
    ...(componentId === undefined ? {} : { component_id: componentId.value }),
  });
}

/**
 * file 内の node をすべて観測する (wishboard gap 1)。
 *
 * **heading の行形を呼び出し側が判定しない。**列挙は codec が持ち、ここは locator と title を
 * 付けて DocumentPort の形へ写すだけ。
 */
export function readNodeList(
  raw: string,
  path: string,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentFileNodes> {
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  const nodes: DocumentNodeView[] = [];
  for (const section of listing.value.sections) {
    const locator: DocumentLocator = section.node === "file_root"
      ? { path }
      : { path, heading: section.title };
    const componentId = section.anchor === undefined
      ? undefined
      : parseComponentId(section.anchor.id, "component_id");
    if (componentId !== undefined && !componentId.ok) return componentId;
    nodes.push({
      locator: formatDocumentLocator(locator),
      node: section.node,
      level: section.level,
      title: nodeTitle(section, locator),
      addressable: section.addressable,
      body_hash: hashSpan(raw, section.body),
      ...(componentId === undefined ? {} : { component_id: componentId.value }),
    });
  }
  return ok({
    path,
    nodes,
    unclaimed_anchors: listing.value.unclaimed_anchors.map((entry) => entry.id),
  });
}

/**
 * `document.register_component_id`。section 直下へ stable ID anchor を置く。
 *
 * 既に同じ ID があれば `noop`、別の ID があれば `conflict`。**推測 merge しない。**
 *
 * **裁定 (Slice E、P3-a): property callout が無ければ callout ごと作る。** 置き場は未定義では
 * なく未作成で、register は identity を新規に付ける operation だから。以前はここを `rejected` に
 * していたが、実 heading 564 件のうち 554 件 (98.2%) が callout を持たないので、register が
 * 実データのほぼ全部で失敗していた。
 */
export function applyRegisterComponentId(
  raw: string,
  input: RegisterComponentIdInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const locator = formatDocumentLocator(input.locator);
  // **実 vault の node id は vault 形だけを書く。** `c-<operation_id>` のような内部 id は
  // SQLite / projection では使えるが、Markdown の `^` anchor へは書かない。
  if (!isVaultComponentId(input.component_id)) {
    return err(
      "invalid_id",
      `component_id が vault 形 (<m|w|t>-<Crockford base32 10 桁>) でない: ${input.component_id}`,
      "component_id",
    );
  }
  const section = codec.locateSection(raw, input.locator.heading);
  if (!section.ok) return section;
  const actualHash = hashSpan(raw, section.value.body);
  if (actualHash !== input.expected_hash) {
    return ok(conflict(
      locator,
      actualHash,
      `expected_hash ${input.expected_hash} が現在の ${actualHash} と一致しない`,
      input.component_id,
    ));
  }

  const anchor = codec.findIdAnchor(raw, section.value);
  if (!anchor.ok) return anchor;
  if (anchor.value !== undefined) {
    if (anchor.value.id === input.component_id) {
      return ok({
        outcome: {
          disposition: "noop",
          component_id: input.component_id,
          locator,
          observed_hash: actualHash,
        },
      });
    }
    return ok(conflict(
      locator,
      actualHash,
      `section に別の stable ID ${anchor.value.id} が既にある`,
      input.component_id,
    ));
  }

  const insertion = codec.identityInsertion(raw, section.value, input.component_id);
  if (!insertion.ok) return insertion;
  // 足す行の終端は codec が document の改行へ揃えている。CRLF の file へ LF 行を差し込まない。
  const next = spliceSpan(
    raw,
    { start: insertion.value.offset, end: insertion.value.offset },
    insertion.value.text,
  );
  const nextSection = codec.locateSection(next, input.locator.heading);
  if (!nextSection.ok) return nextSection;
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      locator,
      observed_hash: hashSpan(next, nextSection.value.body),
    },
    next_raw: next,
  });
}

/**
 * `document.rename_title`。heading 行の text だけを差し替える。
 *
 * **`expected_hash` が守るのは本文であって title ではない。** observer が出す `observed_hash` は
 * 本文だけを入力にしているので (wishboard `vault-observation.ts`)、title の同時変更はこの hash に
 * 現れない。title 側の lost update はこの contract では検出できない。未確定なので、title 用の
 * 2 つ目の hash を推測で足さずに、検出できない範囲を明示して残す。
 */
export function applyRenameTitle(
  raw: string,
  locator: DocumentLocator,
  input: RenameTitleInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const locatorText = formatDocumentLocator(locator);
  const title = input.title.trim();
  if (title.length === 0 || title.includes("\n")) {
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        code: "invalid_field_type",
        reason: "title は空でない 1 行である必要がある",
      },
    });
  }
  const section = codec.locateSection(raw, locator.heading);
  if (!section.ok) return section;
  if (section.value.node === "file_root") {
    // **file root node の rename は file name の更新である** (`my-wish-data.md` の node model)。
    // text の splice では実現できないので、本文を書き換えて「rename した」と返さない。
    // file move を持つ operation は無いので、ここで止めて呼び出し側へ返す。
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        code: "title_rename_requires_file_move",
        reason: "file root node の title は file basename から導出されるので、" +
          "rename は file name を更新する操作になる。document text の書き換えでは行えない",
      },
    });
  }
  const actualHash = hashSpan(raw, section.value.body);
  if (actualHash !== input.expected_hash) {
    return ok(conflict(
      locatorText,
      actualHash,
      `expected_hash ${input.expected_hash} が現在の ${actualHash} と一致しない`,
      input.component_id,
    ));
  }
  if (section.value.title === title) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: actualHash,
      },
    });
  }
  // heading 行だけを差し替える。level marker と本文は 1 byte も動かさない。
  // file_root は上で `rejected` にしているので、ここでは heading span が必ずある。
  const headingSpan = section.value.heading;
  if (headingSpan === undefined) {
    return err("document_not_found", "heading 行を解決できない", "locator");
  }
  const next = spliceSpan(
    raw,
    headingSpan,
    `${"#".repeat(section.value.level)} ${title}`,
  );
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      // locator は heading を含むので、rename でこの component の locator も変わる。
      locator: formatDocumentLocator({ path: locator.path, heading: title }),
      observed_hash: actualHash,
    },
    next_raw: next,
  });
}

/**
 * `document.replace_region`。target region だけを差し替える。
 *
 * 非対象 region は splice の外にあるので触れない。named region は Markdown region ではないので
 * `document_region_not_in_markdown` を `rejected` として返し、**本文全体へ倒さない**。
 *
 * **裁定 (Slice E、裁定 1): 対象 span が他 node の identity を含む write は `rejected`。**
 * `component_body` は「次の同 level 以浅 heading の直前まで」なので子 heading node を含む。
 * 親の body を全置換すると子 component の identity が消える。実測では
 * `docs/wish_dotfiles.md#壁打ちと実行` の body が子 4 件の identity を含んでいた。
 *
 * **read の範囲は変えない。** 狭めると wishboard が Plan 本文を読む範囲まで動く。読み手の
 * 仕様を書き手の都合で動かさない (root PM 裁定)。「自分の body だけ書きたい」呼び出しが
 * 現れたら別 region 名として足す。**今は呼び出し側が居ないので作らない。**
 */
export function applyReplaceRegion(
  raw: string,
  locator: DocumentLocator,
  input: ReplaceRegionInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const locatorText = formatDocumentLocator(locator);
  const section = codec.locateSection(raw, locator.heading);
  if (!section.ok) return section;
  const region = codec.locateRegion(raw, section.value, input.target_region);
  if (!region.ok) {
    if (region.error.code !== "document_region_not_in_markdown") return region;
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        code: region.error.code,
        reason: region.error.message,
      },
    });
  }
  const foreign = codec.findForeignIdentity(raw, section.value, region.value);
  if (foreign !== undefined) {
    const what = foreign.kind === "id_anchor" ? "block id anchor" : "property callout";
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: hashSpan(raw, region.value),
        code: "document_region_contains_foreign_identity",
        reason: `対象 region が他 node の identity (${what}` +
          `${foreign.id === undefined ? "" : ` ${foreign.id}`}) を含む。` +
          "全置換すると子 component の identity が消えるので書き込まない",
      },
    });
  }
  const actualHash = hashSpan(raw, region.value);
  if (actualHash !== input.expected_region_hash) {
    return ok(conflict(
      locatorText,
      actualHash,
      `expected_region_hash ${input.expected_region_hash} が現在の ${actualHash} と一致しない`,
      input.component_id,
    ));
  }
  const replacement = normalizeRegionContent(input.content, detectNewline(raw));
  if (replacement === raw.slice(region.value.start, region.value.end)) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: actualHash,
      },
    });
  }
  const next = spliceSpan(raw, region.value, replacement);
  const nextSection = codec.locateSection(next, locator.heading);
  if (!nextSection.ok) return nextSection;
  const nextRegion = codec.locateRegion(next, nextSection.value, input.target_region);
  if (!nextRegion.ok) return nextRegion;
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      locator: locatorText,
      observed_hash: hashSpan(next, nextRegion.value),
    },
    next_raw: next,
  });
}

// ===========================================================================
// 所属の書き (artifact 0.10.0)
// ===========================================================================

/**
 * `children` を持てるのは file root node だけ。heading node の所属は heading hierarchy が表す
 * (`my-wish-data.md` の hierarchy 節)。実 vault の `[!meta]` callout に `children` は 0 件。
 */
function childrenRequiresFileRoot(
  locator: DocumentLocator,
  componentId: ComponentId,
): DocumentEdit | undefined {
  if (locator.heading === undefined) return undefined;
  return {
    outcome: {
      disposition: "rejected",
      component_id: componentId,
      locator: formatDocumentLocator(locator),
      code: "children_requires_file_root",
      reason: "children は file root node の frontmatter property。heading node の所属は " +
        "heading hierarchy が表すので、この operation では書かない",
    },
  };
}

/** codec が読めない形を `rejected` の outcome へ写す。**推測で読まない。** */
function childrenUnreadable(
  locator: DocumentLocator,
  componentId: ComponentId,
  code: "children_shape_unsupported" | "frontmatter_missing",
  reason: string,
): DocumentEdit {
  return {
    outcome: {
      disposition: "rejected",
      component_id: componentId,
      locator: formatDocumentLocator(locator),
      code,
      reason,
    },
  };
}

/** `document.read_children`。file root node の `children` を読む。 */
export function readChildrenView(
  raw: string,
  componentId: ComponentId,
  locator: DocumentLocator,
): Result<DocumentChildrenView> {
  if (locator.heading !== undefined) {
    return err(
      "children_requires_file_root",
      "children は file root node の frontmatter property。heading node は持たない",
      "locator",
    );
  }
  const property = locateChildren(raw);
  if (!property.ok) return property;
  return ok({
    component_id: componentId,
    locator: formatDocumentLocator(locator),
    present: property.value.form !== "absent" && property.value.form !== "no_frontmatter",
    writable: property.value.form !== "no_frontmatter",
    children: property.value.entries,
    children_hash: childrenHash(raw, property.value),
  });
}

/**
 * write の前後で node が 1 つも動いていないことを確かめる。
 *
 * **frontmatter の write は node の外側だが、file root node の identity block は frontmatter の
 * 直後から始まる。** 閉じ `---` の直前へ行を足す write が node の切り出しを動かしていないことを、
 * 書く前に codec 自身で検算する。動いていたら書かない。
 */
function nodesUnchanged(raw: string, next: string, codec: RegionCodec): Result<undefined> {
  const before = codec.listSections(raw);
  if (!before.ok) return before;
  const after = codec.listSections(next);
  if (!after.ok) return after;
  const shape = (listing: typeof before.value): string =>
    JSON.stringify({
      nodes: listing.sections.map((section) => [
        section.node,
        section.level,
        section.title,
        section.anchor?.id ?? null,
        section.body.end - section.body.start,
      ]),
      unclaimed: listing.unclaimed_anchors.map((anchor) => anchor.id),
    });
  const bodies = (text: string, listing: typeof before.value): string[] =>
    listing.sections.map((section) => hashSpan(text, section.body));
  if (
    shape(before.value) !== shape(after.value) ||
    JSON.stringify(bodies(raw, before.value)) !== JSON.stringify(bodies(next, after.value))
  ) {
    return err(
      "children_shape_unsupported",
      "children の write が node の切り出しを動かすので書かない",
      "children",
    );
  }
  return ok(undefined);
}

/**
 * 書く子の指し方。**link と id を混ぜて照合しない。**id 要素は `[[...]]` を持たないので
 * link の照合 (`sameLinkTarget`) には掛からず、link 要素は id の照合 (値の完全一致) に掛からない。
 */
type ChildTarget =
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "id"; readonly id: string };

function parseChildTarget(input: ChildLinkInput, forAttach: boolean): Result<ChildTarget> {
  const hasId = input.child_id !== undefined;
  if (hasId && input.child_link !== undefined) {
    return err("invalid_child_id", "child_link と child_id はどちらか 1 つだけを渡す", "child_id");
  }
  if (hasId) {
    const id = parseChildId(input.child_id, forAttach, "child_id");
    return id.ok ? ok({ kind: "id", id: id.value }) : id;
  }
  const target = parseChildLink(input.child_link, "child_link");
  return target.ok ? ok({ kind: "link", target: target.value }) : target;
}

function matchesChild(entry: ChildEntry, target: ChildTarget): boolean {
  if (target.kind === "id") return entry.link_target === undefined && entry.value === target.id;
  return sameLinkTarget(entry.link_target ?? "", target.target);
}

function formatChild(indent: string, target: ChildTarget, newline: string): string {
  return target.kind === "id"
    ? formatChildIdItem(indent, target.id, newline)
    : formatChildItem(indent, target.target, newline);
}

/** 共通の前段。file root の確認、形の解決、hash の照合。 */
function prepareChildrenEdit(
  raw: string,
  locator: DocumentLocator,
  input: ChildLinkInput,
  forAttach: boolean,
): Result<{ property: ChildrenProperty; hash: string; target: ChildTarget } | DocumentEdit> {
  const target = parseChildTarget(input, forAttach);
  if (!target.ok) return target;
  const notRoot = childrenRequiresFileRoot(locator, input.component_id);
  if (notRoot !== undefined) return ok(notRoot);
  const property = locateChildren(raw);
  if (!property.ok) {
    return ok(childrenUnreadable(
      locator,
      input.component_id,
      "children_shape_unsupported",
      property.error.message,
    ));
  }
  const hash = childrenHash(raw, property.value);
  if (hash !== input.expected_hash) {
    return ok(conflict(
      formatDocumentLocator(locator),
      hash,
      `expected_hash ${input.expected_hash} が現在の children hash ${hash} と一致しない`,
      input.component_id,
    ));
  }
  return ok({ property: property.value, hash, target: target.value });
}

function isEdit(value: unknown): value is DocumentEdit {
  return typeof value === "object" && value !== null && "outcome" in value;
}

function finishChildrenEdit(
  raw: string,
  next: string,
  locator: DocumentLocator,
  componentId: ComponentId,
  codec: RegionCodec,
): Result<DocumentEdit> {
  const guarded = nodesUnchanged(raw, next, codec);
  if (!guarded.ok) return guarded;
  const property = locateChildren(next);
  if (!property.ok) return property;
  return ok({
    outcome: {
      disposition: "applied",
      component_id: componentId,
      locator: formatDocumentLocator(locator),
      observed_hash: childrenHash(next, property.value),
    },
    next_raw: next,
  });
}

/**
 * `document.attach_child`。親 file root node の `children` へ link を 1 件足す。
 *
 * - 同じ node を指す要素が既にあれば `noop` (`.md` の有無は同一視する)。
 * - `child_id` (artifact 0.13.0) は `kind: mind` の file だけに書く。**指す wish が在るかは
 *   検めない** (mind は wish を検めない)。解決できない id は projection が broken として持つ。
 * - 要素がある list へは**最後の要素行の後ろへ 1 行足すだけ**。既存行を書き直さない。
 * - 空の list (`[]` / `null`) と key の無い frontmatter では、実測の block 形で作る。
 * - frontmatter が無い file は `rejected` (`frontmatter_missing`)。frontmatter ごと作る根拠は
 *   基本形の記述しか無く、作ると file root node の identity block の開始位置が動く。
 */
export function applyAttachChild(
  raw: string,
  locator: DocumentLocator,
  input: ChildLinkInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const prepared = prepareChildrenEdit(raw, locator, input, true);
  if (!prepared.ok) return prepared;
  if (isEdit(prepared.value)) return ok(prepared.value);
  const { property, hash, target } = prepared.value;
  const locatorText = formatDocumentLocator(locator);
  if (target.kind === "id" && frontmatterKind(raw) !== "mind") {
    // **id 要素を持つのは mind だけ** (`my-wish-data.md` の hierarchy 節)。wish の所属は node link。
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        code: "children_id_requires_mind",
        reason: "id 要素を children に書けるのは frontmatter が `kind: mind` の file だけ",
      },
    });
  }
  if (property.form === "no_frontmatter") {
    return ok(childrenUnreadable(
      locator,
      input.component_id,
      "frontmatter_missing",
      "frontmatter が無い file には children を書かない。frontmatter ごと作ると file root node の " +
        "identity block の開始位置が動く",
    ));
  }
  if (property.entries.some((entry) => matchesChild(entry, target))) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: hash,
      },
    });
  }
  const newline = detectNewline(raw);
  const item = formatChild(property.item_indent, target, newline);
  let next: string;
  if (property.form === "block") {
    const last = property.item_spans.at(-1);
    if (last === undefined) return err("children_shape_unsupported", "要素行を解決できない");
    next = spliceSpan(raw, { start: last.end, end: last.end }, item);
  } else {
    // absent は閉じ `---` 行頭の空 span なので、同じ splice で key ごと足せる。
    next = spliceSpan(raw, property.span, `children:${newline}${item}`);
  }
  return finishChildrenEdit(raw, next, locator, input.component_id, codec);
}

/**
 * `document.detach_child`。親 file root node の `children` から link を外す。
 *
 * - 同じ node を指す要素が無ければ `noop`。**path pattern 要素は link ではないので触らない。**
 * - `child_id` で外すときは要素の値の完全一致 (artifact 0.13.0)。**切る場所はここ 1 か所**で、
 *   write は mind の file 1 つだけ (`my-wish-data.md` の hierarchy 節)。
 * - 同じ node を指す要素が複数あれば**全部外す**。どれか 1 つを選ぶ (先着順) と、残った方で
 *   所属が続いて「外した」と言えなくなる。
 * - 最後の要素を外したら `children: []` (`my-wish-data.md` の frontmatter 基本形) にする。
 */
export function applyDetachChild(
  raw: string,
  locator: DocumentLocator,
  input: ChildLinkInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const prepared = prepareChildrenEdit(raw, locator, input, false);
  if (!prepared.ok) return prepared;
  if (isEdit(prepared.value)) return ok(prepared.value);
  const { property, hash, target } = prepared.value;
  const matched = property.entries.flatMap((entry, index) =>
    matchesChild(entry, target) ? [index] : []
  );
  if (matched.length === 0) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: formatDocumentLocator(locator),
        observed_hash: hash,
      },
    });
  }
  let next: string;
  if (matched.length === property.entries.length) {
    next = spliceSpan(raw, property.span, formatEmptyChildren(detectNewline(raw)));
  } else {
    next = raw;
    // 後ろから外す。前から外すと後続 span の offset がずれる。
    for (const index of [...matched].reverse()) {
      const span = property.item_spans[index];
      if (span === undefined) return err("children_shape_unsupported", "要素行を解決できない");
      next = spliceSpan(next, span, "");
    }
  }
  return finishChildrenEdit(raw, next, locator, input.component_id, codec);
}

// ===========================================================================
// heading hierarchy の移動 (artifact 0.10.0)
// ===========================================================================

/** file root 直下の heading は `##` (`my-wish-data.md`: `#` は file title 用に予約)。 */
const FILE_ROOT_CHILD_LEVEL = 2;
const MAX_HEADING_LEVEL = 6;

/** section の親。**位置で決める。**直前にある、自分より浅い heading。無ければ file root。 */
function parentOf(
  listing: SectionListing,
  target: ListedSection,
): ListedSection | undefined {
  const index = listing.sections.indexOf(target);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = listing.sections[i];
    if (candidate === undefined) continue;
    if (candidate.node === "file_root" || candidate.level < target.level) return candidate;
  }
  return undefined;
}

function sameNode(left: Section, right: Section): boolean {
  return left.node === right.node && left.title === right.title;
}

/**
 * 移動の前後で比べる node 1 件の中身。**identity block と、子 heading を除いた自分の本文。**
 *
 * `component_body` は子 heading を含むので、旧親と新親の body は移動で必ず変わる。比べるのは
 * 「自分の本文」だけ。末尾の空白は移動で前後の空行が付け替わるので比較から外す。
 */
function nodeContents(raw: string, listing: SectionListing, levelOf: (s: ListedSection) => number) {
  return listing.sections.map((section, index) => {
    const next = listing.sections[index + 1];
    const nextHeading = next?.heading?.start;
    const ownEnd = nextHeading !== undefined && nextHeading < section.body.end
      ? nextHeading
      : section.body.end;
    return JSON.stringify([
      section.node,
      section.title,
      levelOf(section),
      section.anchor?.id ?? null,
      raw.slice(section.identity.start, section.identity.end).trimEnd(),
      raw.slice(section.body.start, Math.max(section.body.start, ownEnd)).trimEnd(),
    ]);
  }).sort();
}

/**
 * `document.move_heading`。heading node を同じ file の別の親の下へ subtree ごと移す。
 *
 * **identity 保護 (裁定 Slice E) とは衝突しない。**あちらは「子の identity を含む span を
 * 書き換える」write を止める規則で、ここは identity を消さずに**運ぶ**。運んだ後に次を
 * codec で検算し、1 つでも崩れていれば書かない。
 *
 * - 全 node の identity block と「自分の本文」が移動前と同じ (順序は問わない)。
 * - 深さが変わるのは移動した subtree だけで、差分はすべて同じ。
 * - 移動した node の親が、要求した親になっている。
 * - codec が読めない anchor (setext heading の下など) が増減していない。
 *
 * **file を跨ぐ移動はしない。**`my-wish-data.md` が「親子操作だけで file split / merge を
 * 自動実行しない」と定めている。
 */
export function applyMoveHeading(
  raw: string,
  locator: DocumentLocator,
  parentLocator: DocumentLocator,
  input: MoveHeadingInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const locatorText = formatDocumentLocator(locator);
  const reject = (
    code:
      | "heading_move_requires_heading_node"
      | "heading_move_crosses_file"
      | "heading_move_into_own_subtree"
      | "heading_move_exceeds_depth"
      | "heading_move_swallows_nodes"
      | "document_structure_unreadable",
    reason: string,
  ): Result<DocumentEdit> =>
    ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        code,
        reason,
      },
    });

  if (locator.heading === undefined) {
    return reject(
      "heading_move_requires_heading_node",
      "file root node の所属は親 file の children property が表す。heading の移動では動かさない",
    );
  }
  if (parentLocator.path !== locator.path) {
    return reject(
      "heading_move_crosses_file",
      "親子操作だけで file split / merge をしない (my-wish-data.md)。file を跨ぐ移動は行わない",
    );
  }
  const section = codec.locateSection(raw, locator.heading);
  if (!section.ok) return section;
  const parent = codec.locateSection(raw, parentLocator.heading);
  if (!parent.ok) return parent;
  const actualHash = hashSpan(raw, section.value.body);
  if (actualHash !== input.expected_hash) {
    return ok(conflict(
      locatorText,
      actualHash,
      `expected_hash ${input.expected_hash} が現在の ${actualHash} と一致しない`,
      input.component_id,
    ));
  }
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  if (listing.value.unclaimed_anchors.length > 0) {
    return reject(
      "document_structure_unreadable",
      `codec が node に結び付けられない anchor がある (${
        listing.value.unclaimed_anchors.map((anchor) => anchor.id).join(", ")
      })。構造を読み切れない file では heading を運ばない`,
    );
  }
  const heading = section.value.heading;
  if (heading === undefined) return err("document_not_found", "heading 行を解決できない");
  const subtree = { start: heading.start, end: section.value.section_end };
  const parentStart = parent.value.heading?.start;
  if (parentStart !== undefined && parentStart >= subtree.start && parentStart < subtree.end) {
    return reject(
      "heading_move_into_own_subtree",
      "自分自身か自分の子孫の下へは移せない",
    );
  }

  const moved = listing.value.sections.find((entry) => entry.heading?.start === heading.start);
  if (moved === undefined) return err("document_not_found", "移動する node を一覧から引けない");
  const current = parentOf(listing.value, moved);
  if (current !== undefined && sameNode(current, parent.value)) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: actualHash,
      },
    });
  }

  const targetLevel = parent.value.node === "file_root"
    ? FILE_ROOT_CHILD_LEVEL
    : parent.value.level + 1;
  const delta = targetLevel - moved.level;
  const members = listing.value.sections.filter((entry) =>
    entry.heading !== undefined && entry.heading.start >= subtree.start &&
    entry.heading.start < subtree.end
  );
  const deepest = Math.max(...members.map((entry) => entry.level)) + delta;
  if (deepest > MAX_HEADING_LEVEL) {
    return reject(
      "heading_move_exceeds_depth",
      `移すと subtree の最深 heading が ${deepest} 段になる (Markdown の上限は 6)`,
    );
  }

  // subtree を切り出し、heading marker だけを付け替える。**heading 行の marker 以外は触らない。**
  const newline = detectNewline(raw);
  let block = raw.slice(subtree.start, subtree.end);
  for (const member of [...members].reverse()) {
    const offset = (member.heading?.start ?? 0) - subtree.start;
    block = block.slice(0, offset) + "#".repeat(member.level + delta) +
      block.slice(offset + member.level);
  }
  if (!block.endsWith("\n")) block += newline;
  let head = raw.slice(0, subtree.start);
  const tail = raw.slice(subtree.end);
  // file 末尾から運び出した時は、運び出した後に残る末尾の空行を 1 つの改行へ畳む。
  // 空行はどの node の本文にも入らない (body は末尾の空行を含まない) ので、本文は動かない。
  if (tail.length === 0) head = head.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, "$1");
  const without = head + tail;

  // 親の最後の子として置く。file root の子は file 末尾、heading の子はその section の終端。
  let insertAt = without.length;
  if (parent.value.node === "heading") {
    const parentAfter = codec.locateSection(without, parentLocator.heading);
    if (!parentAfter.ok) return parentAfter;
    insertAt = parentAfter.value.section_end;
  }
  let prefix = without.slice(0, insertAt);
  // heading の前は空行にする。heading 行の直前は本文ではない (body は末尾の空行を含まない) ので、
  // 足す改行はどの node の本文も動かさない。
  if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += newline;
  if (prefix.length > 0 && !prefix.endsWith(`${newline}${newline}`)) prefix += newline;
  // **運んだ block が開いたままの fence で終わると、CommonMark どおり置いた位置より後ろは
  // その fence の中身になる。**後続に section が残る位置へ置くと、移動対象でない node が
  // 消えるので書かない。文書末 (後ろに section が無い) へ置く分には影響しない。
  if (insertAt < without.length && fenceOpenAtEnd(splitLines(block)) !== undefined) {
    return reject(
      "heading_move_swallows_nodes",
      "運ぶ block が閉じていない fence で終わる。置くと後続の section が fence の中身になって node から消えるので書かない",
    );
  }
  // 後ろに続きがあるなら、運んだ block の後ろも空行で区切る。
  if (insertAt < without.length && !block.endsWith(`${newline}${newline}`)) block += newline;
  const next = prefix + block + without.slice(insertAt);

  const after = codec.listSections(next);
  if (!after.ok) return after;
  const memberStarts = new Set(members.map((entry) => entry.heading?.start));
  const expected = nodeContents(
    raw,
    listing.value,
    (entry) => memberStarts.has(entry.heading?.start) ? entry.level + delta : entry.level,
  );
  const actual = nodeContents(next, after.value, (entry) => entry.level);
  const movedAfter = after.value.sections.find((entry) => sameNode(entry, moved));
  const parentAfterMove = movedAfter === undefined ? undefined : parentOf(after.value, movedAfter);
  if (
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    after.value.unclaimed_anchors.length !== 0 ||
    movedAfter === undefined || parentAfterMove === undefined ||
    !sameNode(parentAfterMove, parent.value)
  ) {
    return reject(
      "document_structure_unreadable",
      "移動後の検算が合わない (identity / 本文 / 深さ / 親のいずれかが崩れる)。書かない",
    );
  }
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      locator: locatorText,
      observed_hash: hashSpan(next, movedAfter.body),
    },
    next_raw: next,
  });
}

// ===========================================================================
// task node の移動 (artifact 0.11.0)
// ===========================================================================
//
// task の所属は checkbox 行が置かれている wish の file / section (`my-wish-data.md` :24 / :267)。
// `children` も heading hierarchy も task を表さないので、task を運ぶ口を別に持つ。

function sectionStart(section: Section): number {
  return section.heading?.start ?? 0;
}

/** offset を含む wish node。file root node は file 先頭から最初の heading まで。 */
function ownerAt(listing: SectionListing, offset: number): ListedSection | undefined {
  let owner: ListedSection | undefined;
  for (const section of listing.sections) {
    if (sectionStart(section) <= offset) owner = section;
  }
  return owner;
}

function sectionLocator(path: string, section: Section): DocumentLocator {
  return section.node === "file_root" ? { path } : { path, heading: section.title };
}

function taskLocatorText(path: string, taskId: string): string {
  return `${path}#^${taskId}`;
}

/**
 * section の「自分の本文」の最後の非空行の終端。**子 heading の手前で止める。**
 *
 * heading node の `component_body` は子 heading を含む。body の末尾へ置くと、task は最後の子
 * heading の section に入り、別の wish の所属になる。
 */
function ownContentEnd(raw: string, listing: SectionListing, section: ListedSection): number {
  const index = listing.sections.indexOf(section);
  const nextHeading = listing.sections[index + 1]?.heading?.start;
  const limit = nextHeading !== undefined && nextHeading < section.body.end
    ? nextHeading
    : section.body.end;
  let end = section.body.start;
  for (const line of splitLines(raw)) {
    if (line.start < section.body.start) continue;
    if (line.start >= limit) break;
    if (line.text.trim().length > 0) end = Math.min(line.next, limit);
  }
  return end;
}

/**
 * wish の自分の本文の末尾へ task block を置く。
 *
 * 直前が list なら空行を挟まずに続け (同じ list の item になる)、そうでなければ空行で区切る。
 * 足す改行はどの node の本文にも入らない位置か、task block の一部になる。
 */
function insertTaskText(
  raw: string,
  listing: SectionListing,
  destination: ListedSection,
  text: string,
  newline: string,
): string {
  const at = ownContentEnd(raw, listing, destination);
  let prefix = raw.slice(0, at);
  const suffix = raw.slice(at);
  if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += newline;
  const previous = prefix.split(/\r?\n/).at(-2) ?? "";
  if (prefix.length > 0 && previous.trim().length > 0 && !isListLine(previous)) prefix += newline;
  let block = text;
  const following = suffix.split(/\r?\n/)[0] ?? "";
  if (suffix.length > 0 && following.trim().length > 0 && !isListLine(following)) block += newline;
  return prefix + block + suffix;
}

/**
 * node の並びと identity と「自分の本文」が、`changed` 以外で動いていないか。
 * **task を運ぶ write が、関係の無い wish を 1 byte も動かしていないこと**の検算。
 */
function sectionsKeptExcept(
  beforeRaw: string,
  before: SectionListing,
  afterRaw: string,
  after: SectionListing,
  changed: readonly Section[],
): boolean {
  if (before.sections.length !== after.sections.length) return false;
  if (
    JSON.stringify(before.unclaimed_anchors.map((anchor) => anchor.id)) !==
      JSON.stringify(after.unclaimed_anchors.map((anchor) => anchor.id))
  ) return false;
  const own = (raw: string, listing: SectionListing, index: number): string => {
    const section = listing.sections[index] as ListedSection;
    const next = listing.sections[index + 1]?.heading?.start;
    const end = next !== undefined && next < section.body.end ? next : section.body.end;
    return raw.slice(section.body.start, Math.max(section.body.start, end)).trimEnd();
  };
  for (let i = 0; i < before.sections.length; i += 1) {
    const left = before.sections[i] as ListedSection;
    const right = after.sections[i] as ListedSection;
    if (!sameNode(left, right) || left.level !== right.level) return false;
    if ((left.anchor?.id ?? null) !== (right.anchor?.id ?? null)) return false;
    const identity = (raw: string, section: Section) =>
      raw.slice(section.identity.start, section.identity.end).trimEnd();
    if (identity(beforeRaw, left) !== identity(afterRaw, right)) return false;
    if (changed.some((section) => sameNode(section, left))) continue;
    if (own(beforeRaw, before, i) !== own(afterRaw, after, i)) return false;
  }
  return true;
}

/** `document.read_task`。task の block と、今置かれている wish を返す。 */
export function readTaskView(
  raw: string,
  componentId: ComponentId,
  path: string,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentTaskView> {
  const block = locateTaskBlock(raw, componentId);
  if (!block.ok) return block;
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  const owner = ownerAt(listing.value, block.value.span.start);
  if (owner === undefined) return err("document_not_found", "task の所属 node を解決できない");
  return ok({
    component_id: componentId,
    locator: taskLocatorText(path, componentId),
    state: block.value.state,
    block_hash: block.value.hash,
    child_task_ids: block.value.child_task_ids,
    owner_locator: formatDocumentLocator(sectionLocator(path, owner)),
  });
}

/**
 * 運ぶ前の共通の検め。hash の照合と、block に他 node の identity が混ざっていないこと。
 *
 * **子 identity 保護 (裁定 Slice E) と同じ規則。**nest した子 task の anchor は block の一部として
 * 一緒に運ぶが、`[!meta]` callout や単独行の anchor、task 行でない行の anchor は他 node の
 * identity なので、混ざっていれば運ばない。
 */
export function preflightTaskMove(
  raw: string,
  taskLocator: DocumentLocator,
  input: MoveTaskInput,
): Result<TaskBlock | DocumentEdit> {
  const block = locateTaskBlock(raw, input.component_id);
  if (!block.ok) return block;
  const locatorText = formatDocumentLocator(taskLocator);
  if (block.value.hash !== input.expected_hash) {
    return ok(conflict(
      locatorText,
      block.value.hash,
      `expected_hash ${input.expected_hash} が現在の task block ${block.value.hash} と一致しない`,
      input.component_id,
    ));
  }
  const foreign = block.value.foreign;
  if (foreign !== undefined) {
    const what = foreign.kind === "id_anchor" ? "block id anchor" : "property callout";
    return ok({
      outcome: {
        disposition: "rejected",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: block.value.hash,
        code: "document_region_contains_foreign_identity",
        reason: `task block が他 node の identity (${what}` +
          `${foreign.id === undefined ? "" : ` ${foreign.id}`}) を含む。運ぶと他 node の所属まで` +
          "動くので書き込まない",
      },
    });
  }
  return ok(block.value);
}

function unreadable(componentId: ComponentId, locator: string, reason: string): DocumentEdit {
  return {
    outcome: {
      disposition: "rejected",
      component_id: componentId,
      locator,
      code: "document_structure_unreadable",
      reason,
    },
  };
}

/** 置いた後の検算。block が 1 つだけあり、形が変わらず、移動先の wish に属している。 */
function placedCorrectly(
  next: string,
  listing: SectionListing,
  taskId: string,
  shape: string,
  destination: Section,
): TaskBlock | undefined {
  const placed = locateTaskBlock(next, taskId);
  if (!placed.ok || placed.value.foreign !== undefined) return undefined;
  if (taskBlockShape(placed.value) !== shape) return undefined;
  const owner = ownerAt(listing, placed.value.span.start);
  if (owner === undefined || !sameNode(owner, destination)) return undefined;
  return placed.value;
}

/**
 * `document.move_task` (同じ file の中)。1 回の write で外して置く。
 */
export function applyMoveTaskWithinFile(
  raw: string,
  taskLocator: DocumentLocator,
  destinationLocator: DocumentLocator,
  input: MoveTaskInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const prepared = preflightTaskMove(raw, taskLocator, input);
  if (!prepared.ok) return prepared;
  if (isEdit(prepared.value)) return ok(prepared.value);
  const block = prepared.value;
  const path = taskLocator.path;
  const locatorText = taskLocatorText(path, input.component_id);
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  const destination = codec.locateSection(raw, destinationLocator.heading);
  if (!destination.ok) return destination;
  const owner = ownerAt(listing.value, block.span.start);
  if (owner === undefined) return err("document_not_found", "task の所属 node を解決できない");
  if (sameNode(owner, destination.value)) {
    return ok({
      outcome: {
        disposition: "noop",
        component_id: input.component_id,
        locator: locatorText,
        observed_hash: block.hash,
      },
    });
  }
  const newline = detectNewline(raw);
  const text = relocatedTaskText(block, newline);
  if (!text.ok) return text;
  const without = spliceSpan(raw, block.span, "");
  const middle = codec.listSections(without);
  if (!middle.ok) return middle;
  const target = middle.value.sections.find((section) => sameNode(section, destination.value));
  if (target === undefined) return err("document_not_found", "移動先の wish を解決できない");
  const next = insertTaskText(without, middle.value, target, text.value, newline);
  const after = codec.listSections(next);
  if (!after.ok) return after;
  const placed = placedCorrectly(
    next,
    after.value,
    input.component_id,
    taskBlockShape(block),
    destination.value,
  );
  if (
    placed === undefined ||
    !sectionsKeptExcept(raw, listing.value, next, after.value, [owner, destination.value])
  ) {
    return ok(unreadable(
      input.component_id,
      locatorText,
      "移動後の検算が合わない (task block / 他の wish の本文 / 所属のいずれかが崩れる)。書かない",
    ));
  }
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      locator: locatorText,
      observed_hash: placed.hash,
    },
    next_raw: next,
  });
}

/** file 跨ぎの移動の 1 段目。移動先 file に置いた結果。 */
export type TaskPlacement =
  | { readonly kind: "placed"; readonly next_raw: string; readonly hash: string }
  /** 前回の途中で既に置かれている。**再実行で移動元から外す段へ進める。** */
  | { readonly kind: "already_present"; readonly hash: string }
  /** 移動先に同じ id の task が別の形で居る。どちらが正しいか決められないので止める。 */
  | { readonly kind: "clash"; readonly reason: string };

/**
 * `document.move_task` (file 跨ぎ) の 1 段目。**移動先へ先に書く。**先に外すと、途中で落ちた時に
 * task がどの wish にも居なくなる。
 */
export function applyPlaceTask(
  destinationRaw: string,
  destinationLocator: DocumentLocator,
  block: TaskBlock,
  taskId: string,
  codec: RegionCodec = headingSectionCodec,
): Result<TaskPlacement> {
  const listing = codec.listSections(destinationRaw);
  if (!listing.ok) return listing;
  const destination = codec.locateSection(destinationRaw, destinationLocator.heading);
  if (!destination.ok) return destination;
  const shape = taskBlockShape(block);
  const existing = locateTaskBlock(destinationRaw, taskId);
  if (existing.ok) {
    const placed = placedCorrectly(destinationRaw, listing.value, taskId, shape, destination.value);
    return ok(
      placed === undefined
        ? { kind: "clash", reason: `移動先に task ^${taskId} が別の形か別の wish で既にある` }
        : { kind: "already_present", hash: placed.hash },
    );
  }
  if (existing.error.code !== "document_not_found") return existing;
  const target = listing.value.sections.find((section) => sameNode(section, destination.value));
  if (target === undefined) return err("document_not_found", "移動先の wish を解決できない");
  const newline = detectNewline(destinationRaw);
  const text = relocatedTaskText(block, newline);
  if (!text.ok) return text;
  const next = insertTaskText(destinationRaw, listing.value, target, text.value, newline);
  const after = codec.listSections(next);
  if (!after.ok) return after;
  const placed = placedCorrectly(next, after.value, taskId, shape, destination.value);
  if (
    placed === undefined ||
    !sectionsKeptExcept(destinationRaw, listing.value, next, after.value, [destination.value])
  ) {
    return err(
      "document_structure_unreadable",
      "移動先へ置いた後の検算が合わない。書かない",
      "new_parent_component_id",
    );
  }
  return ok({ kind: "placed", next_raw: next, hash: placed.hash });
}

/**
 * `document.move_task` (file 跨ぎ) の 2 段目。移動元から block を外す。
 * **write 直前に読み直した raw で hash を照合し直す。**1 段目の間に変わっていれば外さない。
 */
export function applyRemoveTask(
  raw: string,
  taskLocator: DocumentLocator,
  input: MoveTaskInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const prepared = preflightTaskMove(raw, taskLocator, input);
  if (!prepared.ok) return prepared;
  if (isEdit(prepared.value)) return ok(prepared.value);
  const block = prepared.value;
  const locatorText = formatDocumentLocator(taskLocator);
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  const owner = ownerAt(listing.value, block.span.start);
  if (owner === undefined) return err("document_not_found", "task の所属 node を解決できない");
  const next = spliceSpan(raw, block.span, "");
  const after = codec.listSections(next);
  if (!after.ok) return after;
  const gone = locateTaskBlock(next, input.component_id);
  if (
    gone.ok || gone.error.code !== "document_not_found" ||
    !sectionsKeptExcept(raw, listing.value, next, after.value, [owner])
  ) {
    return ok(unreadable(
      input.component_id,
      locatorText,
      "移動元から外した後の検算が合わない。書かない",
    ));
  }
  return ok({
    outcome: {
      disposition: "applied",
      component_id: input.component_id,
      locator: locatorText,
      observed_hash: block.hash,
    },
    next_raw: next,
  });
}

/**
 * `document.create_task` (Lane I、wish `w-01M3N7RV5K`)。`task.create_planned` が採番した
 * task の document node を、行末 `^t-...` anchor を持つ checkbox 行として `locator` の
 * section の自分の本文の末尾へ置く。
 *
 * - 同じ `^<id>` の task 行が同じ owner に正しく在れば `noop` (再送)。
 * - 同じ `^<id>` が別の形か別の owner に在れば `conflict` — 手組みの行を採用しない。
 * - title は非空白の 1 行だけ。改行と `^` を拒否する — 行末 anchor の形を壊す text を
 *   task line として書かせない。
 */
export function applyCreateTask(
  raw: string,
  input: CreateTaskInput,
  codec: RegionCodec = headingSectionCodec,
): Result<DocumentEdit> {
  const taskId = input.component_id;
  const locatorText = taskLocatorText(input.locator.path, taskId);
  // Markdown の anchor には vault 形だけを書く (register_component_id と同じ規則)。
  if (!isVaultComponentId(taskId)) {
    return err(
      "invalid_id",
      `component_id が vault 形 (<m|w|t>-<Crockford base32 10 桁>) でない: ${taskId}`,
      "component_id",
    );
  }
  const title = input.title.trim();
  if (title.length === 0 || /[\r\n^]/.test(title)) {
    return err(
      "invalid_field_type",
      "task title には非空白の 1 行だけを渡せる (改行と `^` は含めない)",
      "title",
    );
  }
  const listing = codec.listSections(raw);
  if (!listing.ok) return listing;
  const destination = codec.locateSection(raw, input.locator.heading);
  if (!destination.ok) return destination;

  const existing = locateTaskBlock(raw, taskId);
  if (existing.ok) {
    const placed = placedCorrectly(
      raw,
      listing.value,
      taskId,
      taskBlockShape(existing.value),
      destination.value,
    );
    if (placed === undefined) {
      return ok(conflict(
        locatorText,
        existing.value.hash,
        `task ^${taskId} が別の形か別の owner に既にある`,
        taskId,
      ));
    }
    return ok({
      outcome: {
        disposition: "noop",
        component_id: taskId,
        locator: locatorText,
        observed_hash: placed.hash,
      },
    });
  }
  if (existing.error.code !== "document_not_found") return existing;
  const target = listing.value.sections.find((section) => sameNode(section, destination.value));
  if (target === undefined) {
    return err("document_not_found", "置き先の section を解決できない", "locator");
  }
  const newline = detectNewline(raw);
  const next = insertTaskText(
    raw,
    listing.value,
    target,
    `- [ ] ${title} ^${taskId}${newline}`,
    newline,
  );
  const after = codec.listSections(next);
  if (!after.ok) return after;
  const placedBlock = locateTaskBlock(next, taskId);
  if (
    !placedBlock.ok || placedBlock.value.foreign !== undefined ||
    ownerAt(after.value, placedBlock.value.span.start) === undefined ||
    !sameNode(
      ownerAt(after.value, placedBlock.value.span.start) as ListedSection,
      destination.value,
    ) ||
    !sectionsKeptExcept(raw, listing.value, next, after.value, [destination.value])
  ) {
    return ok(unreadable(
      taskId,
      locatorText,
      "task 行を置いた後の検算が合わない (anchor / 他の node の本文 / 所属のいずれかが崩れる)。書かない",
    ));
  }
  return ok({
    outcome: {
      disposition: "applied",
      component_id: taskId,
      locator: locatorText,
      observed_hash: placedBlock.value.hash,
    },
    next_raw: next,
  });
}
