// 実 vault へ書く component ID の形 (裁定 2026-09-15、root PM)。
//
// **正本は `~/.config/ai-agents/instructions/my-wish-data.md` の `id` 節。**
//
// - 書式は `<prefix>-` + Crockford base32 10 桁。ULID の timestamp 部と同じ 48bit で時系列に並ぶ。
// - prefix は `m` (mind) / `w` (wish) / `t` (task)。例: `t-01M0RQPF3K`。
// - 発番点は 1 つに集約する。
//
// **内部 DB / fixture / 自動 test の ID は現行のまま** (`c-<operation_id>`)。この file が要るのは、
// 実 vault へ register する ID を vault の規則に揃えるため。**1 つの vault で 2 つの形を混ぜない。**

import { err, ok, type Result } from "./result.ts";
import type { ComponentKind } from "./components.ts";
import { type ComponentId, parseComponentId } from "./ids.ts";

/** kind ごとの prefix。`my-wish-data.md` の `id` 節が定める 3 つ。 */
export const VAULT_ID_PREFIXES: Readonly<Record<ComponentKind, string>> = {
  mind: "m",
  wish: "w",
  task: "t",
};

/** Crockford base32 の符号表。`I` / `L` / `O` / `U` を持たない。 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48bit を 10 桁で表す。10 桁 * 5bit = 50bit なので 48bit が収まる。 */
export const VAULT_ID_BODY_LENGTH = 10;
const MAX_TIMESTAMP = 2 ** 48 - 1;

const VAULT_ID_PATTERN = new RegExp(
  `^[mwt]-[${CROCKFORD}]{${VAULT_ID_BODY_LENGTH}}$`,
);

/**
 * 48bit の epoch ミリ秒を Crockford base32 10 桁へ符号化する。
 *
 * **時系列に並ぶことが要件。**固定長の big-endian にするので、文字列の辞書順が時刻順と一致する。
 */
export function encodeVaultTimestamp(epochMillis: number): Result<string> {
  if (!Number.isInteger(epochMillis) || epochMillis < 0 || epochMillis > MAX_TIMESTAMP) {
    return err(
      "invalid_id",
      `vault ID の timestamp は 0 以上 ${MAX_TIMESTAMP} 以下の整数である必要がある: ${epochMillis}`,
      "epoch_millis",
    );
  }
  let remaining = epochMillis;
  let text = "";
  for (let i = 0; i < VAULT_ID_BODY_LENGTH; i += 1) {
    text = `${CROCKFORD[remaining % 32] ?? "0"}${text}`;
    remaining = Math.floor(remaining / 32);
  }
  return ok(text);
}

/** `<prefix>-<10 桁>` を組み立てる。 */
export function formatVaultComponentId(
  kind: ComponentKind,
  epochMillis: number,
): Result<ComponentId> {
  const body = encodeVaultTimestamp(epochMillis);
  if (!body.ok) return body;
  return parseComponentId(`${VAULT_ID_PREFIXES[kind]}-${body.value}`, "component_id");
}

/** vault の規則に合う形か。**内部形 (`c-...`) はここで false になる。** */
export function isVaultComponentId(value: string): boolean {
  return VAULT_ID_PATTERN.test(value);
}

/**
 * 既存の vault ID を指定した登録 (bugfix 6) のための parse。
 *
 * **形の判定は `VAULT_ID_PATTERN` (`isVaultComponentId`) だけを使う。** 別の regex を増やさない。
 * prefix と kind の対応は `VAULT_ID_PREFIXES` が正本で、食い違う入力
 * (`kind: wish` に `t-...` など) は `component_id_kind_mismatch` で拒否する。
 */
export function parseVaultComponentIdForKind(
  kind: ComponentKind,
  value: unknown,
  path?: string,
): Result<ComponentId> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "component_id は string である必要がある", path);
  }
  if (!isVaultComponentId(value)) {
    return err(
      "invalid_id",
      `component_id が vault 形 (<m|w|t>-<Crockford base32 ${VAULT_ID_BODY_LENGTH} 桁>) でない: ${
        JSON.stringify(value)
      }`,
      path,
    );
  }
  const prefix = VAULT_ID_PREFIXES[kind];
  if (!value.startsWith(`${prefix}-`)) {
    return err(
      "component_id_kind_mismatch",
      `component_id ${value} の prefix が kind ${kind} (${prefix}-) と一致しない`,
      path,
    );
  }
  return parseComponentId(value, path);
}

/**
 * 既に使われている ID を避けながら 1 件採番する。
 *
 * **body は timestamp だけなので、同じミリ秒に 2 件作ると衝突する。**`my-wish-data.md` が
 * 「ULID の timestamp 部と同じ 48bit」と定めており、randomness を持つ形ではない。衝突を
 * 乱数で避ける形へ勝手に変えず、**空いている次のミリ秒まで進める** (ULID の monotonic 採番と
 * 同じ考え方)。時系列順は保たれる。
 *
 * `taken` は「その ID が既に存在するか」。repo-local store が答える。
 */
export function allocateVaultComponentId(
  kind: ComponentKind,
  epochMillis: number,
  taken: (candidate: ComponentId) => boolean,
  limit = 1000,
): Result<ComponentId> {
  for (let offset = 0; offset < limit; offset += 1) {
    const candidate = formatVaultComponentId(kind, epochMillis + offset);
    if (!candidate.ok) return candidate;
    if (!taken(candidate.value)) return candidate;
  }
  return err(
    "invalid_id",
    `vault ID を ${limit} ミリ秒分探しても空きが無い (kind=${kind})`,
    "component_id",
  );
}

/**
 * sprint ID の採番 (schema 8)。`sp-<Crockford base32 10 桁>` — vault component の
 * prefix 系 (`m-`/`w-`/`t-`) の外。採番方式は `allocateVaultComponentId` と同じく
 * timestamp + 衝突スキップ。replay の同一性は ledger が持つ。
 */
export function allocateSprintId(
  epochMillis: number,
  taken: (candidate: string) => boolean,
  limit = 1000,
): Result<string> {
  for (let offset = 0; offset < limit; offset += 1) {
    const body = encodeVaultTimestamp(epochMillis + offset);
    if (!body.ok) return body;
    const candidate = `sp-${body.value}`;
    if (!taken(candidate)) return ok(candidate);
  }
  return err(
    "invalid_id",
    `sprint ID を ${limit} ミリ秒分探しても空きが無い`,
    "sprint_id",
  );
}
