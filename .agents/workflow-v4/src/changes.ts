// repo-scoped change notification。notification は再 query の cue であり、本文を載せない。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentId,
  type EventId,
  joinPath,
  parseComponentId,
  parseEventId,
  parseRepositoryId,
  type RepositoryId,
} from "./ids.ts";
import { parseRelationKey, type RelationKey } from "./relations.ts";

declare const repoCursorBrand: unique symbol;

/**
 * repo-scoped かつ opaque な cursor。
 * client は source device sequence や replication cursor として解釈しない。
 */
export type RepoCursor = string & { readonly [repoCursorBrand]: true };

export function parseRepoCursor(value: unknown, path?: string): Result<RepoCursor> {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return err("invalid_field_type", "repo cursor は 1..512 文字の string である必要がある", path);
  }
  return ok(value as RepoCursor);
}

export type ChangeNotification = {
  readonly repository_id: RepositoryId;
  readonly next_repo_cursor: RepoCursor;
  readonly changed_component_ids: readonly ComponentId[];
  readonly changed_relation_keys: readonly RelationKey[];
  /**
   * 未解決 conflict の event ID (Slice D で確定)。
   *
   * **裁定 (Slice D): parse 済みの `EventId` にするが、repository-qualified 化はしない。**
   * notification は既に repo-scoped で `repository_id` を持ち、DB の `DOMAIN_EVENTS` は
   * repository_id 列を持たない。qualify すると repo が 2 か所に現れ、この DB が保持できない値
   * (他 repo の event) を表現できてしまう。裸の string をやめて parse 済み型にするのは、
   * 他の ID field と同じ扱いへ揃えるため。
   */
  readonly conflict_ids: readonly EventId[];
};

const NOTIFICATION_FIELDS = [
  "repository_id",
  "next_repo_cursor",
  "changed_component_ids",
  "changed_relation_keys",
  "conflict_ids",
] as const;

/**
 * notification に component / event 本文が載っていないことも contract として検証する。
 * 本文を載せた形は `change_notification_carries_body` で拒否する。
 */
const BODY_FIELDS = ["components", "events", "payload", "document", "activities"];

export function parseChangeNotification(value: unknown): Result<ChangeNotification> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "ChangeNotification は object である必要がある");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if ((NOTIFICATION_FIELDS as readonly string[]).includes(key)) continue;
    if (BODY_FIELDS.includes(key)) {
      return err(
        "change_notification_carries_body",
        `notification は再 query の cue であり本文を載せない: ${key}`,
        key,
      );
    }
    return err("unexpected_field", `ChangeNotification に未知の field がある: ${key}`, key);
  }

  const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
  if (!repositoryId.ok) return repositoryId;
  const cursor = parseRepoCursor(raw["next_repo_cursor"], "next_repo_cursor");
  if (!cursor.ok) return cursor;

  const componentsRaw = raw["changed_component_ids"];
  if (!Array.isArray(componentsRaw)) {
    return err("invalid_field_type", "changed_component_ids は array である必要がある");
  }
  const componentIds: ComponentId[] = [];
  for (const [index, item] of componentsRaw.entries()) {
    const parsed = parseComponentId(item, joinPath("changed_component_ids", String(index)));
    if (!parsed.ok) return parsed;
    componentIds.push(parsed.value);
  }

  const relationsRaw = raw["changed_relation_keys"];
  if (!Array.isArray(relationsRaw)) {
    return err("invalid_field_type", "changed_relation_keys は array である必要がある");
  }
  const relationKeys: RelationKey[] = [];
  for (const [index, item] of relationsRaw.entries()) {
    const parsed = parseRelationKey(item, joinPath("changed_relation_keys", String(index)));
    if (!parsed.ok) return parsed;
    // feed は repo-scoped なので、source が他 repo の relation を混ぜない。
    if (parsed.value.source.repository_id !== repositoryId.value) {
      return err(
        "cursor_not_repo_scoped",
        `changed_relation_keys に他 repo 所有の relation が混ざっている: ${parsed.value.source.repository_id}`,
        joinPath("changed_relation_keys", String(index)),
      );
    }
    relationKeys.push(parsed.value);
  }

  const conflictsRaw = raw["conflict_ids"];
  if (!Array.isArray(conflictsRaw)) {
    return err("invalid_field_type", "conflict_ids は array である必要がある");
  }
  const conflictIds: EventId[] = [];
  for (const [index, item] of conflictsRaw.entries()) {
    const parsed = parseEventId(item, joinPath("conflict_ids", String(index)));
    if (!parsed.ok) return parsed;
    conflictIds.push(parsed.value);
  }

  return ok({
    repository_id: repositoryId.value,
    next_repo_cursor: cursor.value,
    changed_component_ids: componentIds,
    changed_relation_keys: relationKeys,
    conflict_ids: conflictIds,
  });
}

/**
 * subscribe の結果。cursor 失効はその repo だけの page rescan で回復する。
 * replication gap は Core が bootstrap_required を返し、client 側 rescan で直そうとしない。
 */
export type SubscribeChangesResult =
  | { readonly status: "ok"; readonly notification: ChangeNotification }
  | { readonly status: "cursor_expired"; readonly repository_id: RepositoryId }
  | { readonly status: "bootstrap_required"; readonly repository_id: RepositoryId };

export function shouldRescanRepository(result: SubscribeChangesResult): boolean {
  return result.status === "cursor_expired";
}
