// cutover の検査 (workflow-apm plan Phase F step 8)。
//
// scan が見つけた anchor の集合と DB (COMPONENTS / COMPONENT_RELATIONS / mind_wish_links) を
// 突き合わせ、cutover が「通常運用を開ける」状態かを判定する。
// **読み取りだけ。** ここで直さない — 直すのは bind か人の判断。

import { listMindWishLinks, type MindWishLinkView } from "../sql/document_projection.ts";
import { rowString } from "../sql/driver.ts";
import type { SqliteWorkflowStore } from "../sql/store.ts";
import { anchorIntent, type ScanResult } from "./scan.ts";
import { parseComponentId } from "../ids.ts";
import { parseSprintRegistry, scanSprintBindings, SPRINT_REGISTRY_PATH } from "../sprints.ts";
import { expectedSprintBinding, sprintEntriesForRegistry, sprintHeadsOf } from "../sql/sprints.ts";

/** どこにも結ばれていない (COMPONENTS に row が無い) vault 形 anchor。 */
export type AuditUnbound = {
  readonly id: string;
  readonly node: string;
  readonly locator: string;
};

/** vault 形でない、m/w/t prefix を持つ anchor の id (vault の書き損じ)。 */
export type AuditInvalid = {
  readonly id: string;
  readonly node: string;
  readonly locator: string;
};

/** vault の identity を意図しない anchor (Excalidraw の element id 等)。情報であって失敗ではない。 */
export type AuditForeign = {
  readonly id: string;
  readonly locator: string;
};

/** 2 か所以上に在る id。 */
export type AuditDuplicate = {
  readonly id: string;
  readonly locators: readonly string[];
};

/** 壊れた参照 1 件。`source` がどの table の話かを持つ。 */
export type AuditBrokenRelation =
  & { readonly source: "component_relations" | "mind_wish_links" }
  & ({
    readonly source: "component_relations";
    readonly from_component_id: string;
    readonly to_component_id: string;
    readonly relation_type: string;
  } | {
    readonly source: "mind_wish_links";
    readonly mind_component_id: string;
    readonly child_value: string;
    readonly wish_component_id?: string;
    readonly reason?: string;
  });

/** 他 repo を指す relation。cutover 失敗ではなく情報として数える。 */
export type AuditExternalRelation = {
  readonly from_component_id: string;
  readonly to_repository_id: string;
  readonly to_component_id: string;
  readonly relation_type: string;
};

/** document projection の欠損 (未観測、または locator drift)。 */
export type AuditProjectionGap = {
  readonly component_id: string;
  readonly detail: string;
};

/**
 * sprint projection の食い違い (schema 8)。
 *
 * - `registry_missing`: DB に sprint が在るのに `docs/sprints.md` が無い。
 * - `registry_parse`: registry が parse 不能 (v1/v2 どちらの形でも読めない)。
 * - `registry_entry`: entry が DB row と食い違う (field 不一致 / DB に無い / 欠落)。
 * - `registry_head`: `## current` head が `current_sprints` と食い違う。
 * - `binding`: `> sprint:` key が expected (effective iteration の最新 sprint) と違う。
 */
export type AuditSprintMismatch = {
  readonly kind:
    | "registry_missing"
    | "registry_parse"
    | "registry_entry"
    | "registry_head"
    | "binding";
  readonly locator?: string;
  readonly detail: string;
};

export type AuditReport = {
  readonly repository_id: string;
  readonly anchors_scanned: number;
  readonly components_total: number;
  readonly counts: {
    readonly unbound: number;
    readonly invalid: number;
    /** foreign anchor (m/w/t prefix 無し)。実 vault に数百件ある通常状態。失敗ではない。 */
    readonly foreign_anchors: number;
    readonly duplicate: number;
    readonly broken_relations: number;
    /** 他 repo への relation。失敗ではなく情報。 */
    readonly external_relations: number;
    readonly projection_gaps: number;
    /**
     * block anchor (`path#^id`、非 task 行の行末) から結ばれた component。
     * projectable な document node を持たないので locator / hash は NULL のまま残る —
     * **失敗ではなく情報。** `failures` には含めない。
     */
    readonly identity_only: number;
    /**
     * 走査から外した派生 view file (`generated` frontmatter tag) の数。
     * 正本の anchor の複写なので失敗ではなく情報。
     */
    readonly skipped_derived: number;
    readonly orphan_components: number;
    /** sprint projection の食い違い (registry / `sprint:` binding)。 */
    readonly sprint_mismatches: number;
    /** 失敗の合計。`external_relations` / `identity_only` / `foreign_anchors` / `skipped_derived` は含まない。 */
    readonly failures: number;
  };
  readonly unbound_ids: readonly AuditUnbound[];
  readonly invalid_ids: readonly AuditInvalid[];
  readonly foreign_anchors: readonly AuditForeign[];
  readonly duplicate_ids: readonly AuditDuplicate[];
  readonly broken_relations: readonly AuditBrokenRelation[];
  readonly external_relations: readonly AuditExternalRelation[];
  readonly projection_gaps: readonly AuditProjectionGap[];
  readonly identity_only_components: readonly string[];
  /** 走査から外した派生 view file の path (情報)。 */
  readonly skipped_derived_files: readonly string[];
  readonly orphan_components: readonly string[];
  readonly sprint_mismatches: readonly AuditSprintMismatch[];
};

/** audit が mind -> wish link を跨 repo で解決するための口。CLI 層が registry 解決済みの link 一覧を渡す。 */
export type AuditDeps = {
  /**
   * `listMindWishLinks` の結果を registry 経由で解決した link 一覧。
   * CLI 層で `resolveWishLinks` (cli/dispatch.ts) を通したものをそのまま渡す想定。
   * 省略時は従来どおり local 判定だけを使う (registry を持たない環境 = 全件 local)。
   */
  readonly mind_wish_links?: readonly MindWishLinkView[];
};

/**
 * scan 結果と DB を突き合わせる。
 *
 * - `unbound_ids`: vault 形だが COMPONENTS に row が無い anchor (unclaimed を含み、
 *   その場合は `node` に `"unclaimed"` が入る)。
 * - `invalid_ids`: vault 形でない anchor。
 * - `duplicate_ids`: 2 か所以上に anchor がある id。
 * - `broken_relations`: 同一 repo の行き先が COMPONENTS に無い `component_relations` と、
 *   read state が `broken` の `mind_wish_links`。
 * - `projection_gaps`: `document_locator` / `document_observed_hash` が NULL、または
 *   保存された locator が scan で見つかった位置と違う (locator drift)。
 * - `orphan_components`: scan に 1 つも現れない COMPONENTS row。status が `dropped` の
 *   row は退役済みとして数えない (anchor を正本から消すのが削除の正しい経路)。
 */
export function auditCutover(
  store: SqliteWorkflowStore,
  scan: ScanResult,
  deps: AuditDeps = {},
): AuditReport {
  const driver = store.driver;
  const repositoryId = store.context.repository_id;

  const componentRows = driver
    .prepare(
      "SELECT component_id, status, document_locator, document_observed_hash FROM components",
    )
    .all();
  const componentIds = new Set(
    componentRows.map((row) => rowString(row, "component_id") ?? ""),
  );

  const unbound: AuditUnbound[] = [];
  const invalid: AuditInvalid[] = [];
  const foreign: AuditForeign[] = [];
  for (const anchor of scan.anchors) {
    if (anchorIntent(anchor) === "foreign") {
      // vault を意図しない anchor は「結ばれていない」ではなく「結ぶ対象ではない」。
      foreign.push({ id: anchor.id, locator: anchor.locator });
      continue;
    }
    if (!anchor.vault_shaped) {
      // m/w/t prefix があるのに形が壊れている。vault の書き損じとして失敗に数える。
      invalid.push({ id: anchor.id, node: anchor.node, locator: anchor.locator });
      continue;
    }
    if (!componentIds.has(anchor.id)) {
      unbound.push({ id: anchor.id, node: anchor.node, locator: anchor.locator });
    }
  }

  // foreign id の重複 (Excalidraw 要素の再利用等) は vault の問題ではないので失敗にしない。
  const duplicateIds: AuditDuplicate[] = scan.duplicates
    .filter((id) => (scan.by_id.get(id) ?? []).some((anchor) => anchorIntent(anchor) === "vault"))
    .map((id) => ({
      id,
      locators: (scan.by_id.get(id) ?? []).map((anchor) => anchor.locator),
    }));

  const broken: AuditBrokenRelation[] = [];
  const external: AuditExternalRelation[] = [];
  const relationRows = driver
    .prepare(
      "SELECT from_component_id, to_repository_id, to_component_id, relation_type" +
        " FROM component_relations ORDER BY from_component_id, to_component_id, relation_type",
    )
    .all();
  for (const row of relationRows) {
    const toRepository = rowString(row, "to_repository_id") ?? "";
    const toComponent = rowString(row, "to_component_id") ?? "";
    if (toRepository !== repositoryId) {
      // 他 repo を指す relation はこの DB では検査できない。失敗ではなく情報として残す。
      external.push({
        from_component_id: rowString(row, "from_component_id") ?? "",
        to_repository_id: toRepository,
        to_component_id: toComponent,
        relation_type: rowString(row, "relation_type") ?? "",
      });
      continue;
    }
    if (!componentIds.has(toComponent)) {
      broken.push({
        source: "component_relations",
        from_component_id: rowString(row, "from_component_id") ?? "",
        to_component_id: toComponent,
        relation_type: rowString(row, "relation_type") ?? "",
      });
    }
  }
  // mind -> wish link は local COMPONENTS だけで判定しない。vault registry (2 層 DB) に
  // 載る repo へ解決できる link は read-time では live なので、CLI 層が解決済みの link 一覧を
  // 渡した場合はそれを使う (readiness-b 4-5)。解決できない / 到達できない link は理由を
  // 残したまま broken に入る。
  const links = deps.mind_wish_links ?? listMindWishLinks(store, {});
  for (const link of links) {
    if (link.state !== "broken") continue;
    broken.push({
      source: "mind_wish_links",
      mind_component_id: link.mind_component_id,
      child_value: link.child_value,
      ...(link.wish_component_id === undefined
        ? {}
        : { wish_component_id: link.wish_component_id }),
      ...(link.reason === undefined ? {} : { reason: link.reason }),
    });
  }

  const projectionGaps: AuditProjectionGap[] = [];
  const identityOnly: string[] = [];
  for (const row of componentRows) {
    const componentId = rowString(row, "component_id") ?? "";
    const locator = rowString(row, "document_locator");
    const hash = rowString(row, "document_observed_hash");
    if (locator === undefined || hash === undefined) {
      // block anchor (非 task 行の行末 `^id`) から結ばれた component は projectable な
      // document node を持たない。NULL は「観測が来ていない」ではなく「観測する本文が無い」
      // なので gap にせず、identity-only として情報側へ置く。
      const scanned = scan.by_id.get(componentId);
      if (scanned !== undefined && scanned.every((anchor) => anchor.node === "block")) {
        identityOnly.push(componentId);
        continue;
      }
      // `dropped` は terminal — 正本側の anchor を消した退役 component は gap に数えない。
      // これが無いと event-sourced な COMPONENTS row が永続する以上、ゴミは削除不能になる。
      // anchor が残っている (scanned !== undefined) dropped は identity_only か drift の
      // 対象として従来どおり見る。
      if (rowString(row, "status") === "dropped" && scanned === undefined) continue;
      projectionGaps.push({
        component_id: componentId,
        detail: "document_locator / document_observed_hash が NULL (initial projection 未到達)",
      });
      continue;
    }
    // locator drift: scan がこの id を見つけた位置と DB の locator が違う。
    // scan に無い id は orphan 側が報告するので、ここでは見つかった場合だけ比較する。
    const scanned = scan.by_id.get(componentId);
    if (scanned !== undefined && !scanned.some((anchor) => anchor.locator === locator)) {
      projectionGaps.push({
        component_id: componentId,
        detail: `locator drift: stored=${locator} scanned=${
          scanned.map((anchor) => anchor.locator).join(", ")
        }`,
      });
    }
  }

  // scan に 1 つも現れない row は orphan — ただし `dropped` は除く。退役 component の
  // anchor は正本から消すのが正しいので、残った row を失敗に数えると削除経路が閉じる。
  const orphans = componentRows
    .filter((row) => rowString(row, "status") !== "dropped")
    .map((row) => rowString(row, "component_id") ?? "")
    .filter((id) => !scan.by_id.has(id))
    .sort();

  // --- sprint projection parity (schema 8) ---
  // registry (`docs/sprints.md`) と `sprint:` binding は DB state の派生物。
  // generated であっても drift は報告する — 直すのは sprint.repair、audit は読むだけ。
  const sprintMismatches: AuditSprintMismatch[] = [];
  const dbEntries = sprintEntriesForRegistry(driver);
  const registryRaw = scan.sources.get(SPRINT_REGISTRY_PATH);
  if (registryRaw === undefined) {
    if (dbEntries.length > 0) {
      sprintMismatches.push({
        kind: "registry_missing",
        locator: SPRINT_REGISTRY_PATH,
        detail: `DB に sprint が ${dbEntries.length} 件在るが registry が無い`,
      });
    }
  } else {
    const parsed = parseSprintRegistry(registryRaw);
    if (!parsed.ok) {
      sprintMismatches.push({
        kind: "registry_parse",
        locator: SPRINT_REGISTRY_PATH,
        detail: `registry を parse できない: ${parsed.error.message}`,
      });
    } else {
      const fileById = new Map(parsed.value.entries.map((entry) => [entry.sprint_id, entry]));
      const dbById = new Map(dbEntries.map((entry) => [entry.sprint_id, entry]));
      for (const fileEntry of parsed.value.entries) {
        const want = dbById.get(fileEntry.sprint_id);
        if (want === undefined) {
          sprintMismatches.push({
            kind: "registry_entry",
            locator: `${SPRINT_REGISTRY_PATH}#${fileEntry.sprint_id}`,
            detail: `registry の sprint が DB に無い: ${fileEntry.sprint_id}`,
          });
          continue;
        }
        const diffs: string[] = [];
        if (fileEntry.iteration_id !== want.iteration_id) {
          diffs.push(`iteration_id=${fileEntry.iteration_id}!=${want.iteration_id}`);
        }
        if (fileEntry.seq !== want.seq) diffs.push(`seq=${fileEntry.seq}!=${want.seq}`);
        if (fileEntry.issued_seq !== want.issued_seq) {
          diffs.push(`issued_seq=${fileEntry.issued_seq}!=${want.issued_seq}`);
        }
        if ((fileEntry.previous_sprint_id ?? "") !== (want.previous_sprint_id ?? "")) {
          diffs.push(
            `previous=${fileEntry.previous_sprint_id ?? ""}!=${want.previous_sprint_id ?? ""}`,
          );
        }
        if (fileEntry.goal !== want.goal) diffs.push("goal");
        if (fileEntry.accepted !== want.accepted) diffs.push("accepted");
        if ((fileEntry.baseline_ref ?? "") !== (want.baseline_ref ?? "")) {
          diffs.push("baseline");
        }
        if (fileEntry.issued_at !== want.issued_at) diffs.push("issued_at");
        const wantRoster = new Map(
          want.roster.map((member) => [member.component_id, member.state_revision]),
        );
        const fileRoster = new Map(
          fileEntry.roster.map((member) => [member.component_id, member.state_revision]),
        );
        if (wantRoster.size !== fileRoster.size) {
          diffs.push(`roster=${fileRoster.size}!=${wantRoster.size}`);
        } else {
          for (const [id, revision] of fileRoster) {
            if (wantRoster.get(id) !== revision) {
              diffs.push(`roster ${id}`);
              break;
            }
          }
        }
        if (diffs.length > 0) {
          sprintMismatches.push({
            kind: "registry_entry",
            locator: `${SPRINT_REGISTRY_PATH}#${fileEntry.sprint_id}`,
            detail: `entry が DB と食い違う: ${diffs.join(", ")}`,
          });
        }
      }
      for (const want of dbEntries) {
        if (!fileById.has(want.sprint_id)) {
          sprintMismatches.push({
            kind: "registry_entry",
            locator: `${SPRINT_REGISTRY_PATH}#${want.sprint_id}`,
            detail: `DB の sprint が registry に無い: ${want.sprint_id}`,
          });
        }
      }
      const fileHeads = new Map(
        parsed.value.heads.map((head) => [head.iteration_id, head.sprint_id]),
      );
      const dbHeads = new Map(
        sprintHeadsOf(driver).map((head) => [head.iteration_id, head.sprint_id]),
      );
      for (const [iterationId, sprintId] of fileHeads) {
        const want = dbHeads.get(iterationId);
        if (want === undefined) {
          sprintMismatches.push({
            kind: "registry_head",
            locator: SPRINT_REGISTRY_PATH,
            detail: `## current の head (${iterationId} -> ${sprintId}) が DB に無い`,
          });
        } else if (want !== sprintId) {
          sprintMismatches.push({
            kind: "registry_head",
            locator: SPRINT_REGISTRY_PATH,
            detail: `head が食い違う: registry=${sprintId} DB=${want} (${iterationId})`,
          });
        }
      }
      for (const [iterationId, sprintId] of dbHeads) {
        if (!fileHeads.has(iterationId)) {
          sprintMismatches.push({
            kind: "registry_head",
            locator: SPRINT_REGISTRY_PATH,
            detail: `DB の head (${iterationId} -> ${sprintId}) が ## current に無い`,
          });
        }
      }
    }
  }
  for (const [path, raw] of scan.sources) {
    for (const binding of scanSprintBindings(raw)) {
      const parsed = parseComponentId(binding.component_id, "component_id");
      if (!parsed.ok) {
        sprintMismatches.push({
          kind: "binding",
          locator: `${path}#${binding.component_id}`,
          detail: `sprint: binding の component id が vault 形でない: ${binding.component_id}`,
        });
        continue;
      }
      const expected = expectedSprintBinding(driver, parsed.value, path);
      if (expected === undefined || expected.sprint_id !== binding.sprint_id) {
        sprintMismatches.push({
          kind: "binding",
          locator: `${path}#${binding.component_id}`,
          detail: `sprint: ${binding.sprint_id} が expected ` +
            `(${expected?.sprint_id ?? "なし"}) と一致しない`,
        });
      }
    }
  }

  const failures = unbound.length + invalid.length + duplicateIds.length + broken.length +
    projectionGaps.length + orphans.length + sprintMismatches.length;
  return {
    repository_id: repositoryId,
    anchors_scanned: scan.anchors.length,
    components_total: componentRows.length,
    counts: {
      unbound: unbound.length,
      invalid: invalid.length,
      foreign_anchors: foreign.length,
      duplicate: duplicateIds.length,
      broken_relations: broken.length,
      external_relations: external.length,
      projection_gaps: projectionGaps.length,
      identity_only: identityOnly.length,
      skipped_derived: scan.skipped_derived.length,
      orphan_components: orphans.length,
      sprint_mismatches: sprintMismatches.length,
      failures,
    },
    unbound_ids: unbound,
    invalid_ids: invalid,
    foreign_anchors: foreign,
    duplicate_ids: duplicateIds,
    broken_relations: broken,
    external_relations: external,
    projection_gaps: projectionGaps,
    identity_only_components: identityOnly,
    skipped_derived_files: scan.skipped_derived,
    orphan_components: orphans,
    sprint_mismatches: sprintMismatches,
  };
}
