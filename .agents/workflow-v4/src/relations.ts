// relation は source repo が所有する outgoing だけを正本にする。
// target repo に同じ relation を正本として二重保存しない。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentAddress,
  formatComponentAddress,
  joinPath,
  parseComponentAddress,
  sameAddress,
} from "./ids.ts";
import type { RepositoryContext } from "./repository.ts";

/**
 * Slice A が必要とする relation type だけを持つ。
 * 用途が確定していない type を先回りで足さない。
 */
export const RELATION_TYPES = ["planned_task", "predecessor"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export function parseRelationType(value: unknown, path?: string): Result<RelationType> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "relation_type は string である必要がある", path);
  }
  const relationType = RELATION_TYPES.find((candidate) => candidate === value);
  if (relationType === undefined) {
    return err("unknown_relation_type", `未知の relation_type: ${JSON.stringify(value)}`, path);
  }
  return ok(relationType);
}

/** relation は裸の component ID を持たず、必ず repository_id を伴う address で表す。 */
export type RelationKey = {
  readonly source: ComponentAddress;
  readonly target: ComponentAddress;
  readonly relation_type: RelationType;
};

const RELATION_KEY_FIELDS = ["source", "target", "relation_type"] as const;

export function parseRelationKey(value: unknown, path?: string): Result<RelationKey> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "RelationKey は object である必要がある", path);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(RELATION_KEY_FIELDS as readonly string[]).includes(key)) {
      return err("unexpected_field", `RelationKey に未知の field がある: ${key}`, path);
    }
  }
  const source = parseComponentAddress(raw["source"], joinPath(path, "source"));
  if (!source.ok) return source;
  const target = parseComponentAddress(raw["target"], joinPath(path, "target"));
  if (!target.ok) return target;
  const relationType = parseRelationType(raw["relation_type"], joinPath(path, "relation_type"));
  if (!relationType.ok) return relationType;
  return ok({ source: source.value, target: target.value, relation_type: relationType.value });
}

/** dedupe 用の正規形。source / target / type の複合 key を 1 本の文字列にする。 */
export function relationKeyString(key: RelationKey): string {
  return [
    formatComponentAddress(key.source),
    key.relation_type,
    formatComponentAddress(key.target),
  ].join("|");
}

export type RelationLocality = "local" | "external";

/**
 * locality は relation_type ではなく key から決まる。
 * source は必ず local repo に属し、target が別 repo なら external になる。
 */
export function relationLocality(
  key: RelationKey,
  context: RepositoryContext,
): Result<RelationLocality> {
  if (key.source.repository_id !== context.repository_id) {
    return err(
      "relation_source_not_local",
      `relation の source repository ${key.source.repository_id} が context ${context.repository_id} と一致しない`,
      "source.repository_id",
    );
  }
  if (sameAddress(key.source, key.target)) {
    return err("relation_self_reference", "relation の source と target が同一 component である");
  }
  return ok(key.target.repository_id === context.repository_id ? "local" : "external");
}

/**
 * incoming relation は source repo の outgoing を反転した非正本 projection。
 * coverage を必ず伴わせ、未接続 repo がある状態を「incoming なし」と読み替えられないようにする。
 */
export type IncomingRelationProjection = {
  readonly canonical: false;
  readonly key: RelationKey;
};

export function toIncomingProjection(key: RelationKey): IncomingRelationProjection {
  return { canonical: false, key };
}

export type IncomingRelationView = {
  readonly target: ComponentAddress;
  readonly known_incoming: readonly IncomingRelationProjection[];
  /** 走査できた repository の集合が現在の ViewScope を満たしているか。 */
  readonly coverage_complete: boolean;
  /** coverage に含められなかった repository。coverage_complete=false の時だけ非空。 */
  readonly missing_repository_ids: readonly string[];
};

/** coverage が不完全な時に「incoming なし」を確定表示できないことを型と関数で示す。 */
export function hasNoIncoming(view: IncomingRelationView): boolean | "unknown" {
  if (view.known_incoming.length > 0) return false;
  return view.coverage_complete ? true : "unknown";
}
