// ComponentKind と status。unknown 値を既定値へ落とさず、必ず失敗として返す。

import { err, ok, type Result } from "./result.ts";
import type { ComponentAddress } from "./ids.ts";

export const COMPONENT_KINDS = ["mind", "wish", "task"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const WISH_STATUSES = [
  "registered_draft",
  "plan",
  "ready",
  "pending",
  "doing",
  "done",
  "dropped",
] as const;
export type WishStatus = (typeof WISH_STATUSES)[number];

// `dropped` は user 裁定 (2026-09-22、wish_workflow-v4) で足した terminal。各 active status から
// 到達でき、戻る transition は無い — Wish の `dropped` と同じ置き方。
export const TASK_STATUSES = ["plan", "ready", "doing", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Mind の status は未決。現時点では未設定だけを許し、
 * 暫定値を作って後から意味を変える事態を避ける。
 */
export type MindStatus = undefined;

export type ComponentStatus = WishStatus | TaskStatus;

export function parseComponentKind(value: unknown, path?: string): Result<ComponentKind> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "kind は string である必要がある", path);
  }
  const kind = COMPONENT_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    return err("unknown_component_kind", `未知の ComponentKind: ${JSON.stringify(value)}`, path);
  }
  return ok(kind);
}

export function parseWishStatus(value: unknown, path?: string): Result<WishStatus> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "status は string である必要がある", path);
  }
  const status = WISH_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    return err("unknown_status", `未知の WishStatus: ${JSON.stringify(value)}`, path);
  }
  return ok(status);
}

export function parseTaskStatus(value: unknown, path?: string): Result<TaskStatus> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "status は string である必要がある", path);
  }
  const status = TASK_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    return err("unknown_status", `未知の TaskStatus: ${JSON.stringify(value)}`, path);
  }
  return ok(status);
}

/**
 * kind と status の組を検証する。
 * mind は status を持たず、wish / task は kind ごとの union だけを受け付ける。
 */
export function parseStatusForKind(
  kind: ComponentKind,
  value: unknown,
  path?: string,
): Result<ComponentStatus | undefined> {
  if (kind === "mind") {
    if (value === undefined || value === null) return ok(undefined);
    return err(
      "unexpected_status",
      "MindStatus は未決であり、値を受け付けない",
      path,
    );
  }
  if (value === undefined || value === null) {
    return err("missing_status", `${kind} は status を必要とする`, path);
  }
  if (kind === "wish") {
    const parsed = parseWishStatus(value, path);
    if (!parsed.ok && parsed.error.code === "unknown_status" && isKnownStatusOfOtherKind(value)) {
      return err("status_not_allowed_for_kind", `wish に許されない status: ${String(value)}`, path);
    }
    return parsed;
  }
  const parsed = parseTaskStatus(value, path);
  if (!parsed.ok && parsed.error.code === "unknown_status" && isKnownStatusOfOtherKind(value)) {
    return err("status_not_allowed_for_kind", `task に許されない status: ${String(value)}`, path);
  }
  return parsed;
}

function isKnownStatusOfOtherKind(value: unknown): boolean {
  return typeof value === "string" &&
    (WISH_STATUSES as readonly string[]).includes(value);
}

/**
 * workflow state を保護する revision と、document projection の revision は別物。
 * document 側の観測は state_revision を進めない。
 */
export type Revision = number;

export function parseRevision(value: unknown, path?: string): Result<Revision> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return err("invalid_revision", "revision は 0 以上の整数である必要がある", path);
  }
  return ok(value);
}

/** Slice A が扱う component state。document projection は Slice C で足す。 */
export type ComponentState = {
  readonly address: ComponentAddress;
  readonly kind: ComponentKind;
  readonly status: ComponentStatus | undefined;
  readonly state_revision: Revision;
};
