// iteration (schema 7) の SQLite 実装。
//
// `src/iterations.ts` が pure contract (label / path 規則 / lookup の型) で、
// ここは driver への読み書き。iteration は component aggregate ではないので
// `components.state_revision` を進めず、domain_events / outbox も書かない
// (この cut では replication 対象外)。

import { err, ok, type Result } from "../result.ts";
import type { ComponentId } from "../ids.ts";
import {
  INIT_ITERATION_LABEL,
  iterationContainingPath,
  type IterationInfo,
  type IterationInitPlan,
  type IterationLookup,
  type IterationRebuildPlan,
  type IterationScope,
  type IterationTreeFailure,
  type RebuiltIteration,
} from "../iterations.ts";
import type { Command } from "../commands.ts";
import type { IterationEffect } from "../decide.ts";
import { rowInteger, rowString, type SqlDriver } from "./driver.ts";

/** row -> IterationInfo。読めない行は黙って落とさず throw する (store.outgoingRelations と同じ)。 */
function toIterationInfo(row: Record<string, unknown>): IterationInfo {
  const scope = rowString(row, "scope");
  if (scope !== "project" && scope !== "component") {
    throw new Error(`iterations.scope を parse できない: ${JSON.stringify(row)}`);
  }
  const componentPath = rowString(row, "component_path") ?? "";
  const iterationId = rowString(row, "iteration_id");
  const name = rowString(row, "name");
  const seq = rowInteger(row, "seq");
  const createdAt = rowString(row, "created_at");
  if (
    iterationId === undefined || name === undefined || seq === undefined ||
    createdAt === undefined
  ) {
    throw new Error(`iterations の row を parse できない: ${JSON.stringify(row)}`);
  }
  const optional = (field: string): { [key: string]: string } => {
    const value = rowString(row, field);
    return value === undefined ? {} : { [field]: value };
  };
  const lastModified = rowString(row, "last_modified");
  if (lastModified === undefined) {
    throw new Error(`iterations.last_modified を parse できない: ${JSON.stringify(row)}`);
  }
  return {
    iteration_id: iterationId,
    scope: scope as IterationScope,
    component_path: componentPath,
    name,
    seq,
    ...optional("predecessor_iteration_id"),
    created_at: createdAt,
    last_modified: lastModified,
    ...optional("disposed_at"),
  };
}

/** scope 内の iteration を seq 順で返す。**label / created_at では並べない。** */
export function listIterations(
  driver: SqlDriver,
  scope: IterationScope,
  componentPath: string,
): IterationInfo[] {
  return driver
    .prepare(
      "SELECT iteration_id, scope, component_path, name, seq, predecessor_iteration_id," +
        " created_at, last_modified, disposed_at FROM iterations" +
        " WHERE scope = ? AND component_path = ? ORDER BY seq",
    )
    .all(scope, componentPath)
    .map(toIterationInfo);
}

/** 全 iteration。`iteration.repair` と locator 解決が使う。 */
export function listAllIterations(driver: SqlDriver): IterationInfo[] {
  return driver
    .prepare(
      "SELECT iteration_id, scope, component_path, name, seq, predecessor_iteration_id," +
        " created_at, last_modified, disposed_at FROM iterations ORDER BY scope, component_path, seq",
    )
    .all()
    .map(toIterationInfo);
}

export function iterationById(driver: SqlDriver, iterationId: string): IterationInfo | undefined {
  const row = driver
    .prepare(
      "SELECT iteration_id, scope, component_path, name, seq, predecessor_iteration_id," +
        " created_at, last_modified, disposed_at FROM iterations WHERE iteration_id = ?",
    )
    .get(iterationId);
  return row === undefined ? undefined : toIterationInfo(row);
}

/** scope の active set を seq 順で返す (schema 7)。0 件でも合法。 */
export function activeIterationsOf(
  driver: SqlDriver,
  scope: IterationScope,
  componentPath: string,
): IterationInfo[] {
  return driver
    .prepare(
      "SELECT i.iteration_id, i.scope, i.component_path, i.name, i.seq," +
        " i.predecessor_iteration_id, i.created_at, i.last_modified, i.disposed_at" +
        " FROM active_iterations a JOIN iterations i ON i.iteration_id = a.iteration_id" +
        " WHERE a.scope = ? AND a.component_path = ? ORDER BY i.seq",
    )
    .all(scope, componentPath)
    .map(toIterationInfo);
}

/**
 * scope の default iteration (optional current)。`active_iterations.is_default=1`
 * が正本で、`current` symlink は派生。default が無い scope では undefined — 呼び出し側は
 * 「iteration を明示するか fail する」分岐を持つ必要がある (auto-pick しない裁定)。
 */
export function defaultIterationOf(
  driver: SqlDriver,
  scope: IterationScope,
  componentPath: string,
): IterationInfo | undefined {
  const row = driver
    .prepare(
      "SELECT iteration_id FROM active_iterations" +
        " WHERE scope = ? AND component_path = ? AND is_default = 1",
    )
    .get(scope, componentPath);
  const id = row === undefined ? undefined : rowString(row, "iteration_id");
  return id === undefined ? undefined : iterationById(driver, id);
}

export function iterationMembersOf(driver: SqlDriver, iterationId: string): ComponentId[] {
  return driver
    .prepare(
      "SELECT component_id FROM iteration_members WHERE iteration_id = ? ORDER BY component_id",
    )
    .all(iterationId)
    .map((row) => (rowString(row, "component_id") ?? "") as ComponentId);
}

export function iterationDocMembersOf(driver: SqlDriver, iterationId: string): string[] {
  return driver
    .prepare(
      "SELECT document_path FROM iteration_doc_members WHERE iteration_id = ? ORDER BY document_path",
    )
    .all(iterationId)
    .map((row) => rowString(row, "document_path") ?? "");
}

/** component が member として入っている iteration (scope 絞り込み可)。 */
export function membershipsOfComponent(
  driver: SqlDriver,
  componentId: string,
): IterationInfo[] {
  return driver
    .prepare(
      "SELECT i.iteration_id, i.scope, i.component_path, i.name, i.seq," +
        " i.predecessor_iteration_id, i.created_at, i.last_modified, i.disposed_at" +
        " FROM iteration_members m JOIN iterations i ON i.iteration_id = m.iteration_id" +
        " WHERE m.component_id = ? ORDER BY i.seq",
    )
    .all(componentId)
    .map(toIterationInfo);
}

/** doc member (path-keyed) が入っている iteration。 */
export function membershipsOfDocument(driver: SqlDriver, documentPath: string): IterationInfo[] {
  return driver
    .prepare(
      "SELECT i.iteration_id, i.scope, i.component_path, i.name, i.seq," +
        " i.predecessor_iteration_id, i.created_at, i.last_modified, i.disposed_at" +
        " FROM iteration_doc_members d JOIN iterations i ON i.iteration_id = d.iteration_id" +
        " WHERE d.document_path = ? ORDER BY i.seq",
    )
    .all(documentPath)
    .map(toIterationInfo);
}

/** component の birth iteration (components.birth_iteration)。 */
export function birthIterationOf(
  driver: SqlDriver,
  componentId: string,
): IterationInfo | undefined {
  const row = driver
    .prepare("SELECT birth_iteration FROM components WHERE component_id = ?")
    .get(componentId);
  const id = row === undefined ? undefined : rowString(row, "birth_iteration");
  return id === undefined ? undefined : iterationById(driver, id);
}

/**
 * component の effective iteration。frontmatter の generated key が写す値。
 *
 * **file の置き場が scope を決める。**birth dir 内の file はその component scope、
 * それ以外 (vault root 等) は project scope。scope 内では birth と membership のうち
 * `seq` が最大のものを「今の世代」とする — 順序の正本は seq であり label / 時計ではない。
 */
export function effectiveIterationOf(
  driver: SqlDriver,
  componentId: string,
  documentPath: string | undefined,
): IterationInfo | undefined {
  const all = listAllIterations(driver);
  const birth = birthIterationOf(driver, componentId);
  const memberships = membershipsOfComponent(driver, componentId);
  const located = documentPath === undefined
    ? undefined
    : iterationContainingPath(documentPath, all);
  const scope = located === undefined
    ? { scope: "project" as const, component_path: "" }
    : { scope: located.scope, component_path: located.component_path };
  const candidates = [birth, ...memberships]
    .filter((it): it is IterationInfo =>
      it !== undefined && it.scope === scope.scope && it.component_path === scope.component_path
    );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (a.seq >= b.seq ? a : b));
}

/** doc member (path-keyed) の effective iteration。同じ規則を path だけで評価する。 */
export function effectiveIterationOfPath(
  driver: SqlDriver,
  documentPath: string,
): IterationInfo | undefined {
  const all = listAllIterations(driver);
  const located = iterationContainingPath(documentPath, all);
  const scope = located === undefined
    ? { scope: "project" as const, component_path: "" }
    : { scope: located.scope, component_path: located.component_path };
  const memberships = membershipsOfDocument(driver, documentPath)
    .filter((it) => it.scope === scope.scope && it.component_path === scope.component_path);
  if (memberships.length === 0) return undefined;
  return memberships.reduce((a, b) => (a.seq >= b.seq ? a : b));
}

/**
 * locator から birth iteration を引く。`<dir>/{docs|spec|app}/` の形だけを認める
 * (`iterationContainingPath`)。iteration dir の外に生まれた node は NULL のまま —
 * pre-iteration の document を拒否しない裁定と同じ。
 */
export function iterationForDocumentPath(
  driver: SqlDriver,
  path: string,
): IterationInfo | undefined {
  return iterationContainingPath(path, listAllIterations(driver));
}

/** decide が読む lookup を driver に束ねる。 */
export function iterationLookupOf(driver: SqlDriver): IterationLookup {
  return {
    byId: (iterationId) => iterationById(driver, iterationId),
    byName: (scope, componentPath, name) => {
      const row = driver
        .prepare(
          "SELECT iteration_id, scope, component_path, name, seq, predecessor_iteration_id," +
            " created_at, last_modified, disposed_at FROM iterations" +
            " WHERE scope = ? AND component_path = ? AND name = ?",
        )
        .get(scope, componentPath, name);
      return row === undefined ? undefined : toIterationInfo(row);
    },
    defaultIteration: (scope, componentPath) => defaultIterationOf(driver, scope, componentPath),
    activeIterations: (scope, componentPath) => activeIterationsOf(driver, scope, componentPath),
    containing: (path) => iterationContainingPath(path, listAllIterations(driver)),
    nextSeq: (scope, componentPath) => {
      const row = driver
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM iterations" +
            " WHERE scope = ? AND component_path = ?",
        )
        .get(scope, componentPath);
      return rowInteger(row ?? {}, "next") ?? 1;
    },
    members: (iterationId) => ({
      components: iterationMembersOf(driver, iterationId),
      documents: iterationDocMembersOf(driver, iterationId),
    }),
  };
}

/**
 * decide が返した `iteration_effect` を DB へ書く。
 *
 * `runLocalCommand` の transaction の中で呼ばれる前提。`domain_events` /
 * `event_outbox` は**絶対に触らない** — iteration op はこの cut では replicate しない。
 */
export function applyIterationEffect(
  driver: SqlDriver,
  command: Command,
  effect: IterationEffect,
  now: string,
): Result<undefined> {
  /** `last_modified` の touch (user 裁定: iteration を Core 経由で触った op が stamp する)。 */
  const touch = (iterationId: string): void => {
    driver
      .prepare("UPDATE iterations SET last_modified = ? WHERE iteration_id = ?")
      .run(now, iterationId);
  };
  const insertActive = (it: IterationInfo, isDefault: 0 | 1): void => {
    driver
      .prepare(
        "INSERT INTO active_iterations (scope, component_path, iteration_id, is_default, activated_at)" +
          " VALUES (?, ?, ?, ?, ?)",
      )
      .run(it.scope, it.component_path, it.iteration_id, isDefault, now);
  };
  /** scope の default flag を全部下ろしてから target へ立てる (partial unique index)。 */
  const setDefault = (it: IterationInfo): void => {
    driver
      .prepare(
        "UPDATE active_iterations SET is_default = 0" +
          " WHERE scope = ? AND component_path = ? AND is_default = 1",
      )
      .run(it.scope, it.component_path);
    driver
      .prepare(
        "UPDATE active_iterations SET is_default = 1" +
          " WHERE scope = ? AND component_path = ? AND iteration_id = ?",
      )
      .run(it.scope, it.component_path, it.iteration_id);
  };
  switch (effect.kind) {
    case "open": {
      const it = effect.iteration;
      driver
        .prepare(
          "INSERT INTO iterations (iteration_id, scope, component_path, name, seq," +
            " predecessor_iteration_id, created_at, last_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          it.iteration_id,
          it.scope,
          it.component_path,
          it.name,
          it.seq,
          it.predecessor_iteration_id ?? null,
          it.created_at,
          it.last_modified,
        );
      // schema 7: predecessor は lineage 記録だけ。close も deactivate もしない。
      return ok(undefined);
    }
    case "activate": {
      const it = effect.iteration;
      insertActive(it, 0);
      touch(it.iteration_id);
      return ok(undefined);
    }
    case "deactivate": {
      const it = effect.iteration;
      driver
        .prepare(
          "DELETE FROM active_iterations" +
            " WHERE scope = ? AND component_path = ? AND iteration_id = ?",
        )
        .run(it.scope, it.component_path, it.iteration_id);
      touch(it.iteration_id);
      // `next_default` が在れば同じ transaction で引き継ぐ。無ければ scope は
      // default なしの状態に残る (current は optional — user 裁定)。
      if (effect.next_default !== undefined) {
        setDefault(effect.next_default);
        touch(effect.next_default.iteration_id);
      }
      return ok(undefined);
    }
    case "set_default": {
      setDefault(effect.iteration);
      touch(effect.iteration.iteration_id);
      if (effect.previous_default !== undefined) {
        touch(effect.previous_default.iteration_id);
      }
      return ok(undefined);
    }
    case "switch":
    case "carry": {
      const it = effect.iteration;
      if (effect.kind === "switch") {
        // composite: activate (member でなければ) + set_default。
        const already = driver
          .prepare(
            "SELECT 1 AS x FROM active_iterations" +
              " WHERE scope = ? AND component_path = ? AND iteration_id = ?",
          )
          .get(it.scope, it.component_path, it.iteration_id);
        if (already === undefined) {
          insertActive(it, 0);
        }
        setDefault(it);
        touch(it.iteration_id);
        if (effect.previous_default !== undefined) {
          touch(effect.previous_default.iteration_id);
        }
      }
      const memberInsert = driver.prepare(
        "INSERT OR IGNORE INTO iteration_members (iteration_id, component_id, carried_at)" +
          " VALUES (?, ?, ?)",
      );
      const docInsert = driver.prepare(
        "INSERT OR IGNORE INTO iteration_doc_members (iteration_id, document_path, carried_at)" +
          " VALUES (?, ?, ?)",
      );
      const activityInsert = driver.prepare(
        "INSERT INTO activities (activity_id, component_id, activity_type, actor_ref," +
          " correlation_id, component_revision, causing_operation_id, detail_json, created_at)" +
          " VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
      );
      for (const componentId of effect.carried_components) {
        memberInsert.run(it.iteration_id, componentId, now);
        // carry は component の revision を進めないが、「どの iteration へ入ったか」は
        // activity として残す (裁定: switch は carried wish に activity を記録する)。
        const component = driver
          .prepare("SELECT state_revision FROM components WHERE component_id = ?")
          .get(componentId);
        activityInsert.run(
          `act-${command.operation_id}-${componentId}`,
          componentId,
          command.operation,
          command.actor_ref,
          rowInteger(component ?? {}, "state_revision") ?? 0,
          command.operation_id,
          JSON.stringify({ iteration_id: it.iteration_id }),
          now,
        );
      }
      for (const path of effect.carried_documents) {
        docInsert.run(it.iteration_id, path, now);
      }
      if (effect.kind === "carry") {
        touch(it.iteration_id);
      }
      return ok(undefined);
    }
    case "dispose": {
      driver
        .prepare("UPDATE iterations SET disposed_at = ?, last_modified = ? WHERE iteration_id = ?")
        .run(now, now, effect.iteration.iteration_id);
      return ok(undefined);
    }
    default:
      return err("invalid_field_type", "未知の iteration_effect", "iteration_effect");
  }
}

/**
 * 登録済み component の canonical document path -> component_id の index。
 * tree -> DB rebuild が member link の target を component / doc に振り分けるのに使う。
 * locator の `#` fragment は落とす (file 単位の所属)。
 */
export function componentDocumentPaths(driver: SqlDriver): Map<string, string> {
  const rows = driver
    .prepare(
      "SELECT component_id, document_locator FROM components WHERE document_locator IS NOT NULL",
    )
    .all();
  const map = new Map<string, string>();
  for (const row of rows) {
    const locator = rowString(row, "document_locator");
    const componentId = rowString(row, "component_id");
    if (locator === undefined || componentId === undefined) continue;
    map.set(locator.split("#", 1)[0] ?? locator, componentId);
  }
  return map;
}

export type RebuildApplyResult = {
  iterations: number;
  members: number;
  doc_members: number;
  actives: number;
  births: number;
  warnings: string[];
};

export type RebuildApplyOutcome =
  | { readonly ok: true; readonly applied: RebuildApplyResult }
  | { readonly ok: false; readonly failures: IterationTreeFailure[] };

/**
 * tree -> DB rebuild plan を既存 DB と reconcile して書き込む。
 *
 * - **既存 row は決して reorder しない。**同じ (scope, component_path, name) の
 *   row が在れば seq が一致するかだけを検査し、食い違えば何も書かずに fail closed
 *   (offending path を返す)。`created_at` の食い違いは DB 側を正として warning。
 * - 新しい row の `iteration_id` は (scope, component_path, name) からの決定的
 *   hash — repair は command を経由しないので operation_id 採番は使えない。
 * - `last_modified` (新規 row は `created_at` で backfill) / `disposed_at` /
 *   `predecessor_iteration_id` は tree に記録が無いので NULL / backfill 以外は
 *   invent しない。
 * - membership は INSERT OR IGNORE — 既存 row は消さない・増やすだけ。
 * - active set は tree の `active/` link が正 — plan が `active=true` と読んだものを
 *   row へ足す。`is_default` は `current` link を持つものだけ (optional default)。
 * - 全部 1 transaction。検査は BEGIN の前に畳む。
 */
export function applyIterationRebuild(
  driver: SqlDriver,
  plan: IterationRebuildPlan,
  now: string,
): RebuildApplyOutcome {
  const failures: IterationTreeFailure[] = [];
  const warnings: string[] = [];
  const paths = componentDocumentPaths(driver);

  // reconcile: 既存 row との衝突を書き込み前に全部洗う。
  const pending: { iteration: RebuiltIteration; existing: IterationInfo | undefined }[] = [];
  for (const iteration of plan.iterations) {
    const existing = iterationLookupOf(driver)
      .byName(iteration.scope, iteration.component_path, iteration.name);
    if (existing !== undefined && existing.seq !== iteration.seq) {
      failures.push({
        path: iteration.dir,
        reason:
          `既存 row (seq ${existing.seq}) と tree の記録 (seq ${iteration.seq}) が衝突 — reorder しないので fail closed`,
      });
      continue;
    }
    if (
      existing !== undefined && existing.created_at !== iteration.created_at
    ) {
      warnings.push(
        `${iteration.dir}: created_at が DB (${existing.created_at}) と tree (${iteration.created_at}) で食い違う — DB を正とする`,
      );
    }
    // tree の seq が scope 内の別名 row と衝突するかも確かめる。
    const seqClash = listIterations(driver, iteration.scope, iteration.component_path)
      .find((row) => row.seq === iteration.seq && row.name !== iteration.name);
    if (seqClash !== undefined) {
      failures.push({
        path: iteration.dir,
        reason:
          `tree の seq ${iteration.seq} が既存 row ${seqClash.name} と衝突する — reorder しないので fail closed`,
      });
      continue;
    }
    pending.push({ iteration, existing });
  }
  if (failures.length > 0) return { ok: false, failures };

  const applied: RebuildApplyResult = {
    iterations: 0,
    members: 0,
    doc_members: 0,
    actives: 0,
    births: 0,
    warnings,
  };

  driver.exec("BEGIN IMMEDIATE");
  try {
    const insertIteration = driver.prepare(
      "INSERT INTO iterations (iteration_id, scope, component_path, name, seq," +
        " predecessor_iteration_id, created_at, last_modified) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    );
    const memberInsert = driver.prepare(
      "INSERT OR IGNORE INTO iteration_members (iteration_id, component_id, carried_at) VALUES (?, ?, ?)",
    );
    const memberCheck = driver.prepare(
      "SELECT 1 AS x FROM iteration_members WHERE iteration_id = ? AND component_id = ?",
    );
    const docInsert = driver.prepare(
      "INSERT OR IGNORE INTO iteration_doc_members (iteration_id, document_path, carried_at) VALUES (?, ?, ?)",
    );
    const docCheck = driver.prepare(
      "SELECT 1 AS x FROM iteration_doc_members WHERE iteration_id = ? AND document_path = ?",
    );
    const birthUpdate = driver.prepare(
      "UPDATE components SET birth_iteration = ? WHERE component_id = ? AND birth_iteration IS NULL",
    );
    const birthCheck = driver.prepare(
      "SELECT birth_iteration FROM components WHERE component_id = ?",
    );
    const activeCheck = driver.prepare(
      "SELECT is_default FROM active_iterations" +
        " WHERE scope = ? AND component_path = ? AND iteration_id = ?",
    );
    const activeInsert = driver.prepare(
      "INSERT INTO active_iterations (scope, component_path, iteration_id, is_default, activated_at)" +
        " VALUES (?, ?, ?, ?, ?)",
    );
    const activeDefault = driver.prepare(
      "UPDATE active_iterations SET is_default = ?" +
        " WHERE scope = ? AND component_path = ? AND iteration_id = ?",
    );

    for (const { iteration, existing } of pending) {
      const iterationId = existing?.iteration_id ?? rebuildIterationId(iteration);
      if (existing === undefined) {
        // tree に記録の無い `last_modified` は `created_at` で backfill (migration と同じ)。
        insertIteration.run(
          iterationId,
          iteration.scope,
          iteration.component_path,
          iteration.name,
          iteration.seq,
          iteration.created_at,
          iteration.created_at,
        );
        applied.iterations += 1;
      }
      for (const path of iteration.member_paths) {
        const componentId = paths.get(path);
        if (componentId === undefined) {
          // INSERT OR IGNORE でも attempts を数えると 2 回目の repair が noop に
          // ならないので、実際に row が増える時だけ count する。
          if (docCheck.get(iterationId, path) === undefined) {
            docInsert.run(iterationId, path, now);
            applied.doc_members += 1;
          }
          continue;
        }
        if (memberCheck.get(iterationId, componentId) === undefined) {
          memberInsert.run(iterationId, componentId, now);
          applied.members += 1;
        }
        // canonical path がこの iteration dir の中なら birth_iteration を復元する。
        // `init` は dir を持たないので member になった component 全件が birth の
        // 記録 (stamp が scope の init を名乗る)。既に別の値が入っている場合は
        // 既存を正として warning に留める。
        if (iteration.is_init === true || path.startsWith(`${iteration.dir}/`)) {
          const birth = birthCheck.get(componentId);
          const birthValue = birth === undefined ? undefined : rowString(birth, "birth_iteration");
          // NULL と SQL NULL の区別: row が無い (component 未登録) のは upstream で
          // 既に弾いているのでここでは IS NULL 判定だけ見る。
          if (birth !== undefined && birthValue === undefined) {
            birthUpdate.run(iterationId, componentId);
            applied.births += 1;
          } else if (birth !== undefined && birthValue !== iterationId) {
            warnings.push(
              `${path}: birth_iteration が既存 (${birthValue}) と tree (${iterationId}) で食い違う — 既存を正とする`,
            );
          }
        }
      }
      if (iteration.active) {
        const existingActive = activeCheck.get(
          iteration.scope,
          iteration.component_path,
          iterationId,
        );
        if (existingActive === undefined) {
          activeInsert.run(
            iteration.scope,
            iteration.component_path,
            iterationId,
            iteration.is_default ? 1 : 0,
            iteration.created_at,
          );
          applied.actives += 1;
        } else {
          const wasDefault = rowInteger(existingActive, "is_default") === 1;
          if (iteration.is_default !== wasDefault) {
            // tree の current link が正。DB 側の flag を link に合わせる。
            // 既存 default を別の iteration が握っている場合、先にそれを下ろす
            // (partial unique index)。
            if (iteration.is_default) {
              driver
                .prepare(
                  "UPDATE active_iterations SET is_default = 0" +
                    " WHERE scope = ? AND component_path = ? AND is_default = 1" +
                    " AND iteration_id <> ?",
                )
                .run(iteration.scope, iteration.component_path, iterationId);
            }
            activeDefault.run(
              iteration.is_default ? 1 : 0,
              iteration.scope,
              iteration.component_path,
              iterationId,
            );
            warnings.push(
              `${iteration.dir}: default flag を DB から committed current link (${iteration.name}) へ合わせた`,
            );
          }
        }
      }
    }
    driver.exec("COMMIT");
  } catch (cause) {
    driver.exec("ROLLBACK");
    throw cause;
  }
  return { ok: true, applied };
}

/** `it-rebuild-<hash>` — (scope, component_path, name) からの決定的採番。 */
function rebuildIterationId(
  iteration: Pick<RebuiltIteration, "scope" | "component_path" | "name">,
): string {
  const key = `${iteration.scope}${iteration.component_path}${iteration.name}`;
  // FNV-1a 32bit — crypto 不要、決定的であればよい。
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `it-rebuild-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * `component.register` 系の created row へ birth iteration を写し、membership を足す。
 *
 * **iteration dir の外に生まれた node は何も書かない** — pre-iteration の document を
 * 拒否しない裁定と同じ。
 *
 * membership の行き先 (schema 7 の optional current):
 * - `explicitIterationId` が在ればそれ (decide が scope 一致と未 dispose を検査済み)。
 * - 無ければ scope の default。
 * - default が無ければ membership を付けない — active set が非空の場合は decide が
 *   先に fail closed しているので、ここに来る時点で「active 0 件」だけが残る。
 */
export function stampBirthIteration(
  driver: SqlDriver,
  componentId: ComponentId,
  locator: string | null,
  now: string,
  explicitIterationId?: string,
): void {
  const located = locator === null ? undefined : iterationForDocumentPath(driver, locator);
  if (located !== undefined) {
    driver
      .prepare("UPDATE components SET birth_iteration = ? WHERE component_id = ?")
      .run(located.iteration_id, componentId);
  }
  const scope = located === undefined
    ? { scope: "project" as const, component_path: "" }
    : { scope: located.scope, component_path: located.component_path };
  const explicit = explicitIterationId === undefined
    ? undefined
    : iterationById(driver, explicitIterationId);
  const target = explicit ?? defaultIterationOf(driver, scope.scope, scope.component_path);
  if (target === undefined || target.disposed_at !== undefined) return;
  driver
    .prepare(
      "INSERT OR IGNORE INTO iteration_members (iteration_id, component_id, carried_at)" +
        " VALUES (?, ?, ?)",
    )
    .run(target.iteration_id, componentId, now);
}

export type IterationInitApplyResult = {
  readonly iterations: number;
  readonly births: number;
  readonly members: number;
  readonly doc_members: number;
  readonly actives: number;
};

/**
 * `iteration.init` の plan を 1 transaction で書き込む (migration — command を
 * 経由しないので ledger には載らない)。冪等: 既存 init row / birth / member /
 * active は増やさず、既に設定された値を上書きしない。
 */
export function applyIterationInit(
  driver: SqlDriver,
  plan: IterationInitPlan,
  now: string,
): IterationInitApplyResult {
  const applied = { iterations: 0, births: 0, members: 0, doc_members: 0, actives: 0 };
  driver.exec("BEGIN IMMEDIATE");
  try {
    const insertIteration = driver.prepare(
      "INSERT INTO iterations (iteration_id, scope, component_path, name, seq," +
        " predecessor_iteration_id, created_at, last_modified) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    );
    const birthCheck = driver.prepare(
      "SELECT birth_iteration FROM components WHERE component_id = ?",
    );
    const birthUpdate = driver.prepare(
      "UPDATE components SET birth_iteration = ? WHERE component_id = ? AND birth_iteration IS NULL",
    );
    const memberCheck = driver.prepare(
      "SELECT 1 AS x FROM iteration_members WHERE iteration_id = ? AND component_id = ?",
    );
    const memberInsert = driver.prepare(
      "INSERT OR IGNORE INTO iteration_members (iteration_id, component_id, carried_at) VALUES (?, ?, ?)",
    );
    const docCheck = driver.prepare(
      "SELECT 1 AS x FROM iteration_doc_members WHERE iteration_id = ? AND document_path = ?",
    );
    const docInsert = driver.prepare(
      "INSERT OR IGNORE INTO iteration_doc_members (iteration_id, document_path, carried_at) VALUES (?, ?, ?)",
    );
    const activeCheck = driver.prepare(
      "SELECT 1 AS x FROM active_iterations WHERE scope = ? AND component_path = ? AND iteration_id = ?",
    );
    const activeInsert = driver.prepare(
      "INSERT INTO active_iterations (scope, component_path, iteration_id, is_default, activated_at) VALUES (?, ?, ?, 1, ?)",
    );

    for (const scope of plan.scopes) {
      if (scope.create) {
        insertIteration.run(
          scope.iteration_id,
          scope.scope,
          scope.component_path,
          INIT_ITERATION_LABEL,
          0,
          scope.created_at,
          scope.created_at,
        );
        applied.iterations += 1;
      }
      for (const assignment of scope.assignments) {
        const birth = birthCheck.get(assignment.component_id);
        if (birth !== undefined && rowString(birth, "birth_iteration") === undefined) {
          birthUpdate.run(assignment.iteration_id, assignment.component_id);
          applied.births += 1;
        }
        if (memberCheck.get(assignment.iteration_id, assignment.component_id) === undefined) {
          memberInsert.run(assignment.iteration_id, assignment.component_id, now);
          applied.members += 1;
        }
      }
      for (const path of scope.doc_members) {
        if (docCheck.get(scope.iteration_id, path) === undefined) {
          docInsert.run(scope.iteration_id, path, now);
          applied.doc_members += 1;
        }
      }
      if (
        scope.activate &&
        activeCheck.get(scope.scope, scope.component_path, scope.iteration_id) === undefined
      ) {
        activeInsert.run(scope.scope, scope.component_path, scope.iteration_id, scope.created_at);
        applied.actives += 1;
      }
    }
    driver.exec("COMMIT");
  } catch (cause) {
    driver.exec("ROLLBACK");
    throw cause;
  }
  return applied;
}
