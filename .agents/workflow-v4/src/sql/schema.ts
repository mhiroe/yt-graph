// repo-local SQLite schema。initial minimum 10 table と、artifact 0.13.0 で足した document projection
// の table 1 つ (`mind_wish_links`) を `docs/candidate/workflow-v4/sqlite-er.mermaid` に合わせて持つ。
// table を増やす時は ER 図を先に直す。

/**
 * schema を変えたら上げる。既存 DB は version 不一致で開かず、migration を明示的に要求する。
 *
 * - `1`: Slice B の initial minimum 10 table。
 * - `2`: Slice D。`EVENT_INBOX.resolved_by_operation_id` の FK を外した (下の DDL comment)。
 * - `3`: artifact 0.13.0。mind -> wish の所属の projection `mind_wish_links` を足した。
 * - `4`: cutover readiness。適用済み migration の ledger `schema_migrations` を足した。
 * - `5`: Task に `dropped` status を足した (user 裁定 2026-09-22)。components の CHECK が
 *   変わるので migration では table を再構成する (`migrate.ts` の 4 -> 5 step)。
 * - `6`: iteration (`docs/candidate/workflow-v4/iterations.md`)。`iterations` /
 *   `current_iterations` / `iteration_components` / `iteration_members` /
 *   `iteration_doc_members` の 5 table と `components.birth_iteration` を足す。
 *   既存 row への backfill は無く、追加だけなので rebuild せず CREATE + ALTER。
 * - `7`: parallel active iterations (user 裁定 2026-09-23)。`current_iterations` を
 *   `active_iterations` (set + `is_default` partial unique) へ置き換え、
 *   `iterations.closed_at` を drop して `last_modified` を足す。`iterations` を
 *   再構成するので migration 6 -> 7 は `foreign_keys_off` で table rebuild。
 */
export const WORKFLOW_SCHEMA_VERSION = 7;

/** ER 図の initial minimum。順序は依存ではなく ER 図の並びに合わせる。 */
export const WORKFLOW_TABLE_NAMES = [
  "repository",
  "devices",
  "components",
  "component_relations",
  "operations",
  "activities",
  "domain_events",
  "event_outbox",
  "event_inbox",
  "replication_cursors",
  "mind_wish_links",
  "schema_migrations",
  "iterations",
  "active_iterations",
  "iteration_components",
  "iteration_members",
  "iteration_doc_members",
] as const;

export type WorkflowTableName = (typeof WORKFLOW_TABLE_NAMES)[number];

/**
 * 接続ごとに設定する PRAGMA。
 * `foreign_keys` は SQLite が既定で off なので、接続のたびに入れないと FK が効かない。
 */
export const CONNECTION_PRAGMAS = [
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const;

/**
 * file DB でだけ意味を持つ PRAGMA。`:memory:` では journal_mode が memory のままになるが、
 * error にはならないので分岐を持たない。
 */
export const DURABILITY_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
] as const;

const WISH_STATUS_LIST = "'registered_draft','plan','ready','pending','doing','done','dropped'";
const TASK_STATUS_LIST = "'plan','ready','doing','done','dropped'";

/**
 * `schema_migrations` の DDL (schema 4)。初期化 (`SCHEMA_STATEMENTS` item 12) と forward
 * migration (`migrate.ts` の 3 -> 4 step) が同じ文を共有する。片方だけ変えると、
 * migrate で上げた DB と fresh DB の形がずれる。
 */
export const SCHEMA_MIGRATIONS_TABLE_DDL = `CREATE TABLE schema_migrations (
  from_version INTEGER NOT NULL PRIMARY KEY,
  to_version   INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  applied_at   TEXT    NOT NULL
)`;

// ---------------------------------------------------------------------------
// iteration (schema 6、docs/candidate/workflow-v4/iterations.md)
//
// iteration は component aggregate ではなく DB row。dir 名は自由 label で
// display に過ぎず、順序の正本は seq、系譜は predecessor_iteration_id。
// `scope='project'` の行は component_path に空文字列を置く。NULL だと
// UNIQUE(scope, component_path, name) / (scope, component_path, seq) が
// NULL 同士を別物と見なして project scope の重複を素通りさせるので、
// NOT NULL + '' に倒す。
// ---------------------------------------------------------------------------

/**
 * `iterations` の DDL。初期化 (`SCHEMA_STATEMENTS`) と migration が同じ形を共有する。
 * 片方だけ変えると migrate で上げた DB と fresh DB の形がずれる。6 -> 7 は
 * `closed_at` drop + `last_modified` 追加の rebuild でこの関数を使う。
 */
export function iterationsTableDdl(name: string): string {
  return `CREATE TABLE ${name} (
  iteration_id             TEXT    NOT NULL PRIMARY KEY,
  scope                    TEXT    NOT NULL CHECK (scope IN ('project', 'component')),
  component_path           TEXT    NOT NULL DEFAULT '',
  name                     TEXT    NOT NULL,
  seq                      INTEGER NOT NULL,
  predecessor_iteration_id TEXT    REFERENCES iterations (iteration_id),
  created_at               TEXT    NOT NULL,
  last_modified            TEXT    NOT NULL,
  disposed_at              TEXT,
  CHECK ((scope = 'project' AND component_path = '')
     OR (scope = 'component' AND component_path <> '')),
  UNIQUE (scope, component_path, name),
  UNIQUE (scope, component_path, seq)
)`;
}

export const ITERATIONS_TABLE_DDL = iterationsTableDdl("iterations");

/**
 * migration 5 -> 6 が作る v6 形の frozen DDL。schema 7 で `closed_at` /
 * `current_iterations` は消えたが、v5 からの chain は 6 の形を経由するので
 * この step だけは旧形を建てる (`componentsTableDdl` が v5 形を残すのと同じ)。
 */
export const ITERATIONS_TABLE_DDL_V6 = `CREATE TABLE iterations (
  iteration_id             TEXT    NOT NULL PRIMARY KEY,
  scope                    TEXT    NOT NULL CHECK (scope IN ('project', 'component')),
  component_path           TEXT    NOT NULL DEFAULT '',
  name                     TEXT    NOT NULL,
  seq                      INTEGER NOT NULL,
  predecessor_iteration_id TEXT    REFERENCES iterations (iteration_id),
  created_at               TEXT    NOT NULL,
  closed_at                TEXT,
  disposed_at              TEXT,
  CHECK ((scope = 'project' AND component_path = '')
     OR (scope = 'component' AND component_path <> '')),
  UNIQUE (scope, component_path, name),
  UNIQUE (scope, component_path, seq)
)`;

export const CURRENT_ITERATIONS_TABLE_DDL = `CREATE TABLE current_iterations (
  scope          TEXT NOT NULL CHECK (scope IN ('project', 'component')),
  component_path TEXT NOT NULL DEFAULT '',
  iteration_id   TEXT NOT NULL REFERENCES iterations (iteration_id),
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (scope, component_path)
)`;

/**
 * active set (schema 7)。1 scope に複数の iteration が同時に active になり得る。
 * `is_default=1` は scope ごと最大 1 行 — partial unique index が DDL 側の保証で、
 * default 0 件は合法 (optional current)。leave は row の DELETE で、履歴は持たない。
 */
export const ACTIVE_ITERATIONS_TABLE_DDL = `CREATE TABLE active_iterations (
  scope          TEXT NOT NULL CHECK (scope IN ('project', 'component')),
  component_path TEXT NOT NULL DEFAULT '',
  iteration_id   TEXT NOT NULL REFERENCES iterations (iteration_id),
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  activated_at   TEXT NOT NULL,
  PRIMARY KEY (scope, component_path, iteration_id)
)`;

export const ACTIVE_ITERATIONS_ONE_DEFAULT_INDEX_DDL =
  `CREATE UNIQUE INDEX active_iterations_one_default
   ON active_iterations (scope, component_path) WHERE is_default = 1`;

export const ITERATION_COMPONENTS_TABLE_DDL = `CREATE TABLE iteration_components (
  project_iteration_id   TEXT NOT NULL REFERENCES iterations (iteration_id),
  component_iteration_id TEXT NOT NULL REFERENCES iterations (iteration_id),
  PRIMARY KEY (project_iteration_id, component_iteration_id)
)`;

export const ITERATION_MEMBERS_TABLE_DDL = `CREATE TABLE iteration_members (
  iteration_id TEXT NOT NULL REFERENCES iterations (iteration_id),
  component_id TEXT NOT NULL REFERENCES components (component_id),
  carried_at   TEXT NOT NULL,
  PRIMARY KEY (iteration_id, component_id)
)`;

export const ITERATION_DOC_MEMBERS_TABLE_DDL = `CREATE TABLE iteration_doc_members (
  iteration_id  TEXT NOT NULL REFERENCES iterations (iteration_id),
  document_path TEXT NOT NULL,
  carried_at    TEXT NOT NULL,
  PRIMARY KEY (iteration_id, document_path)
)`;

/**
 * `components.birth_iteration` の追加文。fresh 初期化 (`SCHEMA_STATEMENTS`) と
 * migration 5 -> 6 の両方が同じ 1 文を使う。`componentsTableDdl` へは入れない —
 * あちらは 4 -> 5 rebuild の v5 の形の正本のまま残す。
 */
export const COMPONENTS_BIRTH_ITERATION_ALTER =
  `ALTER TABLE components ADD COLUMN birth_iteration TEXT REFERENCES iterations (iteration_id)`;

/**
 * COMPONENTS の DDL。初期化と、`dropped` 追加で CHECK が変わった schema 5 への migration
 * (`migrate.ts` 4 -> 5 step が `components_v5` として建てる) の両方が同じ形を使う。
 * table 名だけ引数に取る。
 */
export function componentsTableDdl(name: string): string {
  return `CREATE TABLE ${name} (
     component_id                 TEXT    NOT NULL PRIMARY KEY,
     kind                         TEXT    NOT NULL CHECK (kind IN ('mind', 'wish', 'task')),
     title_projection             TEXT,
     status                       TEXT,
     state_revision               INTEGER NOT NULL CHECK (state_revision >= 0),
     document_projection_revision INTEGER NOT NULL DEFAULT 0
                                  CHECK (document_projection_revision >= 0),
     document_observed_hash       TEXT,
     document_locator             TEXT,
     created_at                   TEXT    NOT NULL,
     updated_at                   TEXT    NOT NULL,
     CHECK (
       (kind = 'mind' AND status IS NULL)
       OR (kind = 'wish' AND status IN (${WISH_STATUS_LIST}))
       OR (kind = 'task' AND status IN (${TASK_STATUS_LIST}))
     )
   )`;
}

/** components の overview index。migration で table を作り直す時も同じ文を使う。 */
export const COMPONENTS_OVERVIEW_INDEX_DDL =
  `CREATE INDEX components_overview ON components (kind, status, updated_at, component_id)`;

/**
 * DDL。`docs/candidate/workflow-v4/persistence.md` の "Persistence boundary" と ER 図の
 * constraint をそのまま持つ。
 *
 * ER 図との既知の差分が 2 つある。どちらも「論理的な参照であって local FK ではない」型。
 *
 * 1. `OPERATIONS.target_component_id` を FK にしていない。`not_found` は正当な disposition で
 *    あり、存在しない target への command も receipt として残す必要がある。FK を張ると、
 *    その記録自体が書けなくなる。
 * 2. **`EVENT_INBOX.resolved_by_operation_id` を FK にしていない (Slice D)。** conflict を
 *    解決した operation は **別 device で走る**。解決は committed event として届き、受信側の
 *    `OPERATIONS` にその row は無い。FK を張ると、届いた解決を記録できず remote 適用ごと
 *    失敗する (実測で FOREIGN KEY constraint failed)。receipt を作って埋めることもしない。
 *    走っていない operation の local receipt を捏造することになる。
 *
 * どちらも `docs/candidate/workflow-v4/persistence.md` と ER 図が同じ内容を持つ。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  // 1. REPOSITORY: DB が所有する唯一の repository identity。repo path は locator であり identity ではない。
  `CREATE TABLE repository (
     singleton      INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
     repository_id  TEXT    NOT NULL,
     schema_version INTEGER NOT NULL,
     created_at     TEXT    NOT NULL
   )`,

  // 2. DEVICES: local は最大 1 行。device_id は DB を作り直しても再利用しない。
  `CREATE TABLE devices (
     device_id           TEXT    NOT NULL PRIMARY KEY,
     local_flag          INTEGER NOT NULL CHECK (local_flag IN (0, 1)),
     next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1)
   )`,
  `CREATE UNIQUE INDEX devices_single_local
     ON devices (local_flag) WHERE local_flag = 1`,

  // 3. COMPONENTS: workflow state と document projection を同じ row に持ち、revision を分離する。
  componentsTableDdl("components"),
  COMPONENTS_OVERVIEW_INDEX_DDL,

  // 4. COMPONENT_RELATIONS: source は必ず local repo。target は同一 repo でも別 repo でもよい。
  `CREATE TABLE component_relations (
     from_component_id TEXT NOT NULL REFERENCES components (component_id),
     to_repository_id  TEXT NOT NULL,
     to_component_id   TEXT NOT NULL,
     relation_type     TEXT NOT NULL,
     created_at        TEXT NOT NULL,
     PRIMARY KEY (from_component_id, to_repository_id, to_component_id, relation_type)
   )`,
  `CREATE INDEX component_relations_from ON component_relations (from_component_id)`,
  `CREATE INDEX component_relations_to
     ON component_relations (to_repository_id, to_component_id)`,

  // 5. OPERATIONS: idempotency ledger。再送時に返す response をそのまま持つ。
  `CREATE TABLE operations (
     operation_id        TEXT    NOT NULL PRIMARY KEY,
     target_component_id TEXT,
     operation_type      TEXT    NOT NULL,
     expected_revision   INTEGER,
     actor_ref           TEXT    NOT NULL,
     source_device_id    TEXT    NOT NULL REFERENCES devices (device_id),
     correlation_id      TEXT,
     request_digest      TEXT    NOT NULL,
     payload_json        TEXT    NOT NULL,
     disposition         TEXT    CHECK (
                           disposition IN ('applied', 'noop', 'rejected', 'conflict', 'not_found')
                         ),
     result_component_id TEXT,
     response_json       TEXT,
     applied_revision    INTEGER,
     created_at          TEXT    NOT NULL,
     processed_at        TEXT
   )`,

  // 6. ACTIVITIES: component revision と causing operation / event を参照する履歴。
  `CREATE TABLE activities (
     activity_id          TEXT    NOT NULL PRIMARY KEY,
     component_id         TEXT    NOT NULL REFERENCES components (component_id),
     activity_type        TEXT    NOT NULL,
     actor_ref            TEXT    NOT NULL,
     correlation_id       TEXT,
     component_revision   INTEGER NOT NULL,
     causing_operation_id TEXT    REFERENCES operations (operation_id),
     causing_event_id     TEXT    REFERENCES domain_events (event_id),
     detail_json          TEXT,
     created_at           TEXT    NOT NULL
   )`,
  `CREATE INDEX activities_component_created ON activities (component_id, created_at)`,

  // 7. DOMAIN_EVENTS: immutable。source device ごとに sequence が一意。
  `CREATE TABLE domain_events (
     event_id               TEXT    NOT NULL PRIMARY KEY,
     causation_operation_id TEXT,
     aggregate_id           TEXT    NOT NULL REFERENCES components (component_id),
     event_type             TEXT    NOT NULL,
     base_revision          INTEGER NOT NULL,
     aggregate_revision     INTEGER NOT NULL,
     source_device_id       TEXT    NOT NULL REFERENCES devices (device_id),
     source_sequence        INTEGER NOT NULL,
     payload_json           TEXT    NOT NULL,
     committed_at           TEXT    NOT NULL,
     UNIQUE (source_device_id, source_sequence)
   )`,

  // 8. EVENT_OUTBOX: local event の publish 待ちだけを持つ。received event を入れない。
  `CREATE TABLE event_outbox (
     event_id          TEXT    NOT NULL PRIMARY KEY REFERENCES domain_events (event_id),
     publication_state TEXT    NOT NULL CHECK (
                         publication_state IN ('pending', 'publishing', 'published', 'failed')
                       ),
     attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
     last_attempt_at   TEXT,
     published_at      TEXT
   )`,
  `CREATE INDEX event_outbox_unpublished
     ON event_outbox (publication_state) WHERE publication_state != 'published'`,

  // 9. EVENT_INBOX: remote event の適用結果。conflict でも元 Journal 位置を残す。
  `CREATE TABLE event_inbox (
     event_id                 TEXT    NOT NULL PRIMARY KEY REFERENCES domain_events (event_id),
     source_device_id         TEXT    NOT NULL REFERENCES devices (device_id),
     source_sequence          INTEGER NOT NULL,
     disposition              TEXT    NOT NULL CHECK (
                                disposition IN ('received', 'applied', 'rejected', 'conflict')
                              ),
     journal_locator          TEXT,
     -- 論理参照。解決した operation は別 device で走るので FK にできない (上の comment 2)。
     resolved_by_operation_id TEXT,
     received_at              TEXT    NOT NULL,
     processed_at             TEXT,
     UNIQUE (source_device_id, source_sequence)
   )`,

  // 10. REPLICATION_CURSORS: Core 内部の device 別 cursor。wishboard へ公開しない。
  `CREATE TABLE replication_cursors (
     source_device_id                   TEXT    NOT NULL PRIMARY KEY
                                        REFERENCES devices (device_id),
     last_seen_sequence                 INTEGER NOT NULL DEFAULT 0,
     last_contiguous_processed_sequence INTEGER NOT NULL DEFAULT 0,
     updated_at                         TEXT    NOT NULL
   )`,

  // 11. MIND_WISH_LINKS (artifact 0.13.0): mind の `children` の要素の projection。
  //
  // **Markdown が正本で、ここは VaultFileObserver 由来の観測を写しただけ。**workflow state では
  // ないので `COMPONENT_RELATIONS` (command と DomainEvent が書く relation) と混ぜない。書くのは
  // document projection transaction だけで、**独立した write 口を持たない。**
  //
  // - 観測した要素の値をそのまま持つ。**生きているか (live / broken) は保存しない。**wish が後から
  //   登録されても mind を観測し直さずに live へ戻れるよう、読むときに COMPONENTS と突き合わせる。
  // - `wish_component_id` は値が vault 形の id のときだけ入る。**FK にしない。**指す wish が居ない
  //   (未登録 / 削除済み) 要素こそ broken として見せる対象で、FK を張ると記録できない。
  // - `element_kind`: `id` / `link` (既存の `[[...]]`、後方互換) / `malformed` (broken)。
  `CREATE TABLE mind_wish_links (
     mind_component_id TEXT NOT NULL REFERENCES components (component_id),
     child_value       TEXT NOT NULL,
     element_kind      TEXT NOT NULL CHECK (element_kind IN ('id', 'link', 'malformed')),
     wish_component_id TEXT,
     PRIMARY KEY (mind_component_id, child_value),
     CHECK ((element_kind = 'id') = (wish_component_id IS NOT NULL))
   )`,
  `CREATE INDEX mind_wish_links_wish ON mind_wish_links (wish_component_id)`,

  // 12. SCHEMA_MIGRATIONS (schema 4): 適用済み migration の ledger。workflow state ではなく
  // bookkeeping。fresh DB では空のままで、`migrate.ts` が step を適用するたびに 1 行書く。
  SCHEMA_MIGRATIONS_TABLE_DDL,

  // 13. iteration (schema 7)。`birth_iteration` の ALTER は参照先 `iterations` が在る
  // 必要があるので table 群の後に置く。migrate でも同じ文を SCHEMA_*_TABLE_DDL から使う。
  ITERATIONS_TABLE_DDL,
  ACTIVE_ITERATIONS_TABLE_DDL,
  ACTIVE_ITERATIONS_ONE_DEFAULT_INDEX_DDL,
  ITERATION_COMPONENTS_TABLE_DDL,
  ITERATION_MEMBERS_TABLE_DDL,
  ITERATION_DOC_MEMBERS_TABLE_DDL,
  COMPONENTS_BIRTH_ITERATION_ALTER,
];
