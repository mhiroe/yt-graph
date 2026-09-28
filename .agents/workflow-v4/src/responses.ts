// CommandResponse。disposition は operation の適用結果であり、domain entity の result ではない。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentAddress,
  type ComponentId,
  joinPath,
  type OperationId,
  parseComponentAddress,
  parseComponentId,
  parseOperationId,
  parseRepositoryId,
  type RepositoryId,
} from "./ids.ts";
import { parseRevision, type Revision } from "./components.ts";
import { type IterationInfo, type IterationScope, parseIterationScope } from "./iterations.ts";
import { parseRelationKey, type RelationKey } from "./relations.ts";

export const DISPOSITIONS = ["applied", "noop", "rejected", "conflict", "not_found"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** reason を必須にする disposition。理由なしで失敗を返せないようにする。 */
const REASON_REQUIRED: readonly Disposition[] = ["rejected", "conflict", "not_found"];

export function parseDisposition(value: unknown, path?: string): Result<Disposition> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "disposition は string である必要がある", path);
  }
  const disposition = DISPOSITIONS.find((candidate) => candidate === value);
  if (disposition === undefined) {
    return err("unknown_operation", `未知の disposition: ${JSON.stringify(value)}`, path);
  }
  return ok(disposition);
}

export type CommandResponse = {
  readonly operation_id: OperationId;
  readonly repository_id: RepositoryId;
  readonly disposition: Disposition;
  readonly component_id?: ComponentId;
  readonly state_revision?: Revision;
  /** identity は repository_id + component_id なので address で返す。 */
  readonly created_ids: readonly ComponentAddress[];
  /**
   * この command が外した relation (裁定 root PM 2026-09-15)。
   *
   * **`relation.detach` だけが持つ。**「移動」を response から読めるようにするために置く。
   * receipt (`operation.get_receipt`) が返すのは `CommandResponse` だけで operation 名も
   * payload も含まないので、これが無いと「元の親から外れた」が receipt から読めない。
   * `created_ids` と対になる形にしている。
   */
  readonly removed_relations?: readonly RelationKey[];
  /**
   * `iteration.*` command が対象にした iteration (schema 6)。
   * receipt だけから iteration を特定できるように、command response にも乗せる。
   * component の `created_ids` と同じく「採番結果を caller へ返す」役割。
   */
  readonly iteration?: IterationInfo;
  readonly reason?: string;
};

const ITERATION_RESPONSE_FIELDS = [
  "iteration_id",
  "scope",
  "component_path",
  "name",
  "seq",
  "predecessor_iteration_id",
  "created_at",
  // schema 7: `closed_at` は廃止。`last_modified` が必須で残る。
  "last_modified",
  "disposed_at",
] as const;

function parseIterationInfo(value: unknown, path?: string): Result<IterationInfo> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "iteration は object である必要がある", path);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(ITERATION_RESPONSE_FIELDS as readonly string[]).includes(key)) {
      return err(
        "unexpected_field",
        `iteration に未知の field がある: ${key}`,
        joinPath(path, key),
      );
    }
  }
  const id = raw["iteration_id"];
  if (typeof id !== "string" || id.length === 0) {
    return err(
      "invalid_field_type",
      "iteration_id は空でない string である必要がある",
      joinPath(path, "iteration_id"),
    );
  }
  const scope = parseIterationScope(raw["scope"], joinPath(path, "scope"));
  if (!scope.ok) return scope;
  const componentPath = raw["component_path"];
  if (typeof componentPath !== "string") {
    return err(
      "invalid_field_type",
      "component_path は string である必要がある",
      joinPath(path, "component_path"),
    );
  }
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    return err(
      "invalid_field_type",
      "name は空でない string である必要がある",
      joinPath(path, "name"),
    );
  }
  const seq = raw["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    return err("invalid_field_type", "seq は 1 以上の整数である必要がある", joinPath(path, "seq"));
  }
  const createdAt = raw["created_at"];
  if (typeof createdAt !== "string") {
    return err(
      "invalid_field_type",
      "created_at は string である必要がある",
      joinPath(path, "created_at"),
    );
  }
  const optional = (field: string): string | undefined => {
    const v = raw[field];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const predecessor = optional("predecessor_iteration_id");
  const lastModified = optional("last_modified");
  const disposedAt = optional("disposed_at");
  if (lastModified === undefined) {
    return err(
      "invalid_field_type",
      "last_modified は string である必要がある",
      joinPath(path, "last_modified"),
    );
  }
  return ok({
    iteration_id: id,
    scope: scope.value as IterationScope,
    component_path: componentPath,
    name,
    seq,
    ...(predecessor === undefined ? {} : { predecessor_iteration_id: predecessor }),
    created_at: createdAt,
    last_modified: lastModified,
    ...(disposedAt === undefined ? {} : { disposed_at: disposedAt }),
  });
}

const RESPONSE_FIELDS = [
  "operation_id",
  "repository_id",
  "disposition",
  "component_id",
  "state_revision",
  "created_ids",
  "removed_relations",
  "iteration",
  "reason",
] as const;

export function parseCommandResponse(value: unknown): Result<CommandResponse> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "CommandResponse は object である必要がある");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(RESPONSE_FIELDS as readonly string[]).includes(key)) {
      return err("unexpected_field", `CommandResponse に未知の field がある: ${key}`, key);
    }
  }
  const operationId = parseOperationId(raw["operation_id"], "operation_id");
  if (!operationId.ok) return operationId;
  const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
  if (!repositoryId.ok) return repositoryId;
  const disposition = parseDisposition(raw["disposition"], "disposition");
  if (!disposition.ok) return disposition;

  let componentId: ComponentId | undefined;
  if (raw["component_id"] !== undefined && raw["component_id"] !== null) {
    const parsed = parseComponentId(raw["component_id"], "component_id");
    if (!parsed.ok) return parsed;
    componentId = parsed.value;
  }
  let stateRevision: Revision | undefined;
  if (raw["state_revision"] !== undefined && raw["state_revision"] !== null) {
    const parsed = parseRevision(raw["state_revision"], "state_revision");
    if (!parsed.ok) return parsed;
    stateRevision = parsed.value;
  }

  const createdRaw = raw["created_ids"];
  if (createdRaw !== undefined && !Array.isArray(createdRaw)) {
    return err("invalid_field_type", "created_ids は array である必要がある", "created_ids");
  }
  const createdIds: ComponentAddress[] = [];
  for (const [index, item] of (createdRaw ?? []).entries()) {
    const parsed = parseComponentAddress(item, joinPath("created_ids", String(index)));
    if (!parsed.ok) return parsed;
    createdIds.push(parsed.value);
  }

  const removedRaw = raw["removed_relations"];
  if (removedRaw !== undefined && removedRaw !== null && !Array.isArray(removedRaw)) {
    return err(
      "invalid_field_type",
      "removed_relations は array である必要がある",
      "removed_relations",
    );
  }
  let removedRelations: RelationKey[] | undefined;
  if (Array.isArray(removedRaw)) {
    removedRelations = [];
    for (const [index, item] of removedRaw.entries()) {
      const parsed = parseRelationKey(item, joinPath("removed_relations", String(index)));
      if (!parsed.ok) return parsed;
      removedRelations.push(parsed.value);
    }
  }

  let iteration: IterationInfo | undefined;
  if (raw["iteration"] !== undefined && raw["iteration"] !== null) {
    const parsed = parseIterationInfo(raw["iteration"], "iteration");
    if (!parsed.ok) return parsed;
    iteration = parsed.value;
  }

  const reasonRaw = raw["reason"];
  if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== "string") {
    return err("invalid_field_type", "reason は string である必要がある", "reason");
  }
  const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
  if (
    REASON_REQUIRED.includes(disposition.value) && (reason === undefined || reason.length === 0)
  ) {
    return err(
      "missing_field",
      `disposition=${disposition.value} は reason を必要とする`,
      "reason",
    );
  }
  if (disposition.value === "applied" && stateRevision === undefined && componentId !== undefined) {
    return err(
      "missing_field",
      "applied response は state_revision を返す必要がある",
      "state_revision",
    );
  }

  return ok({
    operation_id: operationId.value,
    repository_id: repositoryId.value,
    disposition: disposition.value,
    ...(componentId === undefined ? {} : { component_id: componentId }),
    ...(stateRevision === undefined ? {} : { state_revision: stateRevision }),
    created_ids: createdIds,
    ...(removedRelations === undefined || removedRelations.length === 0
      ? {}
      : { removed_relations: removedRelations }),
    ...(iteration === undefined ? {} : { iteration }),
    ...(reason === undefined ? {} : { reason }),
  });
}

export function applied(
  operationId: OperationId,
  repositoryId: RepositoryId,
  componentId: ComponentId,
  stateRevision: Revision,
  createdIds: readonly ComponentAddress[] = [],
): CommandResponse {
  return {
    operation_id: operationId,
    repository_id: repositoryId,
    disposition: "applied",
    component_id: componentId,
    state_revision: stateRevision,
    created_ids: createdIds,
  };
}

export function rejected(
  operationId: OperationId,
  repositoryId: RepositoryId,
  reason: string,
): CommandResponse {
  return {
    operation_id: operationId,
    repository_id: repositoryId,
    disposition: "rejected",
    created_ids: [],
    reason,
  };
}
