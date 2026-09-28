// `document.check_children` (bugfix 2)。children の要素が node へ解決できるかを返す。
//
// **Core (`children.ts`) は vault root を知らないので、この検査は Core に置かない。**
// 検査するのは vault root を知る層。CLI request から呼び、判定は port の `inspectLocator`
// (file / heading の実在) と store の `lookup` (id 要素の component 登録) の合成に留める。
// **読むだけで Markdown は書き換えない。**

import type { ComponentState } from "../components.ts";
import { COMPONENT_KINDS, type ComponentKind } from "../components.ts";
import { type ChildEntry } from "../children.ts";
import { type DocumentPort, parseDocumentLocator } from "../document.ts";
import { type ComponentId, parseComponentId } from "../ids.ts";
import { VAULT_ID_PREFIXES } from "../vault_ids.ts";

/** children の要素 1 件の解決結果。 */
export type ChildResolution = {
  readonly value: string;
  /** `link` = `[[...]]`、`id` = vault 形の component id、`other` = node link でない値。 */
  readonly element: "link" | "id" | "other";
  /** link / id にだけ出る。`other` (path pattern 等) には判定を置かない。 */
  readonly resolved?: boolean;
  /** 解決した node の canonical locator と種別 (link)。 */
  readonly locator?: string;
  readonly node?: "file_root" | "heading";
  /** 解決した component の kind (id)。 */
  readonly component_kind?: ComponentKind;
  readonly reason?: "component_not_registered" | "kind_mismatch";
};

/**
 * `[[target]]` の link target を `inspectLocator` へ渡せる locator 候補へ写す。
 *
 * `.md` の有無は同一視する (`sameLinkTarget` と同じ規則)。`[[a/b]]` は `a/b` と `a/b.md` の
 * 順に試す。`#` の後ろは heading としてそのまま渡す。
 */
function locatorCandidates(target: string): readonly string[] {
  const index = target.indexOf("#");
  const path = index < 0 ? target : target.slice(0, index);
  const heading = index < 0 ? "" : target.slice(index);
  if (path.toLowerCase().endsWith(".md")) return [target];
  return [`${path}${heading}`, `${path}.md${heading}`];
}

function resolveLink(document: DocumentPort, target: string): Partial<ChildResolution> {
  for (const candidate of locatorCandidates(target)) {
    const locator = parseDocumentLocator(candidate, "child_link");
    if (!locator.ok) continue;
    const view = document.inspectLocator(locator.value);
    if (view.ok) {
      return {
        resolved: true,
        locator: view.value.locator,
        node: view.value.node,
      };
    }
  }
  return { resolved: false };
}

function resolveId(
  lookup: (componentId: ComponentId) => ComponentState | undefined,
  value: string,
): Partial<ChildResolution> {
  const id = parseComponentId(value, "child_value");
  if (!id.ok) return { resolved: false, reason: "component_not_registered" };
  const state = lookup(id.value);
  if (state === undefined) {
    return { resolved: false, reason: "component_not_registered" };
  }
  // 登録口と同じ invariant: prefix と kind が一致していなければ結び方が壊れている。
  const prefix = value.slice(0, value.indexOf("-"));
  const expected = COMPONENT_KINDS.find((kind) => VAULT_ID_PREFIXES[kind] === prefix);
  if (expected !== undefined && state.kind !== expected) {
    return { resolved: false, reason: "kind_mismatch", component_kind: state.kind };
  }
  return { resolved: true, component_kind: state.kind };
}

/** `readChildren` が返した要素を解決する。要素の並びはそのまま。 */
export function checkChildEntries(
  document: DocumentPort,
  lookup: (componentId: ComponentId) => ComponentState | undefined,
  entries: readonly ChildEntry[],
): readonly ChildResolution[] {
  return entries.map((entry) => {
    if (entry.link_target !== undefined) {
      return { value: entry.value, element: "link", ...resolveLink(document, entry.link_target) };
    }
    if (entry.component_id !== undefined) {
      return { value: entry.value, element: "id", ...resolveId(lookup, entry.component_id) };
    }
    // node link でない要素 (project node の path pattern 等) には判定を置かない。
    return { value: entry.value, element: "other" };
  });
}
