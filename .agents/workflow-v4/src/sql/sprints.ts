// Sprint (schema 8) の SQLite 側。`sprints.ts` (pure contract) の lookup / render が
// 読む state の永続化と、registry (docs/sprints.md) からの adoption を持つ。
//
// - `applySprintEffect`: `sprint.issue` decision の DB 側。row + roster + head pointer
//   を呼び出し元 (runLocalCommand) の transaction の中で書く。
// - `planSprintRegistryAdoption` / `applySprintRegistryPlan`: `sprint.repair` の
//   tree -> DB 半分。parse 済み registry を既存 rows と突き合わせ、矛盾は failure、
//   欠けは insert 計画として返す。**順序を invent しない** — seq / issued_seq は
//   registry の記録値だけ (v1 の seq 欠落だけは issued_seq 順からの復元として扱う)。
// - `sprintLookupOf`: decide / dry-run plan が共有する現在 state の口。
// - `sprintHeadsOf` / `sprintEntriesForRegistry`: DB -> fs 再投影 (renderSprintRegistry
//   / `## current`) に渡す view。

import { err, ok, type Result } from "../result.ts";
import type { ComponentId } from "../ids.ts";
import type { IterationInfo } from "../iterations.ts";
import {
  type SprintInfo,
  sprintLabel,
  type SprintLookup,
  type SprintMember,
  type SprintRegistry,
  type SprintRegistryEntry,
  type SprintRegistryHead,
} from "../sprints.ts";
import type { SprintEffect } from "../decide.ts";
import { rowInteger, rowString, type SqlDriver } from "./driver.ts";
import { defaultIterationOf, effectiveIterationOf, iterationById } from "./iterations.ts";

// ---------------------------------------------------------------------------
// row <-> SprintInfo
// ---------------------------------------------------------------------------

const SPRINT_SELECT =
  "SELECT s.sprint_id, s.iteration_id, s.seq, s.issued_seq, s.previous_sprint_id," +
  " s.goal, s.accepted, s.baseline_ref, s.issued_at," +
  " i.scope, i.component_path, i.name AS iteration_name" +
  " FROM sprints s JOIN iterations i ON i.iteration_id = s.iteration_id";

function sprintInfoOf(row: Record<string, unknown>): SprintInfo {
  const iteration = {
    name: rowString(row, "iteration_name") ?? "",
  };
  const seq = rowInteger(row, "seq") ?? 0;
  return {
    sprint_id: rowString(row, "sprint_id") ?? "",
    iteration_id: rowString(row, "iteration_id") ?? "",
    scope: (rowString(row, "scope") ?? "project") as SprintInfo["scope"],
    component_path: rowString(row, "component_path") ?? "",
    label: sprintLabel(iteration as Pick<IterationInfo, "name">, seq),
    seq,
    issued_seq: rowInteger(row, "issued_seq") ?? 0,
    ...(rowString(row, "previous_sprint_id") === undefined
      ? {}
      : { previous_sprint_id: rowString(row, "previous_sprint_id") ?? "" }),
    goal: rowString(row, "goal") ?? "",
    accepted: rowString(row, "accepted") ?? "",
    ...(rowString(row, "baseline_ref") === undefined
      ? {}
      : { baseline_ref: rowString(row, "baseline_ref") ?? "" }),
    issued_at: rowString(row, "issued_at") ?? "",
  };
}

export function sprintById(driver: SqlDriver, sprintId: string): SprintInfo | undefined {
  const row = driver.prepare(`${SPRINT_SELECT} WHERE s.sprint_id = ?`).get(sprintId);
  return row === undefined ? undefined : sprintInfoOf(row);
}

/** repo 全体の sprint を issued_seq 順で。`iteration_id` があれば絞る。 */
export function listSprints(
  driver: SqlDriver,
  filter?: { readonly iteration_id?: string },
): SprintInfo[] {
  const rows = filter?.iteration_id === undefined
    ? driver.prepare(`${SPRINT_SELECT} ORDER BY s.issued_seq`).all()
    : driver
      .prepare(`${SPRINT_SELECT} WHERE s.iteration_id = ? ORDER BY s.issued_seq`)
      .all(filter.iteration_id);
  return rows.map(sprintInfoOf);
}

/** `current_sprints` の head。無ければ undefined — 前の iteration へは落ちない。 */
export function sprintHeadOf(
  driver: SqlDriver,
  iterationId: string,
): SprintInfo | undefined {
  const row = driver
    .prepare(
      `${SPRINT_SELECT}` +
        " JOIN current_sprints c ON c.sprint_id = s.sprint_id AND c.iteration_id = s.iteration_id" +
        " WHERE c.iteration_id = ?",
    )
    .get(iterationId);
  return row === undefined ? undefined : sprintInfoOf(row);
}

export function sprintMembersOf(driver: SqlDriver, sprintId: string): SprintMember[] {
  return driver
    .prepare(
      "SELECT component_id, state_revision FROM sprint_members" +
        " WHERE sprint_id = ? ORDER BY component_id",
    )
    .all(sprintId)
    .map((row) => ({
      component_id: (rowString(row, "component_id") ?? "") as ComponentId,
      state_revision: rowInteger(row, "state_revision") ?? 0,
    }));
}

/** scope 全体の head 一覧 (`## current` 再投影用)。iteration の seq 順で決定的に返す。 */
export function sprintHeadsOf(driver: SqlDriver): SprintRegistryHead[] {
  return driver
    .prepare(
      "SELECT c.iteration_id, c.sprint_id, i.scope, i.component_path, i.name, s.seq" +
        " FROM current_sprints c" +
        " JOIN iterations i ON i.iteration_id = c.iteration_id" +
        " JOIN sprints s ON s.sprint_id = c.sprint_id" +
        " ORDER BY i.scope, i.component_path, i.seq",
    )
    .all()
    .map((row) => ({
      scope: (rowString(row, "scope") ?? "project") as SprintRegistryHead["scope"],
      component_path: rowString(row, "component_path") ?? "",
      iteration: rowString(row, "name") ?? "",
      iteration_id: rowString(row, "iteration_id") ?? "",
      sprint_id: rowString(row, "sprint_id") ?? "",
      label: sprintLabel({ name: rowString(row, "name") ?? "" }, rowInteger(row, "seq") ?? 0),
    }));
}

/** DB -> fs 再投影用: 全 sprint を registry entry 形で (roster 付き)。 */
export function sprintEntriesForRegistry(driver: SqlDriver): SprintRegistryEntry[] {
  return listSprints(driver).map((sprint) => {
    const iteration = iterationById(driver, sprint.iteration_id);
    return {
      sprint_id: sprint.sprint_id,
      label: sprint.label,
      iteration: iteration?.name ?? "",
      iteration_id: sprint.iteration_id,
      scope: sprint.scope,
      component_path: sprint.component_path,
      seq: sprint.seq,
      issued_seq: sprint.issued_seq,
      ...(sprint.previous_sprint_id === undefined
        ? {}
        : { previous_sprint_id: sprint.previous_sprint_id }),
      goal: sprint.goal,
      issued_at: sprint.issued_at,
      ...(sprint.baseline_ref === undefined ? {} : { baseline_ref: sprint.baseline_ref }),
      accepted: sprint.accepted,
      roster: sprintMembersOf(driver, sprint.sprint_id).map((member) => ({
        component_id: member.component_id,
        state_revision: member.state_revision,
      })),
    };
  });
}

/** decide / dry-run plan が共有する現在 state の口。 */
export function sprintLookupOf(driver: SqlDriver): SprintLookup {
  return {
    byId: (sprintId) => sprintById(driver, sprintId),
    head: (iterationId) => sprintHeadOf(driver, iterationId),
    members: (sprintId) => sprintMembersOf(driver, sprintId),
    nextSeq: (iterationId) => {
      const row = driver
        .prepare("SELECT MAX(seq) AS m FROM sprints WHERE iteration_id = ?")
        .get(iterationId);
      return (rowInteger(row ?? {}, "m") ?? 0) + 1;
    },
    nextIssuedSeq: () => {
      const row = driver.prepare("SELECT MAX(issued_seq) AS m FROM sprints").get();
      return (rowInteger(row ?? {}, "m") ?? 0) + 1;
    },
  };
}

/**
 * audit / repair / list read が「この component の `sprint:` key は何であるべきか」を
 * 引く口。正本 = component の effective iteration の中で、この component を roster
 * に持つ最新 (最大 seq) の sprint。無ければ undefined — `sprint:` key も無いべき。
 * `path` は document が置かれている位置 — locator を持たない component は
 * undefined で project scope へ落ちる (effectiveIterationOf と同じ規則)。
 */
export function expectedSprintBinding(
  driver: SqlDriver,
  componentId: ComponentId,
  path: string | undefined,
): SprintInfo | undefined {
  const iteration = effectiveIterationOf(driver, componentId, path);
  if (iteration === undefined) return undefined;
  const row = driver
    .prepare(
      `${SPRINT_SELECT}` +
        " JOIN sprint_members m ON m.sprint_id = s.sprint_id" +
        " WHERE s.iteration_id = ? AND m.component_id = ? ORDER BY s.seq DESC LIMIT 1",
    )
    .get(iteration.iteration_id, componentId);
  return row === undefined ? undefined : sprintInfoOf(row);
}

// ---------------------------------------------------------------------------
// apply: sprint.issue の effect
// ---------------------------------------------------------------------------

/**
 * `sprint.issue` の DB 側。row + immutable roster + head pointer の 3 書き込み。
 * UNIQUE 制約違反 (同 seq / 同 issued_seq / prev の分岐) は exception で投げ返す —
 * runLocalCommand の catch が transaction ごと畳む。
 */
export function applySprintEffect(
  driver: SqlDriver,
  effect: SprintEffect,
  now: string,
): Result<undefined> {
  if (effect.kind !== "issue") {
    return err("unsupported_operation", `未知の sprint effect: ${effect.kind}`);
  }
  const sprint = effect.sprint;
  driver
    .prepare(
      "INSERT INTO sprints (sprint_id, iteration_id, seq, issued_seq, previous_sprint_id," +
        " goal, accepted, baseline_ref, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      sprint.sprint_id,
      sprint.iteration_id,
      sprint.seq,
      sprint.issued_seq,
      sprint.previous_sprint_id ?? null,
      sprint.goal,
      sprint.accepted,
      sprint.baseline_ref ?? null,
      sprint.issued_at,
    );
  const memberInsert = driver.prepare(
    "INSERT INTO sprint_members (sprint_id, component_id, state_revision) VALUES (?, ?, ?)",
  );
  for (const member of effect.members) {
    memberInsert.run(sprint.sprint_id, member.component_id, member.state_revision);
  }
  driver
    .prepare(
      "INSERT INTO current_sprints (iteration_id, sprint_id, updated_at) VALUES (?, ?, ?)" +
        " ON CONFLICT (iteration_id) DO UPDATE SET sprint_id = excluded.sprint_id," +
        " updated_at = excluded.updated_at",
    )
    .run(sprint.iteration_id, sprint.sprint_id, now);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// registry adoption (sprint.repair の tree -> DB 半分)
// ---------------------------------------------------------------------------

/** adoption 後の正規形。sprints/sprint_members/current_sprints へそのまま写す行。 */
export type SprintAdoptionRow = {
  readonly sprint_id: string;
  readonly iteration_id: string;
  readonly seq: number;
  readonly issued_seq: number;
  readonly previous_sprint_id?: string;
  readonly goal: string;
  readonly accepted: string;
  readonly baseline_ref?: string;
  readonly issued_at: string;
  readonly members: readonly SprintMember[];
};

export type SprintAdoptionHead = {
  readonly iteration_id: string;
  readonly sprint_id: string;
};

export type SprintAdoptionPlan = {
  readonly sprints: readonly SprintAdoptionRow[];
  readonly heads: readonly SprintAdoptionHead[];
};

export type SprintAdoptionFailure = {
  readonly sprint_id: string;
  readonly reason: string;
};

export type SprintAdoptionOutcome =
  | {
    readonly ok: true;
    readonly plan: SprintAdoptionPlan;
    readonly warnings: readonly string[];
    /** adoption 件数の概算 (既に DB に在って skip される entry も含めた総 entry 数)。 */
    readonly registry_entries: number;
  }
  | { readonly ok: false; readonly failures: readonly SprintAdoptionFailure[] };

/**
 * registry entry が指す iteration を DB へ解決する。
 *
 * - entry が `iteration_id` で実在 row を指せばそれ。v2 entry の scope /
 *   component_path / iteration name は一致検査の対象 — 食い違いは矛盾。
 * - **v1 救済 (裁定): scope を持たない entry (asakai interim) で iteration_id が
 *   DB に無い時**、`"none"` も含めて **scope default の iteration** へ畳む。
 *   default が無ければ「どこにも畳めない」failure。
 */
function resolveEntryIteration(
  driver: SqlDriver,
  entry: SprintRegistryEntry,
): Result<IterationInfo> {
  const direct = iterationById(driver, entry.iteration_id);
  if (direct !== undefined) {
    if (entry.scope !== undefined && entry.scope !== direct.scope) {
      return err(
        "document_structure_unreadable",
        `scope が矛盾: entry=${entry.scope} DB=${direct.scope}`,
      );
    }
    if (
      entry.component_path !== undefined && entry.component_path !== direct.component_path
    ) {
      return err(
        "document_structure_unreadable",
        `component_path が矛盾: entry=${entry.component_path} DB=${direct.component_path}`,
      );
    }
    if (entry.iteration !== "" && entry.iteration !== direct.name) {
      return err(
        "document_structure_unreadable",
        `iteration label が矛盾: entry=${entry.iteration} DB=${direct.name}`,
      );
    }
    return ok(direct);
  }
  // v1: scope を持たず、iteration_id も解決できない (典型的には "none")。
  if (entry.scope === undefined) {
    const fallback = defaultIterationOf(driver, "project", "");
    if (fallback === undefined) {
      return err(
        "document_structure_unreadable",
        `v1 entry の iteration_id ${entry.iteration_id} を解決できず、` +
          "project scope の default iteration も無い",
      );
    }
    return ok(fallback);
  }
  return err(
    "document_structure_unreadable",
    `iteration_id ${entry.iteration_id} が DB に無い` +
      " (fresh device では iteration.repair を先に走らせる)",
  );
}

/**
 * parse 済み registry を DB state と突き合わせて adoption 計画を組む。
 *
 * - sprint_id が DB に無い entry → INSERT 対象 (seq / issued_seq / prev / member の
 *   一意性・整合はここで全部検査する)。
 * - sprint_id が DB に在る entry → **全 field 一致なら skip、1 つでも違えば failure**
 *   (idempotent な再実行で違う内容を掛けない)。
 * - head は DB の `current_sprints` と突き合わせ — 無い / 違う時だけ upsert 対象。
 */
export function planSprintRegistryAdoption(
  driver: SqlDriver,
  registry: SprintRegistry,
): SprintAdoptionOutcome {
  const failures: SprintAdoptionFailure[] = [];
  const warnings: string[] = [];
  const sprints: SprintAdoptionRow[] = [];
  const heads: SprintAdoptionHead[] = [];

  // iteration ごとの v1 seq 復元用: issued_seq 順に 1,2,... を割る。
  const v1SeqCounter = new Map<string, number>();
  // (iteration_id, seq) と issued_seq の一意性を registry 全体 + DB で検査する。
  const seqSeen = new Map<string, string>();
  const issuedSeen = new Map<string, string>();
  for (const existing of listSprints(driver)) {
    seqSeen.set(`${existing.iteration_id}:${existing.seq}`, existing.sprint_id);
    issuedSeen.set(String(existing.issued_seq), existing.sprint_id);
  }

  // entry を issued_seq 順に揃えて見る (v1 の seq 復元が file 順に依らないため)。
  const entries = [...registry.entries].sort((a, b) => a.issued_seq - b.issued_seq);
  for (const entry of entries) {
    const iterationResult = resolveEntryIteration(driver, entry);
    if (!iterationResult.ok) {
      failures.push({ sprint_id: entry.sprint_id, reason: iterationResult.error.message });
      continue;
    }
    const iteration = iterationResult.value;
    let seq = entry.seq;
    if (seq === undefined) {
      // v1 entry は seq を持たない。同じ iteration の issued_seq 順で 1 から復元する。
      const count = v1SeqCounter.get(iteration.iteration_id) ?? 0;
      seq = count + 1;
      warnings.push(
        `${entry.sprint_id}: v1 entry の seq を issued_seq 順から復元 (${seq})`,
      );
    }
    v1SeqCounter.set(iteration.iteration_id, seq);
    const seqKey = `${iteration.iteration_id}:${seq}`;
    const seqHolder = seqSeen.get(seqKey);
    if (seqHolder !== undefined && seqHolder !== entry.sprint_id) {
      failures.push({
        sprint_id: entry.sprint_id,
        reason: `iteration ${iteration.name} の seq ${seq} が ${seqHolder} と衝突`,
      });
      continue;
    }
    seqSeen.set(seqKey, entry.sprint_id);
    const issuedHolder = issuedSeen.get(String(entry.issued_seq));
    if (issuedHolder !== undefined && issuedHolder !== entry.sprint_id) {
      failures.push({
        sprint_id: entry.sprint_id,
        reason: `issued_seq ${entry.issued_seq} が ${issuedHolder} と衝突`,
      });
      continue;
    }
    issuedSeen.set(String(entry.issued_seq), entry.sprint_id);

    // previous: 同じ iteration の entry / DB row を指すこと。
    if (entry.previous_sprint_id !== undefined) {
      const prevInRegistry = entries.find((e) => e.sprint_id === entry.previous_sprint_id);
      const prevInDb = sprintById(driver, entry.previous_sprint_id);
      const prevIteration = prevInRegistry !== undefined
        ? (() => {
          const resolved = resolveEntryIteration(driver, prevInRegistry);
          return resolved.ok ? resolved.value.iteration_id : undefined;
        })()
        : prevInDb?.iteration_id;
      if (prevInRegistry === undefined && prevInDb === undefined) {
        failures.push({
          sprint_id: entry.sprint_id,
          reason: `previous_sprint_id ${entry.previous_sprint_id} が registry にも DB にも無い`,
        });
        continue;
      }
      if (prevIteration !== undefined && prevIteration !== iteration.iteration_id) {
        failures.push({
          sprint_id: entry.sprint_id,
          reason: `previous_sprint_id が別 iteration (${prevIteration}) を指す`,
        });
        continue;
      }
    }

    // roster: component の実在だけを見る (kind / revision の検査は issue 時の話 —
    // repair は committed 記録を復元するので、存在しなければ矛盾として止める)。
    let rosterBad = false;
    for (const member of entry.roster) {
      const row = driver
        .prepare("SELECT 1 AS x FROM components WHERE component_id = ?")
        .get(member.component_id);
      if (row === undefined) {
        failures.push({
          sprint_id: entry.sprint_id,
          reason: `roster の component ${member.component_id} が COMPONENTS に無い`,
        });
        rosterBad = true;
      }
    }
    if (rosterBad) continue;

    const existing = sprintById(driver, entry.sprint_id);
    if (existing !== undefined) {
      // 既存 row との一致検査 — 同じ id で違う内容は掛けない。
      const mismatch = sprintMismatch(existing, entry, iteration.iteration_id, seq);
      if (mismatch !== undefined) {
        failures.push({ sprint_id: entry.sprint_id, reason: mismatch });
        continue;
      }
      const dbRoster = sprintMembersOf(driver, entry.sprint_id);
      const rosterMismatch = rosterMismatchReason(dbRoster, entry.roster);
      if (rosterMismatch !== undefined) {
        failures.push({ sprint_id: entry.sprint_id, reason: rosterMismatch });
      }
      continue;
    }
    sprints.push({
      sprint_id: entry.sprint_id,
      iteration_id: iteration.iteration_id,
      seq,
      issued_seq: entry.issued_seq,
      ...(entry.previous_sprint_id === undefined
        ? {}
        : { previous_sprint_id: entry.previous_sprint_id }),
      goal: entry.goal,
      accepted: entry.accepted,
      ...(entry.baseline_ref === undefined ? {} : { baseline_ref: entry.baseline_ref }),
      issued_at: entry.issued_at,
      members: entry.roster.map((member) => ({
        component_id: member.component_id as ComponentId,
        state_revision: member.state_revision,
      })),
    });
  }

  // head の解決。sprint は entries か DB のどちらかに在る必要がある。
  for (const head of registry.heads) {
    const sprint = entries.find((entry) => entry.sprint_id === head.sprint_id) !== undefined
      ? head.sprint_id
      : (sprintById(driver, head.sprint_id) !== undefined ? head.sprint_id : undefined);
    if (sprint === undefined) {
      failures.push({
        sprint_id: head.sprint_id,
        reason: `## current が未知の sprint を指す: ${head.sprint_id}`,
      });
      continue;
    }
    // head の iteration: sprint 自身の iteration が正本。head の iteration_id が
    // 別を指す (v1 の "none" 含む) 場合は scope default へ畳み、食い違いは矛盾。
    const owner = entries.find((entry) => entry.sprint_id === sprint);
    const ownerIteration = owner !== undefined
      ? (() => {
        const resolved = resolveEntryIteration(driver, owner);
        return resolved.ok ? resolved.value.iteration_id : undefined;
      })()
      : sprintById(driver, sprint)?.iteration_id;
    let headIteration = iterationById(driver, head.iteration_id)?.iteration_id;
    if (headIteration === undefined) {
      const fallback = defaultIterationOf(driver, "project", "");
      headIteration = fallback?.iteration_id;
      if (headIteration !== undefined) {
        warnings.push(
          `## current: head の iteration ${head.iteration_id} を scope default ` +
            `${fallback?.name} へ畳んだ`,
        );
      }
    }
    if (headIteration === undefined) {
      failures.push({
        sprint_id: head.sprint_id,
        reason: `## current の iteration ${head.iteration_id} を解決できない`,
      });
      continue;
    }
    if (ownerIteration !== undefined && ownerIteration !== headIteration) {
      failures.push({
        sprint_id: head.sprint_id,
        reason: `## current の iteration (${headIteration}) と sprint 自身の ` +
          `iteration (${ownerIteration}) が食い違う`,
      });
      continue;
    }
    const current = sprintHeadOf(driver, headIteration);
    if (current !== undefined && current.sprint_id === head.sprint_id) continue; // 既に head
    heads.push({ iteration_id: headIteration, sprint_id: head.sprint_id });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, plan: { sprints, heads }, warnings, registry_entries: entries.length };
}

function sprintMismatch(
  existing: SprintInfo,
  entry: SprintRegistryEntry,
  iterationId: string,
  seq: number,
): string | undefined {
  const fields: [string, string | number | undefined, string | number | undefined][] = [
    ["iteration_id", existing.iteration_id, iterationId],
    ["seq", existing.seq, seq],
    ["issued_seq", existing.issued_seq, entry.issued_seq],
    ["previous_sprint_id", existing.previous_sprint_id, entry.previous_sprint_id],
    ["goal", existing.goal, entry.goal],
    ["accepted", existing.accepted, entry.accepted],
    ["baseline_ref", existing.baseline_ref, entry.baseline_ref],
    ["issued_at", existing.issued_at, entry.issued_at],
  ];
  for (const [name, dbValue, entryValue] of fields) {
    if (dbValue !== entryValue) {
      return `sprint ${existing.sprint_id} の ${name} が DB (${String(dbValue)}) と ` +
        `registry (${String(entryValue)}) で食い違う`;
    }
  }
  return undefined;
}

function rosterMismatchReason(
  dbRoster: readonly SprintMember[],
  entryRoster: readonly { component_id: string; state_revision: number }[],
): string | undefined {
  if (dbRoster.length !== entryRoster.length) {
    return `roster 件数が DB (${dbRoster.length}) と registry (${entryRoster.length}) で食い違う`;
  }
  const dbSet = new Map(dbRoster.map((m) => [m.component_id, m.state_revision]));
  for (const member of entryRoster) {
    const revision = dbSet.get(member.component_id as ComponentId);
    if (revision === undefined) {
      return `roster の ${member.component_id} が DB に無い`;
    }
    if (revision !== member.state_revision) {
      return `roster ${member.component_id} の revision が DB (r${revision}) と ` +
        `registry (r${member.state_revision}) で食い違う`;
    }
  }
  return undefined;
}

/** adoption 計画を 1 transaction で書く。冪等 — 既存 row は plan 段で skip 済み。 */
export function applySprintRegistryPlan(
  driver: SqlDriver,
  plan: SprintAdoptionPlan,
  now: string,
): Result<{ sprints: number; members: number; heads: number }> {
  const applied = { sprints: 0, members: 0, heads: 0 };
  driver.exec("BEGIN IMMEDIATE");
  try {
    const insertSprint = driver.prepare(
      "INSERT INTO sprints (sprint_id, iteration_id, seq, issued_seq, previous_sprint_id," +
        " goal, accepted, baseline_ref, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertMember = driver.prepare(
      "INSERT INTO sprint_members (sprint_id, component_id, state_revision) VALUES (?, ?, ?)",
    );
    const upsertHead = driver.prepare(
      "INSERT INTO current_sprints (iteration_id, sprint_id, updated_at) VALUES (?, ?, ?)" +
        " ON CONFLICT (iteration_id) DO UPDATE SET sprint_id = excluded.sprint_id," +
        " updated_at = excluded.updated_at",
    );
    for (const row of plan.sprints) {
      insertSprint.run(
        row.sprint_id,
        row.iteration_id,
        row.seq,
        row.issued_seq,
        row.previous_sprint_id ?? null,
        row.goal,
        row.accepted,
        row.baseline_ref ?? null,
        row.issued_at,
      );
      applied.sprints += 1;
      for (const member of row.members) {
        insertMember.run(row.sprint_id, member.component_id, member.state_revision);
        applied.members += 1;
      }
    }
    for (const head of plan.heads) {
      upsertHead.run(head.iteration_id, head.sprint_id, now);
      applied.heads += 1;
    }
    driver.exec("COMMIT");
    return ok(applied);
  } catch (cause) {
    driver.exec("ROLLBACK");
    return err(
      "invalid_field_type",
      `sprint registry の adoption が失敗した: ${String(cause)}`,
      "sprint.repair",
    );
  }
}
