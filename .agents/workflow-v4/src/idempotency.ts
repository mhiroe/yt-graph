// retry は同じ operation_id を使う。Core は request digest で「異なる command への ID 再利用」を拒否する。

import { err, ok, type Result } from "./result.ts";
import type { OperationId } from "./ids.ts";
import type { Command } from "./commands.ts";
import { formatProtocolVersion } from "./protocol.ts";
import type { CommandResponse } from "./responses.ts";

/**
 * digest の入力になる正規形。key を sorted にし、未設定 field を落とす。
 * 同じ意味の command が device や JSON 実装差で別 digest にならないようにする。
 */
export function canonicalCommandJson(command: Command): string {
  const canonical: Record<string, unknown> = {
    actor_ref: command.actor_ref,
    operation: command.operation,
    operation_id: command.operation_id,
    payload: canonicalize(command.payload),
    protocol_version: formatProtocolVersion(command.protocol_version),
    repository_id: command.repository_id,
    source_device_id: command.source_device_id,
  };
  if (command.expected_revision !== undefined) {
    canonical["expected_revision"] = command.expected_revision;
  }
  if (command.target_id !== undefined) canonical["target_id"] = command.target_id;
  return JSON.stringify(canonicalize(canonical));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) result[key] = canonicalize(item);
    return result;
  }
  return value;
}

const FNV_OFFSET_128 = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME_128 = 0x0000000001000000000000000000013bn;
const MASK_128 = (1n << 128n) - 1n;

/**
 * 依存を足さずに決定的な digest を作るため FNV-1a 128bit を使う。
 * SQLite slice では OPERATIONS.request_digest に同じ値を入れる。
 */
export function requestDigest(command: Command): string {
  const bytes = new TextEncoder().encode(canonicalCommandJson(command));
  let hash = FNV_OFFSET_128;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) * FNV_PRIME_128 & MASK_128;
  }
  return hash.toString(16).padStart(32, "0");
}

export type LedgerRecord = {
  readonly operation_id: OperationId;
  readonly request_digest: string;
  readonly canonical_request: string;
  readonly response?: CommandResponse;
};

export type LedgerOutcome =
  | { readonly kind: "fresh"; readonly record: LedgerRecord }
  /** 同じ command の再送。最初の response をそのまま返す。 */
  | { readonly kind: "replay"; readonly response: CommandResponse }
  /**
   * 受理済みだが response 未確定の再送。呼び出し側は待つか同じ transaction で確定させる。
   *
   * **`revoke()` があるので、この状態は「今まさに処理中」だけを表す** (裁定 7b 残余 2026-09-20)。
   * response を返せないと決まった admit は `revoke()` で畳むため、**「decide が失敗したまま
   * 残った claim」と「処理中」が同じ値にならない。**
   */
  | { readonly kind: "in_flight"; readonly record: LedgerRecord };

export interface OperationLedger {
  /** command を受理前に登録する。digest が違えば失敗にする。 */
  admit(command: Command): Result<LedgerOutcome>;
  /** 適用結果を確定する。以後の同一 operation_id はこの response を replay する。 */
  settle(operationId: OperationId, response: CommandResponse): Result<CommandResponse>;
  /**
   * response を持たない admit を畳む (裁定 7b 残余 2026-09-20)。
   *
   * **storage 側の規則をそのまま interface へ持ってきたものである。**`persistence.md`
   * 「Slice B の実測で確定したこと」が
   * **「transaction が途中で失敗したら claim row ごと rollback する。receipt が残らないので、
   * 同じ operation ID での再送が正しくやり直せる」**と決めており、SQLite 実装
   * (`sql/transaction.ts`) は decide が `Result` 失敗を返した時点で `ROLLBACK` している。
   * **この interface にはその口が無く、admit 済みのまま settle されない record が残った。**
   * 残ると receipt が永久に付かず、後から見て「response を失った」と区別が付かない。
   *
   * **settle 済みの record は畳めない。**畳めると receipt を消せてしまう。
   */
  revoke(operationId: OperationId): Result<true>;
  get(operationId: OperationId): LedgerRecord | undefined;
}

/** Slice A の in-memory 実装。Slice B で SQLite の OPERATIONS へ置き換える。 */
export class InMemoryOperationLedger implements OperationLedger {
  readonly #records = new Map<string, LedgerRecord>();

  admit(command: Command): Result<LedgerOutcome> {
    const digest = requestDigest(command);
    const canonical = canonicalCommandJson(command);
    const existing = this.#records.get(command.operation_id);
    if (existing === undefined) {
      const record: LedgerRecord = {
        operation_id: command.operation_id,
        request_digest: digest,
        canonical_request: canonical,
      };
      this.#records.set(command.operation_id, record);
      return ok({ kind: "fresh", record });
    }
    if (existing.request_digest !== digest || existing.canonical_request !== canonical) {
      return err(
        "operation_id_reused",
        `operation_id ${command.operation_id} が異なる request digest で再利用された`,
        "operation_id",
      );
    }
    return existing.response === undefined
      ? ok({ kind: "in_flight", record: existing })
      : ok({ kind: "replay", response: existing.response });
  }

  settle(operationId: OperationId, response: CommandResponse): Result<CommandResponse> {
    const existing = this.#records.get(operationId);
    if (existing === undefined) {
      return err("missing_field", `未登録の operation_id を settle できない: ${operationId}`);
    }
    if (existing.response !== undefined) return ok(existing.response);
    this.#records.set(operationId, { ...existing, response });
    return ok(response);
  }

  revoke(operationId: OperationId): Result<true> {
    const existing = this.#records.get(operationId);
    if (existing === undefined) {
      // **「もう無い」を成功にしない。**呼び出し側が別の ID を畳んだつもりでいる状態を隠す。
      return err("missing_field", `未登録の operation_id を revoke できない: ${operationId}`);
    }
    if (existing.response !== undefined) {
      // receipt を消す操作にしない。settle 済みは「結果が確定した」ので畳む対象ではない。
      return err(
        "operation_id_reused",
        `settle 済みの operation_id は revoke できない: ${operationId}`,
        "operation_id",
      );
    }
    this.#records.delete(operationId);
    return ok(true);
  }

  get(operationId: OperationId): LedgerRecord | undefined {
    return this.#records.get(operationId);
  }
}
