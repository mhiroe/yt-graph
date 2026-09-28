// Forward schema migration for the repo-local SQLite store.
//
// A DB whose `repository.schema_version` is older than `WORKFLOW_SCHEMA_VERSION` does not open
// as-is: `SqliteWorkflowStore.open` refuses it with `protocol_incompatible` unless the caller
// opts in (`migrate: true` / CLI `--migrate`). This module walks the contiguous chain of
// declared migrations from the stored version to the current one and applies every step inside
// ONE `BEGIN IMMEDIATE` / `COMMIT`, so a DB never lands in a half-migrated shape.
//
// `schema_migrations` is a real ledger: each applied step writes one row holding the versions,
// a name, and the injected clock time. A fresh DB gets an empty ledger — it records applied
// migrations, not the initial schema itself.
//
// There is no downward migration. A DB newer than this implementation stays refused.

import { err, ok, type Result } from "../result.ts";
import { rowInteger, type SqlDriver } from "./driver.ts";
import {
  ACTIVE_ITERATIONS_ONE_DEFAULT_INDEX_DDL,
  ACTIVE_ITERATIONS_TABLE_DDL,
  COMPONENTS_BIRTH_ITERATION_ALTER,
  COMPONENTS_OVERVIEW_INDEX_DDL,
  componentsTableDdl,
  CURRENT_ITERATIONS_TABLE_DDL,
  ITERATION_COMPONENTS_TABLE_DDL,
  ITERATION_DOC_MEMBERS_TABLE_DDL,
  ITERATION_MEMBERS_TABLE_DDL,
  ITERATIONS_TABLE_DDL_V6,
  iterationsTableDdl,
  SCHEMA_MIGRATIONS_TABLE_DDL,
  WORKFLOW_SCHEMA_VERSION,
} from "./schema.ts";

/**
 * One contiguous schema step. `to_version` of a step must equal `from_version` of the next;
 * a chain with a hole is not walked.
 *
 * `foreign_keys_off`: set when a step rebuilds a table that other tables reference (SQLite
 * cannot ALTER a CHECK; the standard rebuild is create-new / copy / drop / rename). The
 * PRAGMA is a no-op inside a transaction, so `migrateSchema` toggles it around the whole
 * chain and runs `PRAGMA foreign_key_check` before COMMIT.
 */
export type SchemaMigration = {
  readonly from_version: number;
  readonly to_version: number;
  readonly name: string;
  readonly statements: readonly string[];
  readonly foreign_keys_off?: boolean;
};

/**
 * Declared migrations, oldest first. The DDL of each step is shared with `SCHEMA_STATEMENTS`
 * so a migrated DB and a fresh DB end up in the same shape.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    from_version: 3,
    to_version: 4,
    name: "schema_migrations ledger",
    statements: [SCHEMA_MIGRATIONS_TABLE_DDL],
  },
  {
    // Task gains `dropped` (user ruling 2026-09-22). The components CHECK must change, and
    // SQLite cannot alter a constraint — rebuild the table. The new DDL comes from
    // `componentsTableDdl` so a migrated DB and a fresh DB cannot drift.
    from_version: 4,
    to_version: 5,
    name: "task dropped status",
    foreign_keys_off: true,
    statements: [
      componentsTableDdl("components_v5"),
      `INSERT INTO components_v5 (
         component_id, kind, title_projection, status, state_revision,
         document_projection_revision, document_observed_hash, document_locator,
         created_at, updated_at
       ) SELECT component_id, kind, title_projection, status, state_revision,
         document_projection_revision, document_observed_hash, document_locator,
         created_at, updated_at FROM components`,
      "DROP TABLE components",
      "ALTER TABLE components_v5 RENAME TO components",
      COMPONENTS_OVERVIEW_INDEX_DDL,
    ],
  },
  {
    // iteration (docs/candidate/workflow-v4/iterations.md)。追加だけで既存 row の
    // backfill は無いので rebuild しない: 5 table の CREATE + components への ADD COLUMN。
    // ALTER は参照先 iterations を先に作ってから実行する。
    from_version: 5,
    to_version: 6,
    name: "iteration tables",
    statements: [
      // v6 形の frozen DDL を使う。fresh 側の ITERATIONS_TABLE_DDL は v7 形なので
      // ここに使うと chain 途中で未宣言の形が生える。
      ITERATIONS_TABLE_DDL_V6,
      CURRENT_ITERATIONS_TABLE_DDL,
      ITERATION_COMPONENTS_TABLE_DDL,
      ITERATION_MEMBERS_TABLE_DDL,
      ITERATION_DOC_MEMBERS_TABLE_DDL,
      COMPONENTS_BIRTH_ITERATION_ALTER,
    ],
  },
  {
    // parallel active iterations (user 裁定 2026-09-23)。`current_iterations` の
    // 各行を default 入りの active set row へ移し、pointer table を drop。
    // `iterations` は `closed_at` drop + `last_modified` 追加 (created_at で
    // backfill) の rebuild — 参照元 table が多いので foreign_keys_off で行う。
    from_version: 6,
    to_version: 7,
    name: "parallel active iterations",
    foreign_keys_off: true,
    statements: [
      ACTIVE_ITERATIONS_TABLE_DDL,
      ACTIVE_ITERATIONS_ONE_DEFAULT_INDEX_DDL,
      `INSERT INTO active_iterations (scope, component_path, iteration_id, is_default, activated_at)
         SELECT c.scope, c.component_path, c.iteration_id, 1, i.created_at
         FROM current_iterations c JOIN iterations i ON i.iteration_id = c.iteration_id`,
      "DROP TABLE current_iterations",
      iterationsTableDdl("iterations_v7"),
      `INSERT INTO iterations_v7 (iteration_id, scope, component_path, name, seq,
         predecessor_iteration_id, created_at, last_modified, disposed_at)
         SELECT iteration_id, scope, component_path, name, seq,
         predecessor_iteration_id, created_at, created_at, disposed_at FROM iterations`,
      "DROP TABLE iterations",
      "ALTER TABLE iterations_v7 RENAME TO iterations",
    ],
  },
];

/** One applied step, returned in apply order. */
export type AppliedMigration = {
  readonly from_version: number;
  readonly to_version: number;
};

/**
 * Migrate `repository.schema_version` forward to `WORKFLOW_SCHEMA_VERSION`.
 *
 * The whole chain is planned before anything is written: a missing link fails with
 * `protocol_incompatible` describing the gap, and no step is silently skipped. On any
 * exception the transaction is rolled back so the DB keeps its old version.
 */
export function migrateSchema(
  driver: SqlDriver,
  clock: () => string,
): Result<readonly AppliedMigration[]> {
  const row = driver
    .prepare("SELECT schema_version FROM repository WHERE singleton = 1")
    .get();
  if (row === undefined) {
    return err("missing_field", "repository metadata の row が無い", "repository");
  }
  const start = rowInteger(row, "schema_version");
  if (start === undefined) {
    return err(
      "protocol_incompatible",
      "repository.schema_version を整数として読めない",
      "schema_version",
    );
  }
  if (start > WORKFLOW_SCHEMA_VERSION) {
    return err(
      "protocol_incompatible",
      `schema_version ${start} は実装の ${WORKFLOW_SCHEMA_VERSION} より新しい。` +
        "downward migration は無い",
      "schema_version",
    );
  }

  // Plan first: a gap in the chain must fail before a single statement runs.
  const plan: SchemaMigration[] = [];
  let current = start;
  while (current < WORKFLOW_SCHEMA_VERSION) {
    const step = SCHEMA_MIGRATIONS.find((entry) => entry.from_version === current);
    if (step === undefined) {
      return err(
        "protocol_incompatible",
        `schema_version ${current} から ${WORKFLOW_SCHEMA_VERSION} への migration が無い。` +
          "chain が繋がっていない",
        "schema_version",
      );
    }
    plan.push(step);
    current = step.to_version;
  }
  if (plan.length === 0) return ok([]);

  // A step that rebuilds a referenced table needs foreign_keys off, and the pragma is a
  // no-op inside a transaction — toggle it around the whole chain, not per statement.
  const foreignKeysOff = plan.some((step) => step.foreign_keys_off === true);
  if (foreignKeysOff) driver.exec("PRAGMA foreign_keys = OFF");

  const applied: AppliedMigration[] = [];
  driver.exec("BEGIN IMMEDIATE");
  try {
    for (const step of plan) {
      for (const statement of step.statements) driver.exec(statement);
      driver
        .prepare(
          "INSERT INTO schema_migrations (from_version, to_version, name, applied_at)" +
            " VALUES (?, ?, ?, ?)",
        )
        .run(step.from_version, step.to_version, step.name, clock());
      driver
        .prepare("UPDATE repository SET schema_version = ? WHERE singleton = 1")
        .run(step.to_version);
      applied.push({ from_version: step.from_version, to_version: step.to_version });
    }
    if (foreignKeysOff) {
      // A rebuild that orphans rows must not commit. The check runs inside the tx so a
      // violation still rolls everything back.
      const violations = driver.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`foreign_key_check が ${violations.length} 件の違反を報告`);
      }
    }
    driver.exec("COMMIT");
    if (foreignKeysOff) driver.exec("PRAGMA foreign_keys = ON");
    return ok(applied);
  } catch (cause) {
    driver.exec("ROLLBACK");
    if (foreignKeysOff) driver.exec("PRAGMA foreign_keys = ON");
    return err(
      "protocol_incompatible",
      `schema migration (${start} -> ${WORKFLOW_SCHEMA_VERSION}) が失敗した: ${String(cause)}`,
      "schema_version",
    );
  }
}
