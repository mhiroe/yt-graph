// mind -> wish link の read-time cross-DB resolver (2 層 DB)。
//
// vault の DB は repo の DB の**上**に居る。mind が持つ `wish_component_id` は local の
// `COMPONENTS` だけでは解決できず、指し先の wish が下層 repo の DB に居ることがある。
// この module は vault に登録された repo を read だけで舐め、wish の居場所を報告する。
//
// **裁定 (workflow v4 track B):**
//
// - 解決は read 時だけ。cross-DB transaction は張らず、repo DB へ一切書かない。
//   `relation.begin_external` も使わない。壊れた link は壊れたまま報告し、自動では消さない。
// - 「上が下を指す」だけ。解決は vault から登録 repo へ**外へ向かう一方向**で、
//   repo 側から vault を辿る経路は持たない。
// - registry は device ごとの file `<vault root>/.workflow.nosync/repositories.json`。
//   repo DB の置き場は規約 `<repo root>/.workflow.nosync/workflow.sqlite` で、
//   registry には root だけを持つ (db path は保存しない)。format は
//   `src/cli/repo_registry.ts` と共有する。

import { existsSync } from "node:fs";

import { err, ok, type Result } from "../result.ts";
import { joinPath, parseRepositoryId } from "../ids.ts";
import { parseDocumentLocator } from "../document.ts";
import { createFsDocumentPort } from "../adapters/fs_document.ts";
import { openNodeSqliteDriver } from "../adapters/node_sqlite.ts";
import { rowString, type SqlDriver } from "../sql/driver.ts";
import { dbPath } from "./provision.ts";
import { loadRegistry, type RegistryEntry } from "./repo_registry.ts";

export type { RegistryEntry };

/**
 * `<root>/.workflow.nosync/repositories.json` を読む (`repo_registry.ts` と同じ file)。
 *
 * - file が無い → `ok([])`。repo を 1 つも登録していない vault は正常形。
 * - 読めない / JSON として壊れている / 形が違う → `invalid_field_type`。**壊れた registry を
 *   空として読まない。**「登録 0 件」と「読めない」を混ぜると、全 repo unreachable の報告が
 *   消えてしまう。
 *
 * `loadRegistry` の読みに加えて、ここでは entry ごとの repository_id の形も検める。
 * 形の壊れた id を DB 照合へ流すと、mismatch (unreachable) と「registry が壊れている」が
 * 区別できなくなる。
 */
export function loadRegistryEntries(root: string): Result<readonly RegistryEntry[]> {
  const loaded = loadRegistry(root);
  if (!loaded.ok) return loaded;
  const entries: RegistryEntry[] = [];
  for (const entry of loaded.value) {
    const entryPath = joinPath("repositories", entry.repository_id);
    const repositoryId = parseRepositoryId(entry.repository_id, entryPath);
    if (!repositoryId.ok) {
      return err(
        "invalid_field_type",
        `registry の repository_id が不正: ${repositoryId.error.message}`,
        entryPath,
      );
    }
    if (entry.root.length === 0) {
      return err(
        "invalid_field_type",
        "registry entry の root は空でない string である必要がある",
        joinPath(entryPath, "root"),
      );
    }
    entries.push({ repository_id: repositoryId.value, root: entry.root });
  }
  // 舐める順を固定する。coverage 報告 (probes) の並びが呼び出しごとに変わらないように。
  entries.sort((left, right) =>
    left.repository_id < right.repository_id ? -1 : left.repository_id > right.repository_id ? 1 : 0
  );
  return ok(entries);
}

/** 1 repo の probe 結果。`found` は COMPONENTS に row が在ったこと、document まで読めたことではない。 */
export type RepoProbeState = "found" | "absent" | "unreachable";

/** repo ごとの probe 明細。caller が coverage (どこまで舐めたか) を報告するための材料。 */
export type RepoProbe = {
  readonly repository_id: string;
  readonly state: RepoProbeState;
  /** `found` のときの COMPONENTS.kind。 */
  readonly kind?: string;
  /** `found` のときの document projection の locator。 */
  readonly document_locator?: string;
  /** `unreachable` の理由 (人間向け)。 */
  readonly detail?: string;
};

/**
 * wish 1 件の cross-DB 解決結果。
 *
 * - `live`: どれかの repo に kind=wish で居て、document の node もその id を指している。
 * - `document_missing`: repo DB に wish は居るが、locator が指す document node が読めない
 *   (file 消失 / anchor 不在 / 別 id を指す)。live とは報告しない。
 * - `not_a_wish`: component は居るが kind が wish ではない。
 * - `not_registered`: 登録 repo をすべて舐めて、どこにも居ない。
 * - `unresolved`: どこにも見つからず、**かつ** 1 つ以上の repo に到達できなかった。
 *   「居ない」と「確かめられなかった」を混ぜない。
 */
export type WishRepositoryResolution =
  & { readonly probes: readonly RepoProbe[] }
  & (
    | { readonly state: "live"; readonly repository_id: string }
    | { readonly state: "document_missing"; readonly repository_id: string }
    | { readonly state: "not_a_wish"; readonly repository_id: string }
    | { readonly state: "not_registered" }
    | { readonly state: "unresolved"; readonly unreachable: readonly string[] }
  );

/** probe の内部結果。`found` が在れば COMPONENTS の row を持つ。 */
type ProbeOutcome = {
  readonly probe: RepoProbe;
  readonly found?: {
    readonly kind: string;
    readonly document_locator?: string;
  };
};

/**
 * repo 1 件を read だけで舐める。
 *
 * 手順:
 *
 * 1. `<root>/.workflow.nosync/workflow.sqlite` を stat する。**無ければ unreachable で、
 *    file は作らない。** `DatabaseSync` は open で file を作るので、先に存在を見る。
 * 2. `repository` の singleton row を読み、registry の id と突き合わせる。読めない / 無い /
 *    違う → unreachable。**repo path は locator であって identity ではない**ので、
 *    root が registry のものでも DB の中身が違えばその repo とは言わない。
 * 3. `components` から `component_id` で kind / document_locator を読む。
 *
 * 開けた driver は必ず `finally` で閉じる。
 */
function probeRepository(entry: RegistryEntry, wishComponentId: string): ProbeOutcome {
  const unreachable = (detail: string): ProbeOutcome => ({
    probe: { repository_id: entry.repository_id, state: "unreachable", detail },
  });
  const db = dbPath(entry.root);
  if (!existsSync(db)) {
    return unreachable(`workflow.sqlite が無い: ${db}`);
  }
  let driver: SqlDriver;
  try {
    driver = openNodeSqliteDriver({ location: db });
  } catch (cause) {
    return unreachable(`workflow.sqlite を開けない: ${String(cause)}`);
  }
  try {
    let repositoryRow;
    try {
      repositoryRow = driver
        .prepare("SELECT repository_id FROM repository WHERE singleton = 1")
        .get();
    } catch (cause) {
      return unreachable(`repository metadata を読めない: ${String(cause)}`);
    }
    const actual = repositoryRow === undefined
      ? undefined
      : rowString(repositoryRow, "repository_id");
    if (actual !== entry.repository_id) {
      return unreachable(
        `repository_id が registry と一致しない (registry=${entry.repository_id},` +
          ` db=${String(actual)})`,
      );
    }
    let row;
    try {
      row = driver
        .prepare("SELECT kind, document_locator FROM components WHERE component_id = ?")
        .get(wishComponentId);
    } catch (cause) {
      return unreachable(`components を読めない: ${String(cause)}`);
    }
    if (row === undefined) {
      return { probe: { repository_id: entry.repository_id, state: "absent" } };
    }
    const kind = rowString(row, "kind") ?? "";
    const locator = rowString(row, "document_locator");
    return {
      probe: {
        repository_id: entry.repository_id,
        state: "found",
        kind,
        ...(locator === undefined ? {} : { document_locator: locator }),
      },
      found: { kind, ...(locator === undefined ? {} : { document_locator: locator }) },
    };
  } finally {
    driver.close();
  }
}

/**
 * DB に在る wish の document node を確かめる。
 *
 * local の `mind_wish.list` が `document_missing` 判定に使っているのと同じ口
 * (`DocumentPort.inspectLocator`) で、locator が指す node が読めて、その anchor が
 * 探している wish の id であることを見る。**読めないものを live と言わない。**
 */
function wishDocumentIsLive(
  entry: RegistryEntry,
  locatorText: string | undefined,
  wishComponentId: string,
): boolean {
  if (locatorText === undefined) return false;
  const locator = parseDocumentLocator(locatorText, "locator");
  if (!locator.ok) return false;
  const document = createFsDocumentPort({
    root: entry.root,
    resolve_locator: () => locatorText,
  });
  const node = document.inspectLocator(locator.value);
  return node.ok && node.value.component_id === wishComponentId;
}

/**
 * 登録 repo を順に舐めて `wishComponentId` を解決する。
 *
 * component_id は vault 内で一意なので、**最初に見つかった repo で確定する**。見つかった
 * 時点で打ち切るので、それ以降の repo は probes に出ない (coverage は「舐めた分」)。
 */
export function resolveWishInRepositories(
  entries: readonly RegistryEntry[],
  wishComponentId: string,
): WishRepositoryResolution {
  const probes: RepoProbe[] = [];
  for (const entry of entries) {
    const outcome = probeRepository(entry, wishComponentId);
    probes.push(outcome.probe);
    const found = outcome.found;
    if (found === undefined) continue;
    if (found.kind !== "wish") {
      return { state: "not_a_wish", repository_id: entry.repository_id, probes };
    }
    return wishDocumentIsLive(entry, found.document_locator, wishComponentId)
      ? { state: "live", repository_id: entry.repository_id, probes }
      : { state: "document_missing", repository_id: entry.repository_id, probes };
  }
  const unreachable = probes
    .filter((probe) => probe.state === "unreachable")
    .map((probe) => probe.repository_id);
  if (unreachable.length > 0) {
    return { state: "unresolved", unreachable, probes };
  }
  return { state: "not_registered", probes };
}
