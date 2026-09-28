// Document projection transaction。
// `docs/candidate/workflow-v4/persistence.md` の「Document projection transaction」を実装する。
//
// **VaultFileObserver 由来の観測は workflow state ではない。** この transaction が触るのは
// `COMPONENTS` の document projection 4 列と、mind の所属の projection `MIND_WISH_LINKS`
// (artifact 0.13.0) だけで、`state_revision`、`ACTIVITIES`、`DOMAIN_EVENTS`、`EVENT_OUTBOX`、
// `OPERATIONS`、`COMPONENT_RELATIONS` を一切変更しない。他 device へ workflow event としても
// 配信しない。

import { err, ok, type Result } from "../result.ts";
import type { ComponentId } from "../ids.ts";
import { readMindChild } from "../children.ts";
import type {
  DocumentProjectionObservation,
  DocumentProjectionPort,
  DocumentProjectionResult,
} from "../document.ts";
import { rowInteger, rowString } from "./driver.ts";
import type { SqliteWorkflowStore } from "./store.ts";

/** projection が触ってよい列。ここに無い列をこの経路から書かない。 */
export const DOCUMENT_PROJECTION_COLUMNS = [
  "title_projection",
  "document_locator",
  "document_observed_hash",
  "document_projection_revision",
] as const;

/** DB が持っている現在の projection。比較のためだけに読む。 */
export type StoredDocumentProjection = {
  readonly kind: string | undefined;
  readonly title_projection: string | undefined;
  readonly document_locator: string | undefined;
  readonly document_observed_hash: string | undefined;
  readonly document_projection_revision: number;
};

export function readDocumentProjection(
  store: SqliteWorkflowStore,
  componentId: ComponentId,
): StoredDocumentProjection | undefined {
  const row = store.driver
    .prepare(
      "SELECT kind, title_projection, document_locator, document_observed_hash," +
        " document_projection_revision FROM components WHERE component_id = ?",
    )
    .get(componentId);
  if (row === undefined) return undefined;
  return {
    kind: rowString(row, "kind"),
    title_projection: rowString(row, "title_projection"),
    document_locator: rowString(row, "document_locator"),
    document_observed_hash: rowString(row, "document_observed_hash"),
    document_projection_revision: rowInteger(row, "document_projection_revision") ?? 0,
  };
}

/** `MIND_WISH_LINKS` の 1 行。観測した要素の値と、その読み。 */
type MindWishRow = {
  readonly child_value: string;
  readonly element_kind: "id" | "link" | "malformed";
  readonly wish_component_id: string | undefined;
};

const byValue = (left: MindWishRow, right: MindWishRow): number =>
  left.child_value < right.child_value ? -1 : left.child_value > right.child_value ? 1 : 0;

function mindWishRowsOf(children: readonly string[]): readonly MindWishRow[] {
  // 同じ値が 2 回あっても所属は 1 つ。PK が (mind, 値) なので畳む。
  return [...new Set(children)].map((value) => {
    const reading = readMindChild(value);
    return {
      child_value: value,
      element_kind: reading.kind,
      wish_component_id: reading.kind === "id" ? reading.component_id : undefined,
    };
  }).sort(byValue);
}

function storedMindWishRows(
  store: SqliteWorkflowStore,
  mindId: ComponentId,
): readonly MindWishRow[] {
  return store.driver
    .prepare(
      "SELECT child_value, element_kind, wish_component_id FROM mind_wish_links" +
        " WHERE mind_component_id = ?",
    )
    .all(mindId)
    .map((row) => ({
      child_value: rowString(row, "child_value") ?? "",
      element_kind: (rowString(row, "element_kind") ?? "malformed") as MindWishRow["element_kind"],
      wish_component_id: rowString(row, "wish_component_id"),
    }))
    .sort(byValue);
}

/**
 * 観測 1 件を local transaction で適用する。
 *
 * **裁定 (Slice C、実測)**: title / locator / observed_hash が 3 つとも現在値と等しい観測は
 * `noop` にし、**`document_projection_revision` を進めない**。
 *
 * - revision が表すのは「local projection が更新されたこと」であって「観測が届いたこと」ではない。
 *   進めると、同じ file を保存し直しただけで wishboard が再 query する。
 * - VaultFileObserver は changed file をそのまま流すので、同一内容の再観測は通常運用で起きる
 *   (editor の保存、mtime だけの変化、rescan)。ここを applied にすると revision が観測回数の
 *   counter になり、`state_revision` と対の意味を持たなくなる。
 * - noop でも現在の revision を返すので、client は「変わっていない」と「読めていない」を区別できる。
 *
 * **裁定 (Slice C): `COMPONENTS.updated_at` を進めない。** projection が触るのは上の 4 列だけと
 * 決めた以上、Overview の cursor pagination key (`kind, status, updated_at, component_id`) を
 * 動かさない。結果として、title だけが変わった component は Overview の並び順で先頭へ来ない。
 * 並びを document 観測で動かすかは read model query 実装 (後続 slice) と一緒に決める。
 */
export function runDocumentObservation(
  store: SqliteWorkflowStore,
  observation: DocumentProjectionObservation,
): Result<DocumentProjectionResult> {
  const driver = store.driver;
  driver.exec("BEGIN IMMEDIATE");
  try {
    const current = readDocumentProjection(store, observation.component_id);
    if (current === undefined) {
      driver.exec("ROLLBACK");
      // 未登録 stable ID。**推測 merge しない。** row を作ると、ID なし draft が DB へ入る。
      return ok({
        component_id: observation.component_id,
        disposition: "not_found",
        reason: `component ${observation.component_id} が COMPONENTS に無い`,
      });
    }

    // **mind の観測で `children` が渡されたときだけ**所属の projection を差し替える。wish の
    // `children` は node link で、id 要素を持つのは mind だけ (`my-wish-data.md` の hierarchy 節)。
    // 未設定の観測は既存の行を残す。読めなかった観測で所属を消さない。
    const links = current.kind === "mind" && observation.children !== undefined
      ? mindWishRowsOf(observation.children)
      : undefined;
    const linksChanged = links !== undefined &&
      JSON.stringify(links) !==
        JSON.stringify(storedMindWishRows(store, observation.component_id));

    const unchanged = current.title_projection === observation.title &&
      current.document_locator === observation.locator &&
      current.document_observed_hash === observation.observed_hash && !linksChanged;
    if (unchanged) {
      driver.exec("ROLLBACK");
      return ok({
        component_id: observation.component_id,
        disposition: "noop",
        document_projection_revision: current.document_projection_revision,
      });
    }

    const nextRevision = current.document_projection_revision + 1;
    driver
      .prepare(
        "UPDATE components SET title_projection = ?, document_locator = ?," +
          " document_observed_hash = ?, document_projection_revision = ?" +
          " WHERE component_id = ?",
      )
      .run(
        observation.title,
        observation.locator,
        observation.observed_hash,
        nextRevision,
        observation.component_id,
      );
    if (links !== undefined && linksChanged) {
      driver.prepare("DELETE FROM mind_wish_links WHERE mind_component_id = ?")
        .run(observation.component_id);
      const insert = driver.prepare(
        "INSERT INTO mind_wish_links" +
          " (mind_component_id, child_value, element_kind, wish_component_id) VALUES (?, ?, ?, ?)",
      );
      for (const link of links) {
        insert.run(
          observation.component_id,
          link.child_value,
          link.element_kind,
          link.wish_component_id ?? null,
        );
      }
    }
    driver.exec("COMMIT");
    return ok({
      component_id: observation.component_id,
      disposition: "applied",
      document_projection_revision: nextRevision,
    });
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `document projection transaction が失敗した: ${String(cause)}`,
      "document_projection",
    );
  }
}

/** store を `DocumentProjectionPort` として見せる。 */
export function createSqliteDocumentProjectionPort(
  store: SqliteWorkflowStore,
): DocumentProjectionPort {
  return {
    observe(observation: DocumentProjectionObservation): Result<DocumentProjectionResult> {
      return runDocumentObservation(store, observation);
    },
  };
}

/** `resolve_locator` として DocumentPort へ渡す。projection の locator を正とする。 */
export function locatorResolverOf(
  store: SqliteWorkflowStore,
): (componentId: ComponentId) => string | undefined {
  return (componentId) => readDocumentProjection(store, componentId)?.document_locator;
}

/**
 * mind -> wish の所属 1 件の読み (artifact 0.13.0)。
 *
 * - `live`: id 要素で、指す component が COMPONENTS に kind=wish として在る。
 * - `broken`: **生きた所属として数えない。**`reason` が理由。Markdown から自動では消さない。
 *   - `malformed_id`: 要素の値が id の形でも node link でもない。
 *   - `wish_not_registered`: id の形だが COMPONENTS に無い (未登録 / 書き損じ)。
 *   - `not_a_wish`: id の component が wish ではない。
 * - `link`: 既存の `[[...]]` 要素 (後方互換)。**file を指すので Core は解決しない。**live とも
 *   broken とも数えない。
 *
 * document の在否 (wish の file が消えた) は SQLite だけでは分からないので、CLI が DocumentPort で
 * 足す (`document_missing`)。
 *
 * 2 層 DB (vault が repo の上) では、wish が下層 repo の DB に居ることがある。read-time resolver
 * (`cli/mind_wish_resolver.ts`) が vault の登録 repo を舐めて解決し、見つかった repo を
 * `resolved_repository_id` に載せる。登録 repo のうち到達できないものがあって居場所を
 * 確かめ切れない link は `repository_unreachable` の broken になる。
 */
export type MindWishLinkView = {
  readonly mind_component_id: string;
  readonly child_value: string;
  readonly wish_component_id?: string;
  /** cross-DB 解決で wish が見つかった repo。local 解決だけの行では未設定。 */
  readonly resolved_repository_id?: string;
  readonly state: "live" | "broken" | "link";
  readonly reason?:
    | "malformed_id"
    | "wish_not_registered"
    | "not_a_wish"
    | "document_missing"
    | "repository_unreachable";
};

/** mind か wish のどちらかで引く。**両方未指定は全件。**順序は (mind, 値)。 */
export function listMindWishLinks(
  store: SqliteWorkflowStore,
  filter: { readonly mind_component_id?: string; readonly wish_component_id?: string },
): readonly MindWishLinkView[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.mind_component_id !== undefined) {
    where.push("l.mind_component_id = ?");
    params.push(filter.mind_component_id);
  }
  if (filter.wish_component_id !== undefined) {
    where.push("l.wish_component_id = ?");
    params.push(filter.wish_component_id);
  }
  const rows = store.driver
    .prepare(
      "SELECT l.mind_component_id, l.child_value, l.element_kind, l.wish_component_id," +
        " c.kind AS target_kind FROM mind_wish_links l" +
        " LEFT JOIN components c ON c.component_id = l.wish_component_id" +
        (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`),
    )
    .all(...params);
  return rows.map((row): MindWishLinkView => {
    const mind = rowString(row, "mind_component_id") ?? "";
    const value = rowString(row, "child_value") ?? "";
    const kind = rowString(row, "element_kind");
    const wish = rowString(row, "wish_component_id");
    const targetKind = rowString(row, "target_kind");
    const base = { mind_component_id: mind, child_value: value };
    if (kind === "link") return { ...base, state: "link" };
    if (kind !== "id" || wish === undefined) {
      return { ...base, state: "broken", reason: "malformed_id" };
    }
    const withWish = { ...base, wish_component_id: wish };
    if (targetKind === undefined) {
      return { ...withWish, state: "broken", reason: "wish_not_registered" };
    }
    if (targetKind !== "wish") return { ...withWish, state: "broken", reason: "not_a_wish" };
    return { ...withWish, state: "live" };
  }).sort((left, right) =>
    left.mind_component_id === right.mind_component_id
      ? (left.child_value < right.child_value ? -1 : left.child_value > right.child_value ? 1 : 0)
      : left.mind_component_id < right.mind_component_id
      ? -1
      : 1
  );
}
