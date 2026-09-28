// versioned WorkflowPort capability。client は接続前に必要な operation / query / feature を宣言して照合する。

import { err, ok, type Result } from "./result.ts";
import { parseRepositoryId, type RepositoryId } from "./ids.ts";
import { OPERATION_NAMES, type OperationName, parseOperationName } from "./commands.ts";
import {
  formatProtocolVersion,
  isProtocolCompatible,
  parseProtocolVersion,
  type ProtocolVersion,
  WORKFLOW_PROTOCOL_VERSION,
} from "./protocol.ts";

export const QUERY_NAMES = [
  "workflow.capabilities",
  "overview.snapshot",
  "component.get_summary",
  "relation.list_outgoing",
  "relation.find_outgoing_to",
  "activity.list",
  "operation.get_receipt",
  // 裁定 (7b gap 2 2026-09-20): receipt を 1 件引く口しか無く、**operation_id を失うと
  // receipt も引けない。**必要なのは client 側の永続化ではなく repo 側の列挙で、
  // client へ持たせると operation の正本が 2 つになる。
  "operation.list",
  "workflow.subscribe_changes",
] as const;
export type QueryName = (typeof QUERY_NAMES)[number];

/**
 * feature flag。Slice A では document write / replication / satisfaction を提供しないので、
 * 「未実装」を false として明示し、client が推測で使わないようにする。
 */
export const FEATURE_NAMES = [
  "change_feed",
  "document_write",
  "document_projection",
  "replication",
  "cross_repo_recovery",
  "satisfaction",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * read model を構成する query の識別子。
 *
 * 裁定 (Slice B、root PM): 識別子、version、negotiation 上の宣言は shared contract が持ち、
 * SQLite / read model の実装と sync core -> async client の変換は adapter 側に置く。
 * 実 adapter 接続は後続 slice なので、ここには宣言だけを置いて実装を先取りしない。
 */
export const READ_MODEL_QUERY_NAMES = [
  "overview.snapshot",
  "component.get_summary",
  "relation.list_outgoing",
  "relation.find_outgoing_to",
  "activity.list",
  "operation.get_receipt",
  "operation.list",
] as const;
export type ReadModelQueryName = (typeof READ_MODEL_QUERY_NAMES)[number];

/**
 * read model contract の version。protocol version とは別に進む。
 * query 名の集合、page の形、cursor の意味が変わったら上げる。
 */
export const WORKFLOW_READ_MODEL_VERSION: ProtocolVersion = { major: 1, minor: 0 };

export type WorkflowCapabilities = {
  readonly protocol_version: ProtocolVersion;
  readonly repository_id: RepositoryId;
  readonly supported_operations: readonly OperationName[];
  readonly supported_queries: readonly QueryName[];
  readonly features: Readonly<Record<FeatureName, boolean>>;
  /**
   * read model を提供する adapter だけが宣言する。
   * 未宣言は「read model を持たない」であり、「version 不明だが多分使える」ではない。
   */
  readonly read_model_version?: ProtocolVersion;
};

/** Slice A の pure core が宣言する capability。 */
export function sliceACapabilities(repositoryId: RepositoryId): WorkflowCapabilities {
  return {
    protocol_version: WORKFLOW_PROTOCOL_VERSION,
    repository_id: repositoryId,
    supported_operations: OPERATION_NAMES,
    supported_queries: ["workflow.capabilities"],
    features: {
      change_feed: false,
      document_write: false,
      document_projection: false,
      replication: false,
      cross_repo_recovery: false,
      satisfaction: false,
    },
  };
}

/**
 * adapter が read model を宣言するための helper。query の実装はこの module に無い。
 * 宣言した query は `supported_queries` にも載せ、capability 表と実装を 1 つの入口から作る。
 */
export function declareReadModel(
  capabilities: WorkflowCapabilities,
  queries: readonly ReadModelQueryName[] = READ_MODEL_QUERY_NAMES,
  version: ProtocolVersion = WORKFLOW_READ_MODEL_VERSION,
): WorkflowCapabilities {
  const merged = [...capabilities.supported_queries];
  for (const query of queries) {
    if (!merged.includes(query)) merged.push(query);
  }
  return { ...capabilities, supported_queries: merged, read_model_version: version };
}

/**
 * adapter が document operation と document projection を宣言するための helper。
 *
 * 2 つを別 flag のまま扱う。`document_write` を持たず観測だけ通す adapter
 * (wishboard Slice 3 の VaultFileObserver 側) が実在するので、1 つへ潰さない。
 * Slice C の CLI は両方を持つ。
 */
export function declareDocument(
  capabilities: WorkflowCapabilities,
  options: { readonly write: boolean; readonly projection: boolean },
): WorkflowCapabilities {
  return {
    ...capabilities,
    features: {
      ...capabilities.features,
      document_write: options.write,
      document_projection: options.projection,
    },
  };
}

/**
 * adapter が replication を宣言するための helper (Slice D)。
 *
 * `document_write` / `document_projection` と同じく **1 つの flag へ潰さない**。committed event を
 * 出すだけの adapter と、inbox / cursor まで持つ adapter を区別する必要が出た時に、宣言だけを
 * 増やせる形にしておく。現在の SQLite adapter は outbox / inbox / cursor の 3 つとも持つ。
 */
export function declareReplication(
  capabilities: WorkflowCapabilities,
  options: { readonly replication: boolean },
): WorkflowCapabilities {
  return {
    ...capabilities,
    features: { ...capabilities.features, replication: options.replication },
  };
}

/**
 * adapter が cross-repo recovery を宣言するための helper (Slice E)。
 *
 * **`replication` と別 flag に保つ。** replication は同一 repo の device 間 Journal で、
 * cross-repo recovery は 2 つの repo の間の 2 step 調整である。Slice D の実測で「replication は
 * cross-repo の判断材料を 1 つも生まなかった」ことが出ているとおり、別の関心事。
 * 1 つへ潰すと、片方だけを持つ adapter を表現できない。
 */
export function declareCrossRepo(
  capabilities: WorkflowCapabilities,
  options: { readonly recovery: boolean },
): WorkflowCapabilities {
  return {
    ...capabilities,
    features: { ...capabilities.features, cross_repo_recovery: options.recovery },
  };
}

export function parseCapabilities(value: unknown): Result<WorkflowCapabilities> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", "capabilities は object である必要がある");
  }
  const raw = value as Record<string, unknown>;
  const allowed = [
    "protocol_version",
    "repository_id",
    "supported_operations",
    "supported_queries",
    "features",
    "read_model_version",
  ];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return err("unexpected_field", `capabilities に未知の field がある: ${key}`, key);
    }
  }
  const protocolVersion = parseProtocolVersion(raw["protocol_version"], "protocol_version");
  if (!protocolVersion.ok) return protocolVersion;
  const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
  if (!repositoryId.ok) return repositoryId;

  const operations: OperationName[] = [];
  if (!Array.isArray(raw["supported_operations"])) {
    return err("invalid_field_type", "supported_operations は array である必要がある");
  }
  for (const item of raw["supported_operations"]) {
    const parsed = parseOperationName(item, "supported_operations");
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }

  const queries: QueryName[] = [];
  if (!Array.isArray(raw["supported_queries"])) {
    return err("invalid_field_type", "supported_queries は array である必要がある");
  }
  for (const item of raw["supported_queries"]) {
    const query = QUERY_NAMES.find((candidate) => candidate === item);
    if (query === undefined) {
      return err("unsupported_query", `未知の query: ${JSON.stringify(item)}`, "supported_queries");
    }
    queries.push(query);
  }

  const featuresRaw = raw["features"];
  if (typeof featuresRaw !== "object" || featuresRaw === null || Array.isArray(featuresRaw)) {
    return err("invalid_field_type", "features は object である必要がある", "features");
  }
  const features: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(featuresRaw as Record<string, unknown>)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
      return err("unsupported_feature", `未知の feature: ${key}`, "features");
    }
    if (typeof item !== "boolean") {
      return err("invalid_field_type", `feature ${key} は boolean である必要がある`, "features");
    }
    features[key] = item;
  }
  for (const name of FEATURE_NAMES) {
    if (!(name in features)) {
      return err("missing_field", `feature ${name} の宣言が無い`, "features");
    }
  }

  let readModelVersion: ProtocolVersion | undefined;
  const readModelRaw = raw["read_model_version"];
  if (readModelRaw !== undefined && readModelRaw !== null) {
    const parsed = parseProtocolVersion(readModelRaw, "read_model_version");
    if (!parsed.ok) return parsed;
    readModelVersion = parsed.value;
  }

  return ok({
    protocol_version: protocolVersion.value,
    repository_id: repositoryId.value,
    supported_operations: operations,
    supported_queries: queries,
    features: features as Record<FeatureName, boolean>,
    ...(readModelVersion === undefined ? {} : { read_model_version: readModelVersion }),
  });
}

export type CapabilityRequirement = {
  readonly protocol_version: ProtocolVersion;
  readonly operations?: readonly OperationName[];
  readonly queries?: readonly QueryName[];
  readonly features?: readonly FeatureName[];
  /** read model を要求する client だけが設定する。未設定なら read model の有無を見ない。 */
  readonly read_model_version?: ProtocolVersion;
};

export type CapabilityNegotiation =
  | { readonly status: "compatible" }
  | {
    readonly status: "incompatible";
    readonly reason: string;
    readonly missing_operations: readonly OperationName[];
    readonly missing_queries: readonly QueryName[];
    readonly missing_features: readonly FeatureName[];
    /** read model の要求を満たせなかった時だけ、要求された version を載せる。 */
    readonly required_read_model_version?: ProtocolVersion;
  };

/** 不足があれば必ず列挙して返す。不足を「使えるはず」へ倒さない。 */
export function negotiateCapabilities(
  capabilities: WorkflowCapabilities,
  requirement: CapabilityRequirement,
): CapabilityNegotiation {
  if (!isProtocolCompatible(capabilities.protocol_version, requirement.protocol_version)) {
    return {
      status: "incompatible",
      reason: `port protocol ${formatProtocolVersion(capabilities.protocol_version)} が要求 ${
        formatProtocolVersion(requirement.protocol_version)
      } と互換でない`,
      missing_operations: [],
      missing_queries: [],
      missing_features: [],
    };
  }
  const missingOperations = (requirement.operations ?? []).filter((name) =>
    !capabilities.supported_operations.includes(name)
  );
  const missingQueries = (requirement.queries ?? []).filter((name) =>
    !capabilities.supported_queries.includes(name)
  );
  const missingFeatures = (requirement.features ?? []).filter((name) =>
    capabilities.features[name] !== true
  );

  // read model は未宣言を「多分使える」へ倒さない。宣言が無い port は不足として扱う。
  const requiredReadModel = requirement.read_model_version;
  const readModelUnsatisfied = requiredReadModel !== undefined &&
    (capabilities.read_model_version === undefined ||
      !isProtocolCompatible(capabilities.read_model_version, requiredReadModel));

  if (
    missingOperations.length === 0 && missingQueries.length === 0 &&
    missingFeatures.length === 0 && !readModelUnsatisfied
  ) {
    return { status: "compatible" };
  }
  return {
    status: "incompatible",
    reason: readModelUnsatisfied && missingOperations.length === 0 &&
        missingQueries.length === 0 && missingFeatures.length === 0
      ? "port が要求された read model version を宣言していない"
      : "要求された capability が port に存在しない",
    missing_operations: missingOperations,
    missing_queries: missingQueries,
    missing_features: missingFeatures,
    ...(readModelUnsatisfied && requiredReadModel !== undefined
      ? { required_read_model_version: requiredReadModel }
      : {}),
  };
}
