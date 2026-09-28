// WorkflowPort の version。local function、CLI、socket、FileExchange のどれで運んでも同じ意味にする。

import { err, ok, type Result } from "./result.ts";

export type ProtocolVersion = {
  readonly major: number;
  readonly minor: number;
};

/** Slice A candidate の protocol version。 */
export const WORKFLOW_PROTOCOL_VERSION: ProtocolVersion = { major: 4, minor: 0 };

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function formatProtocolVersion(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}`;
}

export function parseProtocolVersion(value: unknown, path?: string): Result<ProtocolVersion> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "protocol_version は string である必要がある", path);
  }
  const match = VERSION_PATTERN.exec(value);
  if (match === null) {
    return err(
      "unknown_protocol_version",
      `protocol_version の形式が不正: ${JSON.stringify(value)}`,
      path,
    );
  }
  return ok({ major: Number(match[1]), minor: Number(match[2]) });
}

/**
 * major が一致し、port 側の minor が client の要求以上なら互換とする。
 * 不明な version を互換側へ倒さない。
 */
export function isProtocolCompatible(
  portVersion: ProtocolVersion,
  clientRequires: ProtocolVersion,
): boolean {
  return portVersion.major === clientRequires.major && portVersion.minor >= clientRequires.minor;
}
