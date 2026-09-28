// state transition。許可表に無い遷移は rejected とし、同じ status への再適用だけ noop にする。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentKind,
  type ComponentStatus,
  type TaskStatus,
  type WishStatus,
} from "./components.ts";

const WISH_TRANSITIONS: Readonly<Record<WishStatus, readonly WishStatus[]>> = {
  registered_draft: ["plan"],
  plan: ["ready", "pending", "dropped"],
  ready: ["pending", "doing", "dropped"],
  pending: ["ready", "dropped"],
  doing: ["done", "dropped"],
  done: [],
  dropped: [],
};

// `dropped` は各 active status から到達する terminal (user 裁定 2026-09-22、Wish の `dropped`
// と対称)。鎖の途中に置かず、どこからでも 1 step で入る別の終端とする。
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  plan: ["ready", "dropped"],
  ready: ["doing", "dropped"],
  doing: ["done", "dropped"],
  done: [],
  dropped: [],
};

export const WISH_TERMINAL_STATUSES: readonly WishStatus[] = ["done", "dropped"];
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "dropped"];

/** transition の評価結果。command 層でそのまま disposition へ写す。 */
export type TransitionOutcome =
  | { readonly kind: "applied"; readonly next: ComponentStatus }
  | { readonly kind: "noop"; readonly next: ComponentStatus }
  | {
    readonly kind: "rejected";
    readonly reason: string;
    readonly code: "illegal_transition" | "terminal_status";
  };

export function wishTransitionTargets(from: WishStatus): readonly WishStatus[] {
  return WISH_TRANSITIONS[from];
}

export function taskTransitionTargets(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export function isTerminalWishStatus(status: WishStatus): boolean {
  return WISH_TERMINAL_STATUSES.includes(status);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}

export function evaluateWishTransition(from: WishStatus, to: WishStatus): TransitionOutcome {
  if (from === to) return { kind: "noop", next: to };
  if (isTerminalWishStatus(from)) {
    return {
      kind: "rejected",
      code: "terminal_status",
      reason: `wish は ${from} で terminal のため ${to} へ遷移できない`,
    };
  }
  if (!WISH_TRANSITIONS[from].includes(to)) {
    return {
      kind: "rejected",
      code: "illegal_transition",
      reason: `wish の ${from} -> ${to} は許可されていない`,
    };
  }
  return { kind: "applied", next: to };
}

export function evaluateTaskTransition(from: TaskStatus, to: TaskStatus): TransitionOutcome {
  if (from === to) return { kind: "noop", next: to };
  if (isTerminalTaskStatus(from)) {
    return {
      kind: "rejected",
      code: "terminal_status",
      reason: `task は ${from} で terminal のため ${to} へ遷移できない`,
    };
  }
  if (!TASK_TRANSITIONS[from].includes(to)) {
    return {
      kind: "rejected",
      code: "illegal_transition",
      reason: `task の ${from} -> ${to} は許可されていない`,
    };
  }
  return { kind: "applied", next: to };
}

/**
 * 登録直後の status。
 * Task が Wish 所有で作られる場合も plan から始まり、doit の開始で ready へ進む。
 */
export function initialStatus(kind: ComponentKind): ComponentStatus | undefined {
  switch (kind) {
    case "mind":
      return undefined;
    case "wish":
      return "registered_draft";
    case "task":
      return "plan";
  }
}

/**
 * Task がすべて done でも Wish を自動で done にしない。
 * satisfaction assessment は Slice A の対象外なので、判定の入口だけ明示して false を返す。
 *
 * **これは自動導出の禁止であって、手動の口の禁止ではない** (裁定 root PM 2026-09-20)。むしろ
 * 自動で done にしない以上、doing -> done へ到達する手動 operation が要る。`wish.complete` が
 * その口で、`OPERATION_TRANSITIONS` から `evaluateWishTransition` を通る。
 */
export function canAutoCompleteWish(_allTasksDone: boolean): Result<false> {
  return ok(false);
}

/** kind を跨ぐ transition 評価。kind と status の組が合わない場合は失敗にする。 */
export function evaluateTransition(
  kind: ComponentKind,
  from: ComponentStatus,
  to: ComponentStatus,
): Result<TransitionOutcome> {
  if (kind === "mind") {
    return err("unexpected_status", "Mind は status を持たないため transition を評価できない");
  }
  if (kind === "wish") {
    if (!isWishStatus(from) || !isWishStatus(to)) {
      return err("status_not_allowed_for_kind", "wish に許されない status が指定された");
    }
    return ok(evaluateWishTransition(from, to));
  }
  if (!isTaskStatus(from) || !isTaskStatus(to)) {
    return err("status_not_allowed_for_kind", "task に許されない status が指定された");
  }
  return ok(evaluateTaskTransition(from, to));
}

function isWishStatus(status: ComponentStatus): status is WishStatus {
  return status in WISH_TRANSITIONS;
}

function isTaskStatus(status: ComponentStatus): status is TaskStatus {
  return status in TASK_TRANSITIONS;
}
