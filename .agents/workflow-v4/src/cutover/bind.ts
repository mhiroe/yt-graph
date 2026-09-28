// cutover の結合 (workflow-apm plan Phase F step 7)。
//
// scan で分類した既存 `^m-` / `^w-` / `^t-` anchor を `registerExistingVaultComponent` で
// COMPONENTS へ結び、続けて initial projection (document projection observe) を流す。
//
// 不変条件:
//
// - **新しい ID を採番しない。** 採番は allocator 経路の仕事で、ここは既存 ID の結合だけ。
// - **重複 id は両方 skip して報告する** (推測 merge しない — domain invariant)。
// - **1 件の失敗で止まらない。** 悪い anchor は finding / error へ畳んで次へ進む。
// - **冪等。** 2 回目の実行は register が noop / lookup 済みになり、status 遷移も
//   現在値を見て足りない step だけを送る。

import { locateChildren } from "../children.ts";
import { parseCommand } from "../commands.ts";
import type { TaskStatus } from "../components.ts";
import { isTerminalTaskStatus } from "../transitions.ts";
import type { DocumentProjectionObservation, DocumentProjectionPort } from "../document.ts";
import { type ComponentId, parseComponentId, parseOperationId } from "../ids.ts";
import { formatProtocolVersion, WORKFLOW_PROTOCOL_VERSION } from "../protocol.ts";
import { registerExistingVaultComponent, runLocalCommand } from "../sql/transaction.ts";
import type { SqliteWorkflowStore } from "../sql/store.ts";
import { anchorIntent, type ScannedAnchor, type ScanResult } from "./scan.ts";

/** anchor 1 件に対する、失敗でない報告。 */
export type BindFinding = {
  readonly id: string;
  readonly category:
    | "invalid"
    | "foreign"
    | "unclaimed"
    | "duplicate"
    | "projection_skipped"
    | "status_unmapped"
    | "status_ahead";
  readonly detail: string;
};

/** anchor 1 件の処理で起きた失敗。bind は止まらず次へ進む。 */
export type BindError = {
  readonly id: string;
  readonly code: string;
  readonly message: string;
};

export type BindReport = {
  readonly files_scanned: number;
  readonly anchors_found: number;
  /** 今回の実行で COMPONENTS に新規登録された数。 */
  readonly registered: number;
  /** 既に COMPONENTS に在った数 (冪等再実行では全件こちら)。 */
  readonly already_bound: number;
  /** document projection の観測を流した数 (applied / noop を含む)。 */
  readonly observed: number;
  /** checkbox から復元した task status の遷移が適用された数。 */
  readonly status_transitions: number;
  readonly findings: readonly BindFinding[];
  readonly errors: readonly BindError[];
};

/**
 * checkbox の中身から目指す task status。`my-wish-data.md` が checkbox marker を
 * task state の正本と定めている。**知らない marker は推測で写さない** (status_unmapped)。
 */
const CHECKBOX_STATUS: Readonly<Record<string, TaskStatus>> = {
  " ": "plan",
  backlog: "plan",
  ready: "ready",
  doing: "doing",
  resume: "doing",
  x: "done",
  done: "done",
  checked: "done",
  // `[dropped]` の task (user 裁定 2026-09-22 で Task にも dropped status)。
  dropped: "dropped",
};

// `dropped` は鎖の一部ではない — 各 active status から 1 step で入る terminal。線形の
// TASK_ORDER には入れず、driveTaskStatus が別経路で処理する。
const TASK_ORDER: readonly TaskStatus[] = ["plan", "ready", "doing", "done"];

/** 各 status へ進める operation と、cutover 用の決定的 operation_id の prefix。 */
const STEP_OPERATION: Readonly<
  Record<Exclude<TaskStatus, "plan">, {
    readonly operation:
      | "task.request_ready"
      | "task.start_doing"
      | "task.complete"
      | "task.drop";
    readonly operation_id_prefix: string;
  }>
> = {
  ready: { operation: "task.request_ready", operation_id_prefix: "cutover-ready-" },
  doing: { operation: "task.start_doing", operation_id_prefix: "cutover-doing-" },
  done: { operation: "task.complete", operation_id_prefix: "cutover-done-" },
  dropped: { operation: "task.drop", operation_id_prefix: "cutover-drop-" },
};

const ACTOR = "cutover";

/**
 * task の status を checkbox の示す状態まで typed command で進める。
 *
 * **現在値を毎 step 読み直し、足りない step だけを送る。**途中まで進んだ task の再実行や、
 * 既に ready まで来ている component への再 bind で digest 不整合の再送にならない。
 */
function driveTaskStatus(
  store: SqliteWorkflowStore,
  componentId: ComponentId,
  target: TaskStatus,
  checkbox: string,
  errors: BindError[],
  findings: BindFinding[],
): number {
  let applied = 0;
  for (;;) {
    const current = store.lookup(componentId);
    if (current === undefined) {
      errors.push({
        id: componentId,
        code: "document_not_found",
        message: `component ${componentId} が register 直後に見つからない`,
      });
      return applied;
    }
    const currentStatus = current.status as TaskStatus;
    if (currentStatus === target) return applied;
    if (isTerminalTaskStatus(currentStatus)) {
      // terminal から出る transition は存在しない。黙って巻き戻さず、食い違いを報告する。
      findings.push({
        id: componentId,
        category: "status_ahead",
        detail: `stored status ${currentStatus} は terminal。checkbox [${checkbox}] の ` +
          `${target} へは移せないのでそのまま`,
      });
      return applied;
    }
    // `dropped` は線形の鎖に無い — 各 active status から task.drop 1 step で入る。
    // 鎖上の target では「現在値が先に進んでいる」= status_ahead。
    let next: Exclude<TaskStatus, "plan">;
    if (target === "dropped") {
      next = "dropped";
    } else {
      const currentIndex = TASK_ORDER.indexOf(currentStatus);
      const targetIndex = TASK_ORDER.indexOf(target);
      if (currentIndex >= targetIndex) {
        findings.push({
          id: componentId,
          category: "status_ahead",
          detail: `stored status ${currentStatus} が checkbox [${checkbox}] の ` +
            `${target} より先にある。戻す transition は無いのでそのまま`,
        });
        return applied;
      }
      next = TASK_ORDER[currentIndex + 1] as Exclude<TaskStatus, "plan">;
    }
    const step = STEP_OPERATION[next];
    const command = parseCommand({
      protocol_version: formatProtocolVersion(WORKFLOW_PROTOCOL_VERSION),
      repository_id: store.context.repository_id,
      operation_id: `${step.operation_id_prefix}${componentId}`,
      operation: step.operation,
      target_id: componentId,
      expected_revision: current.state_revision,
      actor_ref: ACTOR,
      source_device_id: store.context.device_id,
      // done への step は検証を verification に、dropped への step は理由を reason に残す
      // (task.drop は `wish.drop` と同じく reason フィールドを持つ)。
      payload: next === "done"
        ? { verification: `cutover bind: markdown checkbox [${checkbox}]` }
        : next === "dropped"
        ? { reason: `cutover bind: markdown checkbox [${checkbox}]` }
        : {},
    });
    if (!command.ok) {
      errors.push({ id: componentId, code: command.error.code, message: command.error.message });
      return applied;
    }
    const response = runLocalCommand(store, command.value);
    if (!response.ok) {
      errors.push({ id: componentId, code: response.error.code, message: response.error.message });
      return applied;
    }
    if (response.value.disposition !== "applied" && response.value.disposition !== "noop") {
      errors.push({
        id: componentId,
        code: response.value.disposition,
        message: `${step.operation} が ${response.value.disposition}`,
      });
      return applied;
    }
    if (response.value.disposition === "applied") applied += 1;
  }
}

/** register / observe 済みの component へ checkbox 由来の status を写す。 */
function applyCheckboxStatus(
  store: SqliteWorkflowStore,
  anchor: ScannedAnchor,
  componentId: ComponentId,
  errors: BindError[],
  findings: BindFinding[],
): number {
  if (anchor.node !== "task") return 0;
  const checkbox = anchor.checkbox_state ?? "";
  const component = store.lookup(componentId);
  if (component !== undefined && component.kind !== "task") {
    findings.push({
      id: anchor.id,
      category: "status_unmapped",
      detail: `checkbox 行の anchor だが component kind は ${component.kind}。` +
        `task status は写さない`,
    });
    return 0;
  }
  const target = CHECKBOX_STATUS[checkbox];
  if (target === undefined) {
    // 未知の marker は推測で写さない。
    findings.push({
      id: anchor.id,
      category: "status_unmapped",
      detail: `checkbox [${checkbox}] に対応する task status が無い。plan のまま`,
    });
    return 0;
  }
  return driveTaskStatus(store, componentId, target, checkbox, errors, findings);
}

/**
 * mind の観測だけが `children` の要素を projection へ写す。
 *
 * **`children` は file root node の frontmatter property。** `locateChildren` は file 全体の
 * frontmatter を読むので、heading node に付いた `^m-` anchor へ渡すと file 全体の children を
 * その mind の所属として誤写する。file root 以外の mind anchor には渡さない。
 */
function mindChildren(
  scan: ScanResult,
  anchor: ScannedAnchor,
): readonly string[] | undefined {
  if (anchor.kind_hint !== "mind") return undefined;
  if (anchor.node !== "file_root") return undefined;
  const raw = scan.sources.get(anchor.path);
  if (raw === undefined) return undefined;
  const property = locateChildren(raw);
  if (!property.ok) return undefined;
  return property.value.entries.map((entry) => entry.value);
}

/**
 * scan 結果を COMPONENTS へ結び、initial projection を流す。
 *
 * **失敗で throw しない。** 悪い anchor は `findings` / `errors` に畳んで続ける。
 * skip の順序は「推測しない」の実装: vault 形でない → `invalid`、owner の無い anchor →
 * `unclaimed`、2 か所に在る id → `duplicate` (両方 skip)。
 */
export function bindAnchors(
  store: SqliteWorkflowStore,
  projection: DocumentProjectionPort,
  scan: ScanResult,
): BindReport {
  const findings: BindFinding[] = [];
  const errors: BindError[] = [];
  let registered = 0;
  let alreadyBound = 0;
  let observed = 0;
  let statusTransitions = 0;

  const duplicates = new Set(scan.duplicates);
  const reportedDuplicate = new Set<string>();

  for (const anchor of scan.anchors) {
    if (anchorIntent(anchor) === "foreign") {
      // vault を意図しない foreign anchor (Excalidraw の element id 等)。結ばず、失敗にもしない。
      // unclaimed より先に見る — standalone の foreign anchor も「結ぶ対象ではない」。
      findings.push({
        id: anchor.id,
        category: "foreign",
        detail: `${anchor.locator} の id は vault の identity ではない (m/w/t prefix 無し)`,
      });
      continue;
    }
    if (anchor.node === "unclaimed") {
      findings.push({
        id: anchor.id,
        category: "unclaimed",
        detail: `${anchor.path} の standalone anchor はどの node の identity にも属さない`,
      });
      continue;
    }
    if (!anchor.vault_shaped) {
      // m/w/t prefix はあるが形が壊れている。vault を意図した書き損じなので失敗側で報告する。
      findings.push({
        id: anchor.id,
        category: "invalid",
        detail: `${anchor.locator} の id は vault 形 (<m|w|t>-<Crockford base32 10 桁>) でない`,
      });
      continue;
    }
    if (duplicates.has(anchor.id)) {
      if (!reportedDuplicate.has(anchor.id)) {
        reportedDuplicate.add(anchor.id);
        const locators = (scan.by_id.get(anchor.id) ?? []).map((entry) => entry.locator);
        findings.push({
          id: anchor.id,
          category: "duplicate",
          detail: `id が ${locators.length} か所にある (${locators.join(", ")})。両方 skip`,
        });
      }
      continue;
    }
    const kind = anchor.kind_hint;
    if (kind === undefined) {
      errors.push({
        id: anchor.id,
        code: "unknown_component_kind",
        message: `id ${anchor.id} の prefix から kind を決められない`,
      });
      continue;
    }
    const componentId = parseComponentId(anchor.id, "component_id");
    if (!componentId.ok) {
      errors.push({
        id: anchor.id,
        code: componentId.error.code,
        message: componentId.error.message,
      });
      continue;
    }

    const existing = store.lookup(componentId.value);
    if (existing !== undefined) {
      alreadyBound += 1;
      // 登録済みの kind と anchor の prefix が食い違うのは bind の失敗ではなく既存データの食い違い。
      if (existing.kind !== kind) {
        errors.push({
          id: anchor.id,
          code: "component_id_kind_mismatch",
          message: `登録済み kind ${existing.kind} が anchor の prefix (${kind}) と一致しない`,
        });
      }
    } else {
      const operationId = parseOperationId(`cutover-bind-${anchor.id}`, "operation_id");
      if (!operationId.ok) {
        errors.push({
          id: anchor.id,
          code: operationId.error.code,
          message: operationId.error.message,
        });
        continue;
      }
      const bound = registerExistingVaultComponent(store, {
        operation_id: operationId.value,
        component_id: anchor.id,
        kind,
        actor_ref: ACTOR,
        ...(anchor.title === undefined ? {} : { title: anchor.title }),
        locator: anchor.locator,
      });
      if (!bound.ok) {
        errors.push({ id: anchor.id, code: bound.error.code, message: bound.error.message });
        continue;
      }
      if (bound.value.disposition === "applied") {
        registered += 1;
      } else if (bound.value.disposition === "noop") {
        alreadyBound += 1;
      } else {
        errors.push({
          id: anchor.id,
          code: bound.value.disposition,
          message: `register が ${bound.value.disposition} で返った`,
        });
        continue;
      }
    }

    // initial projection (Phase F step 7 の後半)。body_hash が取れない anchor
    // (解決不能な task block、block anchor) を空 hash で観測しない — 空の観測を流すと
    // 「読めていない」が「空の本文」の記録と区別できなくなる。
    if (anchor.body_hash === undefined) {
      findings.push({
        id: anchor.id,
        category: "projection_skipped",
        detail: `${anchor.locator} の body_hash が取れないため observe を送らない`,
      });
    } else {
      const children = mindChildren(scan, anchor);
      const observation: DocumentProjectionObservation = {
        component_id: componentId.value,
        title: anchor.title ?? "",
        locator: anchor.locator,
        observed_hash: anchor.body_hash,
        ...(children === undefined ? {} : { children }),
      };
      const result = projection.observe(observation);
      if (!result.ok) {
        errors.push({ id: anchor.id, code: result.error.code, message: result.error.message });
      } else if (result.value.disposition === "not_found") {
        errors.push({
          id: anchor.id,
          code: "document_not_found",
          message: `observe 対象の component ${anchor.id} が COMPONENTS に無い`,
        });
      } else {
        observed += 1;
      }
    }

    statusTransitions += applyCheckboxStatus(store, anchor, componentId.value, errors, findings);
  }

  return {
    files_scanned: scan.sources.size,
    anchors_found: scan.anchors.length,
    registered,
    already_bound: alreadyBound,
    observed,
    status_transitions: statusTransitions,
    findings,
    errors,
  };
}
