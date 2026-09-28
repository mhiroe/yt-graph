// repository context と identity handshake。
// repo path は locator であり identity ではない。clone / rename / 別 device でも repository_id を維持する。

import { ok, type Result } from "./result.ts";
import { type DeviceId, parseDeviceId, parseRepositoryId, type RepositoryId } from "./ids.ts";
import {
  type CapabilityNegotiation,
  type CapabilityRequirement,
  negotiateCapabilities,
  type WorkflowCapabilities,
} from "./capabilities.ts";

/** 一つの repo へ scope された実行文脈。WorkflowPort instance は必ずこの単位になる。 */
export type RepositoryContext = {
  readonly repository_id: RepositoryId;
  readonly device_id: DeviceId;
};

export function createRepositoryContext(
  repositoryId: unknown,
  deviceId: unknown,
): Result<RepositoryContext> {
  const parsedRepository = parseRepositoryId(repositoryId, "repository_id");
  if (!parsedRepository.ok) return parsedRepository;
  const parsedDevice = parseDeviceId(deviceId, "device_id");
  if (!parsedDevice.ok) return parsedDevice;
  return ok({ repository_id: parsedRepository.value, device_id: parsedDevice.value });
}

/** wishboard の RepoRegistry が持つ設定側の entry。locator は接続先の解決にだけ使う。 */
export type ConfiguredRepository = {
  readonly repository_id: RepositoryId;
  readonly display_name?: string;
  readonly locator: string;
};

export type HandshakeInput = {
  readonly configured: ConfiguredRepository;
  /** WorkflowPort が実際に返した capability。ここに actual repository_id が入る。 */
  readonly actual: WorkflowCapabilities;
  /** 既に active registry にある repository_id。重複 entry を拒否するために渡す。 */
  readonly already_registered?: readonly RepositoryId[];
  readonly requirement?: CapabilityRequirement;
};

export type HandshakeResult =
  | {
    readonly status: "accepted";
    readonly repository_id: RepositoryId;
    readonly capabilities: WorkflowCapabilities;
  }
  | {
    readonly status: "rejected";
    readonly code:
      | "repository_id_mismatch"
      | "duplicate_repository_entry"
      | "protocol_incompatible";
    readonly reason: string;
    readonly negotiation?: CapabilityNegotiation;
  };

/**
 * configured repository ID と Port が返す actual ID を照合する。
 * 不一致と重複 entry では接続しない。推測 merge もしない。
 */
export function handshakeRepository(input: HandshakeInput): HandshakeResult {
  const configuredId = input.configured.repository_id;
  const actualId = input.actual.repository_id;
  if (configuredId !== actualId) {
    return {
      status: "rejected",
      code: "repository_id_mismatch",
      reason: `configured ${configuredId} と actual ${actualId} が一致しない`,
    };
  }
  if ((input.already_registered ?? []).includes(actualId)) {
    return {
      status: "rejected",
      code: "duplicate_repository_entry",
      reason: `repository ${actualId} は既に registry にある`,
    };
  }
  if (input.requirement !== undefined) {
    const negotiation = negotiateCapabilities(input.actual, input.requirement);
    if (negotiation.status === "incompatible") {
      return {
        status: "rejected",
        code: "protocol_incompatible",
        reason: negotiation.reason,
        negotiation,
      };
    }
  }
  return { status: "accepted", repository_id: actualId, capabilities: input.actual };
}

/**
 * runtime state は一つの connected flag へ潰さない。
 * query / event / document を別々に持ち、coverage 判断へ使う。
 */
export type QueryRuntimeState = "ready" | "unavailable" | "incompatible";
export type EventRuntimeState = "live" | "reconnecting" | "stale";
export type DocumentRuntimeState = "ready" | "unavailable";

export type RepositoryRuntimeState = {
  readonly repository_id: RepositoryId;
  readonly query: QueryRuntimeState;
  readonly event: EventRuntimeState;
  readonly document: DocumentRuntimeState;
  readonly last_successful_query_at?: string;
  readonly stale_since?: string;
  readonly last_error?: string;
};

/** repo ごとの coverage。offline / stale / 未登録を「該当 data なし」と読み替えない。 */
export type RepositoryCoverage = {
  readonly repository_id: RepositoryId;
  readonly covered: boolean;
  readonly reason?: "unavailable" | "incompatible" | "stale";
};

export function coverageOf(state: RepositoryRuntimeState): RepositoryCoverage {
  if (state.query === "incompatible") {
    return { repository_id: state.repository_id, covered: false, reason: "incompatible" };
  }
  if (state.query === "unavailable") {
    return { repository_id: state.repository_id, covered: false, reason: "unavailable" };
  }
  if (state.event === "stale") {
    return { repository_id: state.repository_id, covered: false, reason: "stale" };
  }
  return { repository_id: state.repository_id, covered: true };
}

/** combined view は単一 revision を名乗らず、repo ごとの coverage vector を返す。 */
export type CoverageVector = readonly RepositoryCoverage[];

export function isCoverageComplete(vector: CoverageVector): boolean {
  return vector.every((entry) => entry.covered);
}

export function missingRepositories(vector: CoverageVector): readonly RepositoryId[] {
  return vector.filter((entry) => !entry.covered).map((entry) => entry.repository_id);
}
