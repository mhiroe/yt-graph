// headless CLI の request dispatch。
//
// **この file は IO を持たない。** stdin / stdout / process / filesystem を触るのは `main.ts`。
// port を注入して呼べるので、CLI の request / response 形を process を起動せずに test できる。
//
// CLI は typed command、document operation、document projection observation を JSON で往復させる
// **薄い入口**である。interactive UI、daemon、HTTP server、generic SQL 経路を持たない。

import { err, ok, type Result, type WorkflowError } from "../result.ts";
import { type ComponentId, parseComponentId, parseOperationId, parseRepositoryId } from "../ids.ts";
import { type Command, parseCommand } from "../commands.ts";
import { WORKFLOW_PROTOCOL_VERSION } from "../protocol.ts";
import { parseRelationType } from "../relations.ts";
import type { WorkflowCapabilities } from "../capabilities.ts";
import {
  checkCreateFilePath,
  checkCreateTaskPath,
  type ChildLinkInput,
  type DocumentPort,
  type DocumentProjectionPort,
  parseDocumentLocator,
  parseDocumentProjectionObservation,
  parseRegionTarget,
} from "../document.ts";
import { type EventId, parseEventId } from "../ids.ts";
import { parseChildId, parseChildLink } from "../children.ts";
import {
  listMindWishLinks,
  type MindWishLinkView,
  readDocumentProjection,
} from "../sql/document_projection.ts";
import { parseJournalRecord } from "../replication.ts";
import type { SqliteWorkflowStore } from "../sql/store.ts";
import {
  type ComponentIdAllocator,
  registerExistingVaultComponent,
  runLocalCommand,
} from "../sql/transaction.ts";
import { parseComponentKind, parseRevision } from "../components.ts";
import { isVaultComponentId } from "../vault_ids.ts";
import { checkChildEntries } from "./check_children.ts";
import {
  hasNoPendingIntent,
  parseTargetReceiptProbe,
  type TargetReceiptProbe,
  unprobedTarget,
} from "../cross_repo.ts";
import { listCrossRepoIntents, projectCrossRepoIntents } from "../sql/cross_repo.ts";
import {
  applyJournalBatch,
  claimOutboxBatch,
  currentRepoCursorToken,
  DEFAULT_PUBLISH_BATCH,
  listOpenConflicts,
  listOutboxEventIds,
  listReplicationCursors,
  markPublished,
  markPublishFailed,
  pendingPublishCount,
} from "../sql/replication.ts";
import {
  isConventionalDb,
  manifestPath,
  manifestRepositoryId,
  provisionRepository,
} from "./provision.ts";
import { addRegistryEntry, loadRegistry, removeRegistryEntry } from "./repo_registry.ts";
import {
  loadRegistryEntries,
  resolveWishInRepositories,
  type WishRepositoryResolution,
} from "./mind_wish_resolver.ts";
import { scanRepository, type ScanResult, type VaultScanPort } from "../cutover/scan.ts";
import { bindAnchors, rebindComponent } from "../cutover/bind.ts";
import { auditCutover } from "../cutover/audit.ts";
import { isIterationOperation } from "../decide.ts";
import {
  activeLinkPath,
  currentLinkPath,
  iterationDirOf,
  type IterationFsPort,
  type IterationHistoryPort,
  type IterationInfo,
  type IterationProperties,
  iterationPropertiesOf,
  type IterationTreeFailure,
  memberLinkPath,
  parseIterationScope,
  planIterationRebuild,
  readIterationProperties,
  type ReconstructedIteration,
  relativeSymlinkTarget,
  validateComponentPath,
  validateIterationLabel,
} from "../iterations.ts";
import {
  activeIterationsOf,
  applyIterationRebuild,
  componentDocumentPaths,
  defaultIterationOf,
  effectiveIterationOf,
  effectiveIterationOfPath,
  iterationDocMembersOf,
  iterationMembersOf,
  listAllIterations,
  listIterations,
} from "../sql/iterations.ts";

/**
 * 終了 code。**安定させる。** 呼び出し側 (skill / script) が分岐に使う。
 *
 * - `0`: request を処理し、disposition が `applied` か `noop`。
 * - `1`: request を処理できなかった (usage、DB を開けない、identity 不一致)。
 * - `2`: request が contract に合わない (parse 失敗、未知の request kind)。
 * - `3`: request は処理したが disposition が `rejected` / `conflict` / `not_found`。
 *
 * `2` と `3` を分けるのは、前者が呼び出し側の bug で、後者が正当な domain の答えだから。
 * 同じ code にすると retry 判断ができない。
 */
export const CLI_EXIT_OK = 0;
export const CLI_EXIT_UNAVAILABLE = 1;
export const CLI_EXIT_BAD_REQUEST = 2;
export const CLI_EXIT_NOT_APPLIED = 3;

export type CliExitCode = 0 | 1 | 2 | 3;

export const CLI_REQUEST_KINDS = [
  "workflow.capabilities",
  "workflow.submit",
  // bugfix 6。実 vault に先にある `m-` / `w-` / `t-` の ID を採番せず指定して登録する口。
  // envelope の `kind` と衝突するので component kind は `component_kind` で受ける。
  "component.register_existing",
  "operation.get_receipt",
  // 7b gap 2。receipt を 1 件引く口しか無く、operation_id を失うと戻れなかった。
  "operation.list",
  "document.read_raw",
  // Slice F1 の gap。register 前に `expected_hash` を引く口と、observer 向けの node 一覧。
  "document.inspect_locator",
  "document.list_nodes",
  "document.register_component_id",
  "document.rename_title",
  "document.replace_region",
  // artifact 0.10.0。所属の正本 (親 node の `children` property) を読み書きする typed な口。
  "document.read_children",
  "document.attach_child",
  "document.detach_child",
  // bugfix 2。children の要素が node へ解決できるかの読み取り検査。**書き込まない。**
  // Core は vault root を知らないので、解決はこの層 (CLI + DocumentPort) が持つ。
  "document.check_children",
  "document.move_heading",
  // artifact 0.11.0。task の所属は checkbox 行の置き場なので、task を運ぶ口を別に持つ。
  "document.read_task",
  "document.move_task",
  "document_projection.observe",
  // `observe` は caller の組み立てた値を信じる。`rebind` は component_id だけを受け、
  // 観測を vault scan から導出する — drift 修復が手組みの locator/hash 推測に
  // 依存しないようにする口 (workflow.drift 再発の根治)。`vault_scan` 未注入は
  // `unsupported_feature`。
  "document_projection.rebind",
  // Slice D。Journal の中身は CLI が解釈せず、record を JSON のまま往復させる。
  "replication.publish_pending",
  "replication.mark_published",
  "replication.mark_failed",
  "replication.apply_journal",
  "replication.status",
  // Slice E。**CLI は他 repo の DB を開かない。** target repo の receipt は呼び出し側が
  // その repo の `operation.get_receipt` で引いて、`plan_recovery` へ渡す。
  "crossrepo.list_intents",
  "crossrepo.plan_recovery",
  // Slice F1 の gap。relation を読む口が 1 つも無く、確認が SQLite 直読みになっていた。
  "relation.list_outgoing",
  "relation.find_outgoing_to",
  // artifact 0.13.0。mind -> wish の所属 (mind の `children` の id 要素) の projection を読む口。
  // **書く口は持たない。**書くのは `document.attach_child` / `detach_child` と observer だけ。
  "mind_wish.list",
  // v4 provision contract。repository identity の manifest、device-local DB 置き場
  // (`.nosync`)、vault 側の repo registry を headless に整える口。`.nosync` 配下は
  // iCloud sync も git commit もされない。
  "repository.provision",
  "registry.add",
  "registry.list",
  "registry.remove",
  // workflow-apm plan Phase F step 7-8。実 vault に先に在る `^m-` / `^w-` / `^t-` anchor を
  // 走査し (scan)、採番せず COMPONENTS へ結んで initial projection を流し (bind)、
  // 結果を検査する (audit)。`vault_scan` port が無い環境では `unsupported_feature`。
  "cutover.scan",
  "cutover.bind",
  "cutover.audit",
  // iPhone write channel 向けの新規 file 作成 (component 採番 + Markdown 作成 +
  // COMPONENTS 登録 + initial projection を 1 request で)。
  "document.create_file",
  // Lane I (wish w-01M3N7RV5K)。planner が plan 時に task の document node を
  // mint/bind する口 — `task.start_doing` の anchor gate が要求する `path#^<task_id>`
  // locator を、dispatch された task が必ず持つようにする。
  "document.create_task",
  // iteration (schema 6)。write は `workflow.submit` の typed command が担う
  // (operation ledger に乗る)。ここにあるのは read と repair。repair は
  // `cutover.bind` と同じく DB へ直接書く CLI kind — replication Option A の裁定で
  // committed tree (dir / current link / generated frontmatter) が device を跨ぐ
  // carrier なので、空 DB の再構築 (tree -> DB) と派生 fs の組み直し (DB -> fs) の
  // 両方を担う。
  "iteration.list",
  "iteration.current",
  "iteration.repair",
] as const;
export type CliRequestKind = (typeof CLI_REQUEST_KINDS)[number];

export type CliResponse = {
  readonly kind: string;
  readonly ok: boolean;
  readonly exit_code: CliExitCode;
  readonly result?: unknown;
  readonly error?: WorkflowError;
};

export type CliPorts = {
  readonly store: SqliteWorkflowStore;
  readonly capabilities: WorkflowCapabilities;
  readonly document: DocumentPort;
  readonly projection: DocumentProjectionPort;
  /**
   * component ID の採番 (裁定 root PM 2026-09-15)。
   *
   * 未設定なら `runLocalCommand` の既定 (`c-<operation_id>`) を使う。**実 vault へ書く入口
   * (`cli/main.ts`) は vault 形の allocator を渡す。** 内部 DB / fixture / 自動 test は
   * 既定のままでよい。
   */
  readonly allocate_component_id?: ComponentIdAllocator;
  /**
   * repo root の絶対 path (v4 provision contract)。`repository.provision` / `registry.*` が
   * manifest と `.nosync` 配下を触るのに使う。**未設定ならこれらの kind は `missing_field`。**
   */
  readonly root?: string;
  /**
   * 実際に開いた DB の path。`repository.provision` が conventional path と違うことを
   * 呼び出し側へ報告するのに使う。
   */
  readonly db?: string;
  /**
   * cutover の Markdown 走査口 (workflow-apm Phase F step 7-8)。
   *
   * **dispatch は IO を持たない。** file 一覧と本文は `cli/main.ts` が
   * `createFsVaultScan(root)` で注入する。未設定なら `cutover.*` kind は
   * `unsupported_feature` (exit 1)。
   */
  readonly vault_scan?: VaultScanPort;
  /**
   * iteration の fs side effect (schema 6)。skeleton dir と `current` / member
   * symlink を担う。`cli/main.ts` が `createFsIterationPort(root)` で注入する。
   *
   * **未設定でも command は受理する** — DB が正本で fs は派生なので、port が無い
   * 環境では fs 側を飛ばして `iteration.repair` で後追いできる。
   */
  readonly iteration_fs?: IterationFsPort;
  /**
   * iteration.repair の first-commit metadata 口 (0.24.0-era recipe)。
   * `cli/main.ts` が `createGitIterationHistory(root)` で注入する。
   *
   * **未注入なら stamp を持たない iteration の復元は従来どおり fail closed** —
   * seq / created_at を invent しない。
   */
  readonly iteration_history?: IterationHistoryPort;
};

function failure(kind: string, error: WorkflowError, exit: CliExitCode): CliResponse {
  return { kind, ok: false, exit_code: exit, error };
}

/** disposition から exit code を決める。`applied` / `noop` だけを 0 にする。 */
function exitForDisposition(disposition: string): CliExitCode {
  return disposition === "applied" || disposition === "noop" ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED;
}

function requireString(raw: Record<string, unknown>, name: string): Result<string> {
  const value = raw[name];
  if (typeof value !== "string") {
    return err("invalid_field_type", `${name} は string である必要がある`, name);
  }
  return ok(value);
}

/**
 * provision / registry kind は repo root なしでは動けない。未注入は request payload の bug
 * ではなく呼び出し側の設定不足だが、contract 上は `missing_field` で落とす。
 */
function requireRoot(ports: CliPorts): Result<string> {
  if (ports.root === undefined) {
    return err(
      "missing_field",
      "この request kind には repo root が必要 (ports.root 未設定)",
      "root",
    );
  }
  return ok(ports.root);
}

/**
 * 予期しない IO 失敗を例外で逃がさず CliResponse へ畳む。manifest / registry の読み書きは
 * 想定内の失敗 (無い・壊れている・id 違い) を Result で返すので、ここへ来るのは permission
 * 等の想定外だけ。開けない DB と同じく `unavailable` (exit 1) として扱う。
 */
function ioFailure(kind: string, cause: unknown): CliResponse {
  return failure(
    kind,
    { code: "missing_field", message: `IO に失敗した: ${String(cause)}` },
    CLI_EXIT_UNAVAILABLE,
  );
}

/**
 * `vault_scan` port で repo 全体を走査する。file の読み取り失敗は crash にせず
 * `unreadable` へ畳む。`cutover.*` と `document_projection.rebind` が共有する入口 —
 * 両者が同じ scan 導出を見ることを保証する。
 */
function scanVault(vaultScan: VaultScanPort): {
  readonly scan: ScanResult;
  readonly unreadable: { path: string; message: string }[];
} {
  const scannedFiles: { path: string; raw: string }[] = [];
  const unreadable: { path: string; message: string }[] = [];
  for (const path of vaultScan.files()) {
    const text = vaultScan.read(path);
    if (!text.ok) {
      unreadable.push({ path, message: text.error.message });
      continue;
    }
    scannedFiles.push({ path, raw: text.value });
  }
  return { scan: scanRepository(scannedFiles), unreadable };
}

/**
 * request 1 件を処理する。**例外を投げない。** 失敗はすべて `CliResponse` として返す。
 * stdout には必ずこの object が 1 つ出る。
 */
export function dispatch(ports: CliPorts, request: unknown): CliResponse {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return failure(
      "unknown",
      { code: "invalid_field_type", message: "request は object である必要がある" },
      CLI_EXIT_BAD_REQUEST,
    );
  }
  const raw = request as Record<string, unknown>;
  const kindRaw = raw["kind"];
  const kind = CLI_REQUEST_KINDS.find((candidate) => candidate === kindRaw);
  if (kind === undefined) {
    return failure(
      typeof kindRaw === "string" ? kindRaw : "unknown",
      {
        code: "unknown_request_kind",
        message: `未知の request kind: ${JSON.stringify(kindRaw)}`,
        path: "kind",
      },
      CLI_EXIT_BAD_REQUEST,
    );
  }

  switch (kind) {
    case "workflow.capabilities":
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: ports.capabilities };

    case "workflow.submit": {
      const parsed = parseCommand(raw["command"]);
      if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
      // `iteration.open` の dir 衝突は DB commit 前に閉じる (裁定: target dir が在れば
      // fail closed)。fs は transaction に乗らないので、ここで先に見て、既存 dir への
      // open は ledger に残さず conflict で返す。
      if (
        parsed.value.operation === "iteration.open" && ports.iteration_fs !== undefined
      ) {
        const collision = iterationDirCollision(ports.iteration_fs, parsed.value);
        if (collision !== undefined) {
          return {
            kind,
            ok: true,
            exit_code: CLI_EXIT_NOT_APPLIED,
            result: {
              operation_id: parsed.value.operation_id,
              repository_id: parsed.value.repository_id,
              disposition: "conflict",
              reason: collision,
            },
          };
        }
      }
      const response = runLocalCommand(
        ports.store,
        parsed.value,
        ports.allocate_component_id === undefined
          ? {}
          : { allocate_component_id: ports.allocate_component_id },
      );
      if (!response.ok) return failure(kind, response.error, CLI_EXIT_BAD_REQUEST);
      // iteration command の fs 側 (skeleton / symlink / frontmatter) は DB commit 後の
      // 派生作業。失敗しても command の成否は変えず、warning に残して repair へ委ねる。
      const iterationWarnings = response.value.disposition === "applied" &&
          isIterationOperation(parsed.value.operation) &&
          response.value.iteration !== undefined
        ? applyIterationFsEffects(ports, parsed.value.operation, response.value.iteration)
        : [];
      // `component.register` で iteration dir 内に生まれた node へ generated key を刻む。
      // file は既に存在する (register は file を作らない) ので upsert 経路。membership は
      // component-keyed (`iteration_members`) なので component_id を渡す。
      if (
        response.value.disposition === "applied" &&
        parsed.value.operation === "component.register"
      ) {
        const locator = parsed.value.payload["locator"];
        const createdId = response.value.created_ids?.[0]?.component_id;
        if (typeof locator === "string" && createdId !== undefined) {
          const warning = stampIterationFile(
            ports,
            locator.split("#", 1)[0] ?? locator,
            createdId,
          ).warning;
          if (warning !== undefined) iterationWarnings.push(warning);
        }
      }
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(response.value.disposition),
        result: iterationWarnings.length === 0
          ? response.value
          : { ...response.value, iteration_fs_warnings: iterationWarnings },
      };
    }

    case "component.register_existing": {
      const operationId = parseOperationId(raw["operation_id"], "operation_id");
      if (!operationId.ok) return failure(kind, operationId.error, CLI_EXIT_BAD_REQUEST);
      const componentKind = parseComponentKind(raw["component_kind"], "component_kind");
      if (!componentKind.ok) return failure(kind, componentKind.error, CLI_EXIT_BAD_REQUEST);
      const componentId = requireString(raw, "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      // optional field は指定されていれば string だけを受ける。既定値へ倒さない。
      const optional: Record<string, string> = {};
      for (const name of ["actor_ref", "title", "locator", "correlation_id"] as const) {
        const value = raw[name];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          return failure(kind, {
            code: "invalid_field_type",
            message: `${name} は string である必要がある`,
            path: name,
          }, CLI_EXIT_BAD_REQUEST);
        }
        optional[name] = value;
      }
      const registered = registerExistingVaultComponent(ports.store, {
        operation_id: operationId.value,
        component_id: componentId.value,
        kind: componentKind.value,
        actor_ref: optional["actor_ref"] ?? "cli",
        ...(optional["title"] === undefined ? {} : { title: optional["title"] }),
        ...(optional["locator"] === undefined ? {} : { locator: optional["locator"] }),
        ...(optional["correlation_id"] === undefined
          ? {}
          : { correlation_id: optional["correlation_id"] }),
      });
      if (!registered.ok) return failure(kind, registered.error, CLI_EXIT_BAD_REQUEST);
      // iteration dir 内の既存 file を登録した時は generated key を刻む。
      // commit 後の DB から導出するので、file 側の書き込み失敗は command の成否にしない。
      const iterationWarnings: string[] = [];
      if (
        registered.value.disposition === "applied" && optional["locator"] !== undefined
      ) {
        const path = optional["locator"].split("#", 1)[0] ?? optional["locator"];
        const componentIdParsed = parseComponentId(componentId.value, "component_id");
        if (componentIdParsed.ok) {
          const warning = stampIterationFile(ports, path, componentIdParsed.value).warning;
          if (warning !== undefined) iterationWarnings.push(warning);
        }
      }
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(registered.value.disposition),
        result: iterationWarnings.length === 0
          ? registered.value
          : { ...registered.value, iteration_fs_warnings: iterationWarnings },
      };
    }

    case "operation.get_receipt": {
      const operationId = parseOperationId(raw["operation_id"], "operation_id");
      if (!operationId.ok) return failure(kind, operationId.error, CLI_EXIT_BAD_REQUEST);
      const receipt = ports.store.getReceipt(operationId.value);
      if (receipt === undefined) {
        return failure(
          kind,
          {
            code: "document_not_found",
            message: `operation ${operationId.value} の receipt が無い`,
            path: "operation_id",
          },
          CLI_EXIT_NOT_APPLIED,
        );
      }
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: receipt };
    }

    case "operation.list": {
      // **絞り込みは全部 optional。**「何を送ったか」を覚えていない client が入口なので、
      // 引数無しでも新しい順に引ける必要がある。
      const componentId = raw["component_id"] === undefined
        ? undefined
        : parseComponentId(raw["component_id"], "component_id");
      if (componentId !== undefined && !componentId.ok) {
        return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      }
      const correlationRaw = raw["correlation_id"];
      if (correlationRaw !== undefined && typeof correlationRaw !== "string") {
        return failure(kind, {
          code: "invalid_field_type",
          message: "correlation_id は string である必要がある",
          path: "correlation_id",
        }, CLI_EXIT_BAD_REQUEST);
      }
      const unsettledRaw = raw["unsettled_only"];
      if (unsettledRaw !== undefined && typeof unsettledRaw !== "boolean") {
        return failure(kind, {
          code: "invalid_field_type",
          message: "unsettled_only は boolean である必要がある",
          path: "unsettled_only",
        }, CLI_EXIT_BAD_REQUEST);
      }
      const limitRaw = raw["limit"];
      if (
        limitRaw !== undefined &&
        (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1)
      ) {
        // **既定値へ倒さない。**壊れた limit を黙って 50 にすると、client は自分が要求した
        // 件数で切れたと読む。
        return failure(kind, {
          code: "invalid_field_type",
          message: "limit は 1 以上の整数である必要がある",
          path: "limit",
        }, CLI_EXIT_BAD_REQUEST);
      }
      const page = ports.store.listOperations({
        ...(componentId === undefined ? {} : { component_id: componentId.value }),
        ...(correlationRaw === undefined ? {} : { correlation_id: correlationRaw }),
        ...(unsettledRaw === undefined ? {} : { unsettled_only: unsettledRaw }),
        ...(limitRaw === undefined ? {} : { limit: limitRaw }),
      });
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: page };
    }

    case "document.read_raw": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const view = ports.document.readRaw(componentId.value);
      if (!view.ok) return failure(kind, view.error, CLI_EXIT_NOT_APPLIED);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: view.value };
    }

    case "document.inspect_locator": {
      const locator = parseDocumentLocator(raw["locator"], "locator");
      if (!locator.ok) return failure(kind, locator.error, CLI_EXIT_BAD_REQUEST);
      const view = ports.document.inspectLocator(locator.value);
      if (!view.ok) return failure(kind, view.error, CLI_EXIT_NOT_APPLIED);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: view.value };
    }

    case "document.list_nodes": {
      const path = requireString(raw, "path");
      if (!path.ok) return failure(kind, path.error, CLI_EXIT_BAD_REQUEST);
      const nodes = ports.document.listNodes(path.value);
      if (!nodes.ok) return failure(kind, nodes.error, CLI_EXIT_NOT_APPLIED);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: nodes.value };
    }

    case "relation.list_outgoing": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      // **存在しない component を「relation 0 本」で返さない。** 外れたのか元から無いのかが
      // 区別できなくなる。
      if (ports.store.lookup(componentId.value) === undefined) {
        return failure(kind, {
          code: "document_not_found",
          message: `component ${componentId.value} が無い`,
          path: "component_id",
        }, CLI_EXIT_NOT_APPLIED);
      }
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          component_id: componentId.value,
          outgoing: ports.store.outgoingRelations(componentId.value),
        },
      };
    }

    case "mind_wish.list": {
      const hasMind = raw["mind_component_id"] !== undefined;
      const hasWish = raw["wish_component_id"] !== undefined;
      if (hasMind === hasWish) {
        return failure(kind, {
          code: "invalid_field_type",
          message: "mind_component_id と wish_component_id のどちらか 1 つだけを渡す",
          path: hasMind ? "wish_component_id" : "mind_component_id",
        }, CLI_EXIT_BAD_REQUEST);
      }
      const field = hasMind ? "mind_component_id" : "wish_component_id";
      const id = parseComponentId(raw[field], field);
      if (!id.ok) return failure(kind, id.error, CLI_EXIT_BAD_REQUEST);
      // **存在しない mind を「所属 0 件」で返さない** (`relation.list_outgoing` と同じ)。wish 側は
      // 引く: 居ない wish を指す broken な要素を見つけるための口でもある。
      if (hasMind && ports.store.lookup(id.value) === undefined) {
        return failure(kind, {
          code: "document_not_found",
          message: `component ${id.value} が無い`,
          path: field,
        }, CLI_EXIT_NOT_APPLIED);
      }
      const links = listMindWishLinks(ports.store, { [field]: id.value }).map((link) =>
        link.state === "live" ? confirmWishDocument(ports, link) : link
      );
      // local の COMPONENTS に無い wish は、登録 repo の DB を read-time で舐めて解決する
      // (2 層 DB: vault が repo の上)。root 未注入の口では local 判定のまま返す。
      const enriched = links.some((link) => link.reason === "wish_not_registered") &&
          ports.root !== undefined
        ? resolveWishLinks(ports.root, links)
        : ok(links);
      if (!enriched.ok) return failure(kind, enriched.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          [field]: id.value,
          links: enriched.value,
          live_count: enriched.value.filter((link) => link.state === "live").length,
          broken_count: enriched.value.filter((link) => link.state === "broken").length,
        },
      };
    }

    case "relation.find_outgoing_to": {
      const from = parseComponentId(raw["from_component_id"], "from_component_id");
      if (!from.ok) return failure(kind, from.error, CLI_EXIT_BAD_REQUEST);
      const toRepository = requireString(raw, "to_repository_id");
      if (!toRepository.ok) return failure(kind, toRepository.error, CLI_EXIT_BAD_REQUEST);
      const toComponent = parseComponentId(raw["to_component_id"], "to_component_id");
      if (!toComponent.ok) return failure(kind, toComponent.error, CLI_EXIT_BAD_REQUEST);
      const relationType = parseRelationType(raw["relation_type"], "relation_type");
      if (!relationType.ok) return failure(kind, relationType.error, CLI_EXIT_BAD_REQUEST);
      if (ports.store.lookup(from.value) === undefined) {
        return failure(kind, {
          code: "document_not_found",
          message: `component ${from.value} が無い`,
          path: "from_component_id",
        }, CLI_EXIT_NOT_APPLIED);
      }
      const found = ports.store.outgoingRelations(from.value).find((relation) =>
        relation.target.repository_id === toRepository.value &&
        relation.target.component_id === toComponent.value &&
        relation.relation_type === relationType.value
      );
      return {
        kind,
        ok: true,
        // **「無い」も正常な答えなので exit 0。** 3 は「処理したが適用されなかった」で意味が違う。
        exit_code: CLI_EXIT_OK,
        result: {
          present: found !== undefined,
          ...(found === undefined ? {} : { relation: found }),
        },
      };
    }

    case "document.create_file": {
      // iPhone write channel の新規 file 作成口。component 採番 -> file 作成 ->
      // COMPONENTS 登録 -> initial projection を 1 request で閉じる。
      const operationId = parseOperationId(raw["operation_id"], "operation_id");
      if (!operationId.ok) return failure(kind, operationId.error, CLI_EXIT_BAD_REQUEST);
      const componentKind = parseComponentKind(raw["component_kind"], "component_kind");
      if (!componentKind.ok) return failure(kind, componentKind.error, CLI_EXIT_BAD_REQUEST);
      const filePath = requireString(raw, "path");
      if (!filePath.ok) return failure(kind, filePath.error, CLI_EXIT_BAD_REQUEST);
      const content = requireString(raw, "content");
      if (!content.ok) return failure(kind, content.error, CLI_EXIT_BAD_REQUEST);
      const scoped = checkCreateFilePath(filePath.value, "path");
      if (!scoped.ok) return failure(kind, scoped.error, CLI_EXIT_BAD_REQUEST);
      // id の発番点は Core の 1 つ。caller が component_id を渡す形は受けない。
      if (raw["component_id"] !== undefined) {
        return failure(kind, {
          code: "invalid_field_type",
          message: "component_id は受け付けない (Core が採番する)",
          path: "component_id",
        }, CLI_EXIT_BAD_REQUEST);
      }
      let actorRef = "cli";
      if (raw["actor_ref"] !== undefined) {
        const parsed = requireString(raw, "actor_ref");
        if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
        actorRef = parsed.value;
      }
      // allocator の注入が無いと default (`c-<op>`) が走り vault 形でない id になる。
      // Markdown anchor は vault 形だけなので、先に閉じて orphan component を残さない。
      const injectedAllocator = ports.allocate_component_id;
      if (injectedAllocator === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: "component_id allocator が無い環境では document.create_file は使えない",
          path: "component_id",
        }, CLI_EXIT_BAD_REQUEST);
      }

      // **先に register する。**同じ operation_id の再送は ledger が採番済みの同じ id を
      // 返すので、後続の createFile は「同じ anchor を持つ file が在る」noop に収まる。
      // file を先に書く順だと、register が落ちた時に id 不明の unclaimed anchor が残る。
      //
      // ただし初回で既存 path に当たるケースは、register すると file の無い orphan
      // component だけが残る。receipt が無い (= 初回) 時だけ vault_scan で存在を先に見て、
      // 他人の file に当たったなら register 前に conflict で止める。
      if (ports.store.getReceipt(operationId.value) === undefined) {
        const existing = ports.vault_scan?.read(scoped.value);
        if (existing?.ok) {
          return {
            kind,
            ok: true,
            exit_code: CLI_EXIT_NOT_APPLIED,
            result: {
              disposition: "conflict",
              locator: scoped.value,
              reason: `path は既に存在する (上書きしない): ${scoped.value}`,
            },
          };
        }
      }
      const title = filePath.value.split("/").at(-1)?.replace(/\.md$/i, "") ??
        filePath.value;
      const registerCommand: Command = {
        protocol_version: WORKFLOW_PROTOCOL_VERSION,
        repository_id: ports.store.context.repository_id,
        operation_id: operationId.value,
        operation: "component.register",
        actor_ref: actorRef,
        source_device_id: ports.store.context.device_id,
        payload: {
          kind: componentKind.value,
          title,
          locator: filePath.value,
        },
      };
      // Markdown の anchor は vault 形だけ。非 vault allocator を弾いて、
      // 採番済み component が残る半端な失敗にしない。
      const allocator: ComponentIdAllocator = (command) => {
        const allocated = injectedAllocator(command);
        if (allocated.ok && !isVaultComponentId(allocated.value)) {
          return err(
            "invalid_id",
            `採番された id が vault 形でない: ${allocated.value}`,
            "component_id",
          );
        }
        return allocated;
      };
      const registered = runLocalCommand(ports.store, registerCommand, {
        allocate_component_id: allocator,
      });
      if (!registered.ok) return failure(kind, registered.error, CLI_EXIT_BAD_REQUEST);
      const createdId = registered.value.created_ids[0]?.component_id;
      if (createdId === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: "component.register が id を返さなかった",
          path: "operation_id",
        }, CLI_EXIT_NOT_APPLIED);
      }

      // iteration dir 内に生まれた file には generated key を刻む (schema 6)。
      // register は commit 済みなので、effective iteration (birth + その scope の
      // current membership) を DB から導出する。dir の外なら key を出さない。
      const effectiveIteration = effectiveIterationOf(
        ports.store.driver,
        createdId,
        filePath.value,
      );
      const created = ports.document.createFile({
        path: scoped.value,
        component_id: createdId,
        component_kind: componentKind.value,
        content: content.value,
        ...(effectiveIteration === undefined
          ? {}
          : { iteration_properties: iterationPropertiesOf(effectiveIteration) }),
      });
      if (!created.ok) return failure(kind, created.error, CLI_EXIT_NOT_APPLIED);
      if (created.value.disposition === "conflict" || created.value.disposition === "rejected") {
        return {
          kind,
          ok: true,
          exit_code: exitForDisposition(created.value.disposition),
          result: created.value,
        };
      }
      if (created.value.observed_hash === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: "create_file が observed_hash を返さなかった",
          path: "path",
        }, CLI_EXIT_NOT_APPLIED);
      }
      const observed = ports.projection.observe({
        component_id: createdId,
        title,
        locator: filePath.value,
        observed_hash: created.value.observed_hash,
        // mind の file だけ children 観測を送る (projection の既定と同じ扱い)。
        ...(componentKind.value === "mind" ? { children: [] as string[] } : {}),
      });
      if (!observed.ok) return failure(kind, observed.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(created.value.disposition),
        result: {
          ...created.value,
          register: registered.value.disposition,
          projection: observed.value.disposition,
        },
      };
    }

    case "document.create_task": {
      // Lane I (wish w-01M3N7RV5K): `task.start_doing` の anchor gate が要求する
      // bound `^t-` locator を、planner が plan 時に 1 request で mint/bind する口。
      // `component_id` 無し = mint 経路 (task.create_planned -> checkbox 行 write ->
      // projection observe)、有り = bind-only 経路 (既存 Task への anchor 書き込み、
      // WA2 backfill / 再送修復が使う)。
      const operationId = parseOperationId(raw["operation_id"], "operation_id");
      if (!operationId.ok) return failure(kind, operationId.error, CLI_EXIT_BAD_REQUEST);
      const title = requireString(raw, "title");
      if (!title.ok) return failure(kind, title.error, CLI_EXIT_BAD_REQUEST);
      const locator = parseDocumentLocator(raw["locator"], "locator");
      if (!locator.ok) return failure(kind, locator.error, CLI_EXIT_BAD_REQUEST);
      // 置き先 file も scan / bind / audit の対象でなければならない。
      const scopedPath = checkCreateTaskPath(locator.value.path, "locator");
      if (!scopedPath.ok) return failure(kind, scopedPath.error, CLI_EXIT_BAD_REQUEST);
      const scopedLocator = { ...locator.value, path: scopedPath.value };
      let actorRef = "cli";
      if (raw["actor_ref"] !== undefined) {
        const parsed = requireString(raw, "actor_ref");
        if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
        actorRef = parsed.value;
      }

      let taskId: ComponentId;
      let plannedDisposition: string | undefined;
      if (raw["component_id"] !== undefined) {
        // bind-only 経路。採番はしない — mint 用 field との混在も受けない。
        if (
          raw["wish_component_id"] !== undefined ||
          raw["expected_revision"] !== undefined ||
          raw["iteration_id"] !== undefined
        ) {
          return failure(kind, {
            code: "invalid_field_type",
            message: "component_id と mint 用 field (wish_component_id / " +
              "expected_revision / iteration_id) は併用できない",
            path: "component_id",
          }, CLI_EXIT_BAD_REQUEST);
        }
        const parsed = parseComponentId(raw["component_id"], "component_id");
        if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
        const existing = ports.store.lookup(parsed.value);
        if (existing === undefined) {
          return failure(kind, {
            code: "document_not_found",
            message: `component ${parsed.value} が無い`,
            path: "component_id",
          }, CLI_EXIT_NOT_APPLIED);
        }
        if (existing.kind !== "task") {
          return failure(kind, {
            code: "invalid_field_type",
            message: `component_id は Task でなければならない (kind=${existing.kind})`,
            path: "component_id",
          }, CLI_EXIT_BAD_REQUEST);
        }
        taskId = parsed.value;
      } else {
        // mint 経路。`task.create_planned` が採番と PLANNED_TASK relation を
        // 1 transaction で確定する (component.register と同じく ledger で再送安全)。
        const wishId = parseComponentId(raw["wish_component_id"], "wish_component_id");
        if (!wishId.ok) return failure(kind, wishId.error, CLI_EXIT_BAD_REQUEST);
        const expectedRevision = parseRevision(
          raw["expected_revision"],
          "expected_revision",
        );
        if (!expectedRevision.ok) {
          return failure(kind, expectedRevision.error, CLI_EXIT_BAD_REQUEST);
        }
        const wish = ports.store.lookup(wishId.value);
        if (wish === undefined) {
          return failure(kind, {
            code: "document_not_found",
            message: `component ${wishId.value} が無い`,
            path: "wish_component_id",
          }, CLI_EXIT_NOT_APPLIED);
        }
        if (wish.kind !== "wish") {
          return failure(kind, {
            code: "invalid_field_type",
            message: `wish_component_id は Wish でなければならない (kind=${wish.kind})`,
            path: "wish_component_id",
          }, CLI_EXIT_BAD_REQUEST);
        }
        const injectedAllocator = ports.allocate_component_id;
        if (injectedAllocator === undefined) {
          return failure(kind, {
            code: "unsupported_feature",
            message: "component_id allocator が無い環境では document.create_task の" +
              " mint 経路は使えない (component_id を渡す bind-only 経路は使える)",
            path: "component_id",
          }, CLI_EXIT_BAD_REQUEST);
        }
        const allocator: ComponentIdAllocator = (command) => {
          const allocated = injectedAllocator(command);
          if (allocated.ok && !isVaultComponentId(allocated.value)) {
            return err(
              "invalid_id",
              `採番された id が vault 形でない: ${allocated.value}`,
              "component_id",
            );
          }
          return allocated;
        };
        const payload: Record<string, unknown> = { title: title.value };
        if (raw["iteration_id"] !== undefined) {
          const iterationId = requireString(raw, "iteration_id");
          if (!iterationId.ok) {
            return failure(kind, iterationId.error, CLI_EXIT_BAD_REQUEST);
          }
          payload["iteration_id"] = iterationId.value;
        }
        if (raw["correlation_id"] !== undefined) {
          const correlationId = requireString(raw, "correlation_id");
          if (!correlationId.ok) {
            return failure(kind, correlationId.error, CLI_EXIT_BAD_REQUEST);
          }
          payload["correlation_id"] = correlationId.value;
        }
        const planned = runLocalCommand(ports.store, {
          protocol_version: WORKFLOW_PROTOCOL_VERSION,
          repository_id: ports.store.context.repository_id,
          operation_id: operationId.value,
          operation: "task.create_planned",
          target_id: wishId.value,
          expected_revision: expectedRevision.value,
          actor_ref: actorRef,
          source_device_id: ports.store.context.device_id,
          payload,
        }, { allocate_component_id: allocator });
        if (!planned.ok) {
          return failure(kind, planned.error, CLI_EXIT_BAD_REQUEST);
        }
        plannedDisposition = planned.value.disposition;
        const createdId = planned.value.created_ids[0]?.component_id;
        if (createdId === undefined) {
          // conflict / rejected (stale revision 等) は Task を作らないで止まる —
          // command の disposition をそのまま返す。noop 再送は receipt が
          // created_ids を保持した元の response を返すのでここには来ない。
          if (plannedDisposition !== "applied" && plannedDisposition !== "noop") {
            return {
              kind,
              ok: true,
              exit_code: exitForDisposition(plannedDisposition),
              result: { ...planned.value, create_planned: plannedDisposition },
            };
          }
          return failure(kind, {
            code: "unsupported_feature",
            message: "task.create_planned が id を返さなかった",
            path: "operation_id",
          }, CLI_EXIT_NOT_APPLIED);
        }
        taskId = createdId;
      }

      const created = ports.document.createTask({
        component_id: taskId,
        title: title.value,
        locator: scopedLocator,
      });
      if (!created.ok) return failure(kind, created.error, CLI_EXIT_NOT_APPLIED);
      if (
        created.value.disposition === "conflict" ||
        created.value.disposition === "rejected"
      ) {
        return {
          kind,
          ok: true,
          exit_code: exitForDisposition(created.value.disposition),
          result: {
            ...created.value,
            ...(plannedDisposition === undefined ? {} : { create_planned: plannedDisposition }),
          },
        };
      }
      if (created.value.observed_hash === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: "create_task が observed_hash を返さなかった",
          path: "locator",
        }, CLI_EXIT_NOT_APPLIED);
      }
      // outcome.locator は `path#^<task_id>` — anchor gate が引く bound locator そのもの。
      const observed = ports.projection.observe({
        component_id: taskId,
        title: title.value,
        locator: created.value.locator ??
          `${scopedLocator.path}#^${taskId}`,
        observed_hash: created.value.observed_hash,
      });
      if (!observed.ok) return failure(kind, observed.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(created.value.disposition),
        result: {
          ...created.value,
          ...(plannedDisposition === undefined ? {} : { create_planned: plannedDisposition }),
          projection: observed.value.disposition,
        },
      };
    }

    case "document.register_component_id": {
      const locator = parseDocumentLocator(raw["locator"], "locator");
      if (!locator.ok) return failure(kind, locator.error, CLI_EXIT_BAD_REQUEST);
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      const outcome = ports.document.registerComponentId({
        locator: locator.value,
        expected_hash: expectedHash.value,
        component_id: componentId.value,
      });
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "document.rename_title": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      const title = requireString(raw, "title");
      if (!title.ok) return failure(kind, title.error, CLI_EXIT_BAD_REQUEST);
      const outcome = ports.document.renameTitle({
        component_id: componentId.value,
        expected_hash: expectedHash.value,
        title: title.value,
      });
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "document.replace_region": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const target = parseRegionTarget(raw["target_region"], "target_region");
      if (!target.ok) return failure(kind, target.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_region_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      const content = requireString(raw, "content");
      if (!content.ok) return failure(kind, content.error, CLI_EXIT_BAD_REQUEST);
      const outcome = ports.document.replaceRegion({
        component_id: componentId.value,
        target_region: target.value,
        expected_region_hash: expectedHash.value,
        content: content.value,
      });
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "document.read_children": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const view = ports.document.readChildren(componentId.value);
      if (!view.ok) return failure(kind, view.error, CLI_EXIT_NOT_APPLIED);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: view.value };
    }

    case "document.check_children": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const view = ports.document.readChildren(componentId.value);
      if (!view.ok) return failure(kind, view.error, CLI_EXIT_NOT_APPLIED);
      const children = checkChildEntries(ports.document, ports.store.lookup, view.value.children);
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          component_id: componentId.value,
          locator: view.value.locator,
          children,
          unresolved_count: children.filter((entry) => entry.resolved === false).length,
        },
      };
    }

    case "document.attach_child":
    case "document.detach_child": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      // artifact 0.13.0: 子は `child_link` (node link) か `child_id` (mind が持つ wish の id)。
      if (raw["child_link"] !== undefined && raw["child_id"] !== undefined) {
        return failure(kind, {
          code: "invalid_child_id",
          message: "child_link と child_id はどちらか 1 つだけを渡す",
          path: "child_id",
        }, CLI_EXIT_BAD_REQUEST);
      }
      let input: ChildLinkInput;
      if (raw["child_id"] !== undefined) {
        const childId = parseChildId(raw["child_id"], kind === "document.attach_child", "child_id");
        if (!childId.ok) return failure(kind, childId.error, CLI_EXIT_BAD_REQUEST);
        input = {
          component_id: componentId.value,
          expected_hash: expectedHash.value,
          child_id: childId.value,
        };
      } else {
        const childLink = parseChildLink(raw["child_link"], "child_link");
        if (!childLink.ok) return failure(kind, childLink.error, CLI_EXIT_BAD_REQUEST);
        input = {
          component_id: componentId.value,
          expected_hash: expectedHash.value,
          child_link: childLink.value,
        };
      }
      const outcome = kind === "document.attach_child"
        ? ports.document.attachChild(input)
        : ports.document.detachChild(input);
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "document.read_task": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const view = ports.document.readTask(componentId.value);
      if (!view.ok) return failure(kind, view.error, CLI_EXIT_NOT_APPLIED);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: view.value };
    }

    case "document.move_task": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const parent = parseComponentId(raw["new_parent_component_id"], "new_parent_component_id");
      if (!parent.ok) return failure(kind, parent.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      const outcome = ports.document.moveTask({
        component_id: componentId.value,
        expected_hash: expectedHash.value,
        new_parent_component_id: parent.value,
      });
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      // **移動した側が新しい locator を知っている。** `applied` の outcome.locator は
      // `path#^<task_id>` の移動先なので、bridge (observer) の再観測を待たずに projection を
      // 更新する (bugfix 7)。title は移動で変わらないので既存値を保つ。document 側の write は
      // 既に commit 済みで戻せないため、projection の更新が失敗しても move の結果は変えない
      // (projection は追う側で、次の観測が直す)。
      if (outcome.value.disposition === "applied" && outcome.value.locator !== undefined) {
        const current = readDocumentProjection(ports.store, componentId.value);
        if (current !== undefined && outcome.value.observed_hash !== undefined) {
          ports.projection.observe({
            component_id: componentId.value,
            title: current.title_projection ?? "",
            locator: outcome.value.locator,
            observed_hash: outcome.value.observed_hash,
          });
        }
      }
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "document.move_heading": {
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      const parent = parseComponentId(raw["new_parent_component_id"], "new_parent_component_id");
      if (!parent.ok) return failure(kind, parent.error, CLI_EXIT_BAD_REQUEST);
      const expectedHash = requireString(raw, "expected_hash");
      if (!expectedHash.ok) return failure(kind, expectedHash.error, CLI_EXIT_BAD_REQUEST);
      const outcome = ports.document.moveHeading({
        component_id: componentId.value,
        expected_hash: expectedHash.value,
        new_parent_component_id: parent.value,
      });
      if (!outcome.ok) return failure(kind, outcome.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(outcome.value.disposition),
        result: outcome.value,
      };
    }

    case "replication.publish_pending": {
      const limitRaw = raw["limit"];
      const limit = typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
        ? limitRaw
        : DEFAULT_PUBLISH_BATCH;
      const claimed = claimOutboxBatch(ports.store, limit);
      if (!claimed.ok) return failure(kind, claimed.error, CLI_EXIT_UNAVAILABLE);
      // payload 量は実測対象なので、呼び出し側が測り直さずに済む形で返す。
      const bytes = claimed.value.reduce(
        (total, record) => total + JSON.stringify(record).length,
        0,
      );
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: { records: claimed.value, count: claimed.value.length, bytes },
      };
    }

    case "replication.mark_published": {
      const idsRaw = raw["event_ids"];
      if (!Array.isArray(idsRaw)) {
        return failure(
          kind,
          { code: "invalid_field_type", message: "event_ids は array である", path: "event_ids" },
          CLI_EXIT_BAD_REQUEST,
        );
      }
      const eventIds = [];
      for (const [index, item] of idsRaw.entries()) {
        const parsed = parseEventId(item, `event_ids.${index}`);
        if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
        eventIds.push(parsed.value);
      }
      const updated = markPublished(ports.store, eventIds);
      if (!updated.ok) return failure(kind, updated.error, CLI_EXIT_UNAVAILABLE);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: { updated: updated.value } };
    }

    case "replication.mark_failed": {
      // selector は `event_ids` か `from_state: "publishing"` のどちらか 1 つ。
      // `from_state` は stuck claim (`publishing` に残ったままの行) の一括 reclaim 用で、
      // 他の state の掃き取りは許さない — `pending` / `failed` は claim 側が拾い、
      // `published` は terminal。
      const idsRaw = raw["event_ids"];
      const fromStateRaw = raw["from_state"];
      let eventIds: EventId[];
      if (fromStateRaw !== undefined) {
        if (idsRaw !== undefined || fromStateRaw !== "publishing") {
          return failure(
            kind,
            {
              code: "invalid_field_type",
              message: 'from_state は "publishing" だけ、かつ event_ids と併用できない',
              path: "from_state",
            },
            CLI_EXIT_BAD_REQUEST,
          );
        }
        const listed = listOutboxEventIds(ports.store, "publishing");
        if (!listed.ok) return failure(kind, listed.error, CLI_EXIT_UNAVAILABLE);
        eventIds = [...listed.value];
      } else if (Array.isArray(idsRaw)) {
        eventIds = [];
        for (const [index, item] of idsRaw.entries()) {
          const parsed = parseEventId(item, `event_ids.${index}`);
          if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
          eventIds.push(parsed.value);
        }
      } else {
        return failure(
          kind,
          {
            code: "invalid_field_type",
            message: 'event_ids (array) か from_state: "publishing" のどちらかが必要',
            path: "event_ids",
          },
          CLI_EXIT_BAD_REQUEST,
        );
      }
      const updated = markPublishFailed(ports.store, eventIds);
      if (!updated.ok) return failure(kind, updated.error, CLI_EXIT_UNAVAILABLE);
      return { kind, ok: true, exit_code: CLI_EXIT_OK, result: { updated: updated.value } };
    }

    case "replication.apply_journal": {
      const recordsRaw = raw["records"];
      if (!Array.isArray(recordsRaw)) {
        return failure(
          kind,
          { code: "invalid_field_type", message: "records は array である", path: "records" },
          CLI_EXIT_BAD_REQUEST,
        );
      }
      const records = [];
      for (const item of recordsRaw) {
        const parsed = parseJournalRecord(item, {
          kind_of: (componentId) => ports.store.lookup(componentId)?.kind,
        });
        if (!parsed.ok) return failure(kind, parsed.error, CLI_EXIT_BAD_REQUEST);
        records.push(parsed.value);
      }
      const report = applyJournalBatch(ports.store, records);
      if (!report.ok) return failure(kind, report.error, CLI_EXIT_UNAVAILABLE);
      // conflict と deferred が残る batch は 0 で返さない。呼び出し側が retry を判断できる。
      const settled = report.value.conflict === 0 && report.value.deferred === 0;
      return {
        kind,
        ok: true,
        exit_code: settled ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED,
        result: report.value,
      };
    }

    case "crossrepo.list_intents": {
      // 誰にどの `operation.get_receipt` を投げればよいかを返すだけ。target へ触らない。
      const intents = listCrossRepoIntents(ports.store);
      if (!intents.ok) return failure(kind, intents.error, CLI_EXIT_UNAVAILABLE);
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          intents: intents.value,
        },
      };
    }

    case "crossrepo.plan_recovery": {
      const probesRaw = raw["target_probes"];
      if (
        probesRaw !== undefined && (typeof probesRaw !== "object" || probesRaw === null ||
          Array.isArray(probesRaw))
      ) {
        return failure(kind, {
          code: "invalid_field_type",
          message: "target_probes は object である必要がある",
          path: "target_probes",
        }, CLI_EXIT_BAD_REQUEST);
      }
      const probes = (probesRaw ?? {}) as Record<string, unknown>;
      // parse 失敗を「無い」へ倒さず、request の bug として落とす。
      const parsed = new Map<string, TargetReceiptProbe>();
      for (const [operationId, value] of Object.entries(probes)) {
        const probe = parseTargetReceiptProbe(value, `target_probes.${operationId}`);
        if (!probe.ok) return failure(kind, probe.error, CLI_EXIT_BAD_REQUEST);
        parsed.set(operationId, probe.value);
      }
      const projection = projectCrossRepoIntents(
        ports.store,
        // **渡されていない intent を `absent` へ倒さない。** 倒すと target を見ないまま
        // Task を作りに行く。`unreachable` にして pending を維持する。
        (intent) => parsed.get(intent.target_create_operation_id) ?? unprobedTarget(),
      );
      if (!projection.ok) return failure(kind, projection.error, CLI_EXIT_UNAVAILABLE);
      const needsDecision = projection.value.open.some(
        (view) => view.status === "needs_user_decision",
      );
      return {
        kind,
        ok: true,
        // **user 判断が要る intent が残る結果を exit 0 で返さない。** 呼び出し側が
        // 「片付いた」と読めてしまう。blocked (pending 維持) は正常なので 0 のまま。
        exit_code: needsDecision ? CLI_EXIT_NOT_APPLIED : CLI_EXIT_OK,
        result: {
          ...projection.value,
          no_pending_intent: hasNoPendingIntent(projection.value),
        },
      };
    }

    case "replication.status": {
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          device_id: ports.store.context.device_id,
          repo_cursor: currentRepoCursorToken(ports.store),
          pending_publish: pendingPublishCount(ports.store),
          open_conflicts: listOpenConflicts(ports.store),
          replication_cursors: listReplicationCursors(ports.store),
        },
      };
    }

    case "document_projection.observe": {
      const { kind: _ignored, ...observationRaw } = raw;
      const observation = parseDocumentProjectionObservation(observationRaw, "observation");
      if (!observation.ok) return failure(kind, observation.error, CLI_EXIT_BAD_REQUEST);
      const result = ports.projection.observe(observation.value);
      if (!result.ok) return failure(kind, result.error, CLI_EXIT_UNAVAILABLE);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(result.value.disposition),
        result: result.value,
      };
    }

    case "document_projection.rebind": {
      // caller の観測値 (locator / title / observed_hash) は受け付けない — 観測は
      // vault scan から導出する。component_id 以外の field を通すと、bind 済みの
      // projection を caller の推測で上書きする入口になる (locator drift の温床)。
      for (const key of Object.keys(raw)) {
        if (key !== "kind" && key !== "component_id") {
          return failure(kind, {
            code: "unexpected_field",
            message: `document_projection.rebind は component_id のみを取る: ${key}`,
            path: key,
          }, CLI_EXIT_BAD_REQUEST);
        }
      }
      const componentId = parseComponentId(raw["component_id"], "component_id");
      if (!componentId.ok) return failure(kind, componentId.error, CLI_EXIT_BAD_REQUEST);
      // `vault_scan` は runtime binding (fs_scan.ts) が注入する port。cutover.* と同じく
      // 無い環境は「処理できない」ので exit 1 — request の形は正しい。
      const vaultScan = ports.vault_scan;
      if (vaultScan === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: `${kind} には vault_scan port が必要 (未注入)`,
        }, CLI_EXIT_UNAVAILABLE);
      }
      const { scan, unreadable } = scanVault(vaultScan);
      const rebound = rebindComponent(
        ports.projection,
        scan,
        componentId.value,
      );
      if (!rebound.ok) return failure(kind, rebound.error, CLI_EXIT_NOT_APPLIED);
      return {
        kind,
        ok: true,
        exit_code: exitForDisposition(rebound.value.disposition),
        result: {
          ...rebound.value,
          ...(unreadable.length === 0 ? {} : { unreadable }),
          ...(scan.errors.length === 0 ? {} : { scan_errors: scan.errors }),
        },
      };
    }

    case "repository.provision": {
      const root = requireRoot(ports);
      if (!root.ok) return failure(kind, root.error, CLI_EXIT_BAD_REQUEST);
      // repository_id は request から取らない。**開いた DB が持つ id が正**で、manifest は
      // それを tracked file へ写す (または既に書かれていることを確認する) だけ。
      const repositoryId = ports.store.context.repository_id;
      try {
        const report = provisionRepository(root.value, repositoryId);
        if (!report.ok) return failure(kind, report.error, CLI_EXIT_NOT_APPLIED);
        // 全部既に揃っている再 provision を applied と報告しない。
        const noop = report.value.manifest_state === "present" &&
          (report.value.gitignore === "present" || report.value.gitignore === "no_git");
        return {
          kind,
          ok: true,
          exit_code: CLI_EXIT_OK,
          result: {
            repository_id: repositoryId,
            manifest: manifestPath(root.value),
            db_dir: report.value.db_dir,
            db: report.value.db,
            manifest_state: report.value.manifest_state,
            gitignore: report.value.gitignore,
            disposition: noop ? "noop" : "applied",
            // conventional path と違う DB で開いているなら呼び出し側へ知らせる。
            ...(ports.db !== undefined && !isConventionalDb(root.value, ports.db)
              ? { db_conventional: false }
              : {}),
          },
        };
      } catch (cause) {
        return ioFailure(kind, cause);
      }
    }

    case "registry.add": {
      const portsRoot = requireRoot(ports);
      if (!portsRoot.ok) return failure(kind, portsRoot.error, CLI_EXIT_BAD_REQUEST);
      const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
      if (!repositoryId.ok) return failure(kind, repositoryId.error, CLI_EXIT_BAD_REQUEST);
      const entryRoot = requireString(raw, "root");
      if (!entryRoot.ok) return failure(kind, entryRoot.error, CLI_EXIT_BAD_REQUEST);
      // registry は device-local なので root はこの device の絶対 path。相対 path を入れると
      // 別の cwd から読んだ時に別 repo を指す。
      if (!entryRoot.value.startsWith("/")) {
        return failure(kind, {
          code: "invalid_locator",
          message: `root は "/" で始まる絶対 path である必要がある: ${entryRoot.value}`,
          path: "root",
        }, CLI_EXIT_BAD_REQUEST);
      }
      try {
        // 登録の前に、その root が本当にその repository_id の repo かを manifest で確かめる。
        // **request の id を鵜呑みにしない。**manifest 無し / 読めないは document_not_found。
        const manifestId = manifestRepositoryId(entryRoot.value);
        if (!manifestId.ok) return failure(kind, manifestId.error, CLI_EXIT_NOT_APPLIED);
        if (manifestId.value === undefined) {
          return failure(kind, {
            code: "document_not_found",
            message: `manifest が無い: ${manifestPath(entryRoot.value)}`,
            path: "root",
          }, CLI_EXIT_NOT_APPLIED);
        }
        if (manifestId.value !== repositoryId.value) {
          return failure(kind, {
            code: "repository_id_mismatch",
            message: `manifest の repository_id ${JSON.stringify(manifestId.value)} と request の ${
              JSON.stringify(repositoryId.value)
            } が一致しない`,
            path: "repository_id",
          }, CLI_EXIT_NOT_APPLIED);
        }
        const added = addRegistryEntry(portsRoot.value, {
          repository_id: repositoryId.value,
          root: entryRoot.value,
        });
        if (!added.ok) return failure(kind, added.error, CLI_EXIT_NOT_APPLIED);
        return {
          kind,
          ok: true,
          exit_code: CLI_EXIT_OK,
          result: {
            repository_id: repositoryId.value,
            root: entryRoot.value,
            disposition: added.value === "present" ? "noop" : "applied",
          },
        };
      } catch (cause) {
        return ioFailure(kind, cause);
      }
    }

    case "registry.list": {
      const portsRoot = requireRoot(ports);
      if (!portsRoot.ok) return failure(kind, portsRoot.error, CLI_EXIT_BAD_REQUEST);
      try {
        const entries = loadRegistry(portsRoot.value);
        if (!entries.ok) return failure(kind, entries.error, CLI_EXIT_NOT_APPLIED);
        // 出力順を repository_id で固定する。file 内の key 順は書き込み順に依存するので
        // 呼び出し側に安定した順を返す。
        const sorted = [...entries.value].sort((left, right) =>
          left.repository_id.localeCompare(right.repository_id)
        );
        return {
          kind,
          ok: true,
          exit_code: CLI_EXIT_OK,
          result: { repositories: sorted },
        };
      } catch (cause) {
        return ioFailure(kind, cause);
      }
    }

    case "registry.remove": {
      const portsRoot = requireRoot(ports);
      if (!portsRoot.ok) return failure(kind, portsRoot.error, CLI_EXIT_BAD_REQUEST);
      const repositoryId = parseRepositoryId(raw["repository_id"], "repository_id");
      if (!repositoryId.ok) return failure(kind, repositoryId.error, CLI_EXIT_BAD_REQUEST);
      try {
        // **entry を外すだけ。repo の file も DB も消さない。**registry は lookup table なので、
        // 消してよいのはこの file の行だけ。
        const removed = removeRegistryEntry(portsRoot.value, repositoryId.value);
        if (!removed.ok) return failure(kind, removed.error, CLI_EXIT_NOT_APPLIED);
        return {
          kind,
          ok: true,
          exit_code: CLI_EXIT_OK,
          result: {
            repository_id: repositoryId.value,
            disposition: removed.value === "removed" ? "applied" : "noop",
          },
        };
      } catch (cause) {
        return ioFailure(kind, cause);
      }
    }

    case "cutover.scan":
    case "cutover.bind":
    case "cutover.audit": {
      // `vault_scan` は runtime binding (fs_scan.ts) が注入する port。無い環境は
      // 「処理できない」ので exit 1 — request の形は正しい。
      const vaultScan = ports.vault_scan;
      if (vaultScan === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: `${kind} には vault_scan port が必要 (未注入)`,
        }, CLI_EXIT_UNAVAILABLE);
      }
      // file の読み取り失敗は crash にせず per-file の `unreadable` として残す。
      const { scan, unreadable } = scanVault(vaultScan);
      if (kind === "cutover.scan") {
        // 読み取り専用。anchor を file ごとにまとめて返す。
        const byFile = new Map<string, unknown[]>();
        for (const anchor of scan.anchors) {
          const bucket = byFile.get(anchor.path);
          if (bucket === undefined) {
            byFile.set(anchor.path, [anchor]);
          } else {
            bucket.push(anchor);
          }
        }
        return {
          kind,
          ok: true,
          exit_code: CLI_EXIT_OK,
          result: {
            files_scanned: scan.sources.size + scan.skipped_derived.length,
            anchors_found: scan.anchors.length,
            duplicates: scan.duplicates,
            skipped_derived: scan.skipped_derived,
            files: [...byFile.entries()].map(([path, anchors]) => ({ path, anchors })),
            unreadable,
            scan_errors: scan.errors,
          },
        };
      }
      if (kind === "cutover.bind") {
        const report = bindAnchors(ports.store, ports.projection, scan);
        return {
          kind,
          ok: report.verdict === "ok",
          // required anchor が欠けた結果を「片付いた」と返さない (duplicate のような
          // finding 側の skip も verdict=partial で exit 非 0)。findings / errors は
          // 失敗 verdict でも result に全部残る — exit 非 0 は情報喪失ではない。
          exit_code: report.verdict === "ok" ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED,
          result: { ...report, unreadable, scan_errors: scan.errors },
        };
      }
      // mind -> wish link は vault registry 経由で跨 repo 解決する (--root が無いときは
      // 従来どおり local 判定)。readiness-b 4-5: 行き先の在処は常に read-time で確かめる。
      const auditLinks = ports.root === undefined
        ? ok(listMindWishLinks(ports.store, {}))
        : resolveWishLinks(ports.root, listMindWishLinks(ports.store, {}));
      if (!auditLinks.ok) {
        return failure(kind, auditLinks.error, CLI_EXIT_NOT_APPLIED);
      }
      const report = auditCutover(ports.store, scan, {
        mind_wish_links: auditLinks.value,
      });
      return {
        kind,
        ok: report.counts.failures === 0,
        // **失敗 0 件の時だけ 0。** result JSON はどちらでも必ず出す。
        exit_code: report.counts.failures === 0 ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED,
        result: { ...report, unreadable, scan_errors: scan.errors },
      };
    }

    case "iteration.list": {
      const scopeArgs = iterationScopeArgs(raw);
      if (!scopeArgs.ok) return failure(kind, scopeArgs.error, CLI_EXIT_BAD_REQUEST);
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          scope: scopeArgs.value.scope,
          component_path: scopeArgs.value.component_path,
          // **seq 順。** label や created_at の順に意味は無い。
          iterations: listIterations(
            ports.store.driver,
            scopeArgs.value.scope,
            scopeArgs.value.component_path,
          ),
        },
      };
    }

    case "iteration.current": {
      const scopeArgs = iterationScopeArgs(raw);
      if (!scopeArgs.ok) return failure(kind, scopeArgs.error, CLI_EXIT_BAD_REQUEST);
      const current = defaultIterationOf(
        ports.store.driver,
        scopeArgs.value.scope,
        scopeArgs.value.component_path,
      );
      return {
        kind,
        ok: true,
        exit_code: CLI_EXIT_OK,
        result: {
          repository_id: ports.store.context.repository_id,
          scope: scopeArgs.value.scope,
          component_path: scopeArgs.value.component_path,
          // **正本は `active_iterations.is_default`。** `current` symlink からは推測しない。
          // default が無い scope では `iteration: null` — caller は label を明示する
          // (optional current の裁定)。
          iteration: current ?? null,
          active: activeIterationsOf(
            ports.store.driver,
            scopeArgs.value.scope,
            scopeArgs.value.component_path,
          ),
          ...(current === undefined ? {} : {
            members: {
              components: iterationMembersOf(ports.store.driver, current.iteration_id),
              documents: iterationDocMembersOf(ports.store.driver, current.iteration_id),
            },
          }),
        },
      };
    }

    case "iteration.repair": {
      const fs = ports.iteration_fs;
      if (fs === undefined) {
        return failure(kind, {
          code: "unsupported_feature",
          message: "iteration.repair には iteration_fs port が必要 (未注入)",
        }, CLI_EXIT_UNAVAILABLE);
      }
      return repairIterations(kind, ports, fs);
    }
  }
}

/**
 * `iteration.open` の target dir が既に在るかを commit 前に見る。
 * 衝突なら理由を返し、無ければ / 判断材料が足りなければ undefined (decide 側の検査へ流す)。
 */
function iterationDirCollision(fs: IterationFsPort, command: Command): string | undefined {
  const scopeRaw = command.payload["scope"];
  const name = command.payload["name"];
  if (typeof scopeRaw !== "string" || typeof name !== "string") return undefined;
  const scope = parseIterationScope(scopeRaw, "payload.scope");
  const label = validateIterationLabel(name, "payload.name");
  if (!scope.ok || !label.ok) return undefined;
  const componentPath = typeof command.payload["component_path"] === "string"
    ? command.payload["component_path"] as string
    : "";
  const dir = iterationDirOf({
    scope: scope.value,
    component_path: componentPath,
    name: label.value,
  });
  return fs.exists(dir)
    ? `iteration dir は既に存在する (fail closed、上書きしない): ${dir}`
    : undefined;
}

/** iteration read kind の共通引数。project scope は `component_path` を持たない ("" sentinel)。 */
function iterationScopeArgs(
  raw: Record<string, unknown>,
): Result<{ scope: "project" | "component"; component_path: string }> {
  const scope = parseIterationScope(raw["scope"], "scope");
  if (!scope.ok) return scope;
  const componentPath = raw["component_path"];
  if (scope.value === "project") {
    if (componentPath !== undefined && componentPath !== "") {
      return err(
        "invalid_component_path",
        "project scope は component_path を持たない",
        "component_path",
      );
    }
    return ok({ scope: "project", component_path: "" });
  }
  if (typeof componentPath !== "string" || componentPath === "") {
    return err(
      "missing_field",
      "component scope には component_path が必要",
      "component_path",
    );
  }
  const checked = validateComponentPath(componentPath, "component_path");
  if (!checked.ok) return checked;
  return ok({ scope: scope.value, component_path: checked.value });
}

/**
 * `filePath` に generated iteration key を書く。warning を返すか、書けた / 書くものが
 * 無い時は undefined。**key を出さない file (pre-iteration scope) は成功扱い。**
 */
function stampIterationFile(
  ports: CliPorts,
  path: string,
  componentId?: ComponentId,
): { warning?: string; changed?: boolean } {
  const effective = componentId === undefined
    ? effectiveIterationOfPath(ports.store.driver, path)
    : effectiveIterationOf(ports.store.driver, componentId, path);
  // membership が無い file には key を出さない。「書けない」と「書くものが無い」を分ける。
  if (effective === undefined) return {};
  // port がこの口を持たない環境 (未実装 consumer) では飛ばす。repair で後追いできる。
  if (ports.document.stampIterationProperties === undefined) return {};
  const stamped = ports.document.stampIterationProperties({
    path,
    properties: iterationPropertiesOf(effective),
  });
  return stamped.ok
    ? { changed: stamped.value.changed }
    : { warning: `${stamped.error.code}: ${stamped.error.message}` };
}

/**
 * iteration の member file の canonical path 一覧。component は document projection の
 * locator から、doc member は path そのもの。
 *
 * `include_minds=false` は re-expose link 用: mind file は vault root に flat で
 * membership は DB-only なので link を張らない (裁定: minds stay DB-only)。
 * frontmatter の generated key は mind にも書くので、stamping 側は `true` で呼ぶ。
 */
function memberPathsOf(
  ports: CliPorts,
  iteration: IterationInfo,
  includeMinds: boolean,
): readonly string[] {
  const paths: string[] = [];
  for (const componentId of iterationMembersOf(ports.store.driver, iteration.iteration_id)) {
    const id = parseComponentId(componentId, "component_id");
    if (!id.ok) continue;
    if (!includeMinds && ports.store.lookup(id.value)?.kind === "mind") continue;
    const locator = readDocumentProjection(ports.store, id.value)?.document_locator;
    if (locator === undefined) continue;
    paths.push(locator.split("#", 1)[0] ?? locator);
  }
  paths.push(...iterationDocMembersOf(ports.store.driver, iteration.iteration_id));
  return paths;
}

/** member file を `<dir>/{docs,spec,app}/` へ symlink で再露出する。既に dir 内の birth file は飛ばす。 */
function writeMemberLinks(
  ports: CliPorts,
  fs: IterationFsPort,
  iteration: IterationInfo,
): { warnings: string[]; changed: number } {
  const warnings: string[] = [];
  let changed = 0;
  const iterDir = iterationDirOf(iteration);
  for (const path of memberPathsOf(ports, iteration, false)) {
    if (path.startsWith(`${iterDir}/`)) continue;
    const link = memberLinkPath(iterDir, path);
    const written = fs.writeSymlink(link, relativeSymlinkTarget(link, path));
    if (!written.ok) warnings.push(`${written.error.code}: ${written.error.message}`);
    else if (written.value.changed) changed += 1;
  }
  return { warnings, changed };
}

/** member file 全員へ generated key を写す (mind を含む)。stale な値は上書きされる。 */
function stampIterationMembers(ports: CliPorts, iteration: IterationInfo): string[] {
  const warnings: string[] = [];
  for (const componentId of iterationMembersOf(ports.store.driver, iteration.iteration_id)) {
    const id = parseComponentId(componentId, "component_id");
    if (!id.ok) continue;
    const locator = readDocumentProjection(ports.store, id.value)?.document_locator;
    if (locator === undefined) continue;
    const warning =
      stampIterationFile(ports, locator.split("#", 1)[0] ?? locator, id.value).warning;
    if (warning !== undefined) warnings.push(warning);
  }
  for (const path of iterationDocMembersOf(ports.store.driver, iteration.iteration_id)) {
    const warning = stampIterationFile(ports, path).warning;
    if (warning !== undefined) warnings.push(warning);
  }
  return warnings;
}

/**
 * scope の active set / default を DB state から fs へ投影する (schema 7)。
 *
 * - `active/<label>`: active row ごとに link を張る。managed `active/` dir の中に
 *   DB が知らない stale link が在れば外す。非 symlink entry は port が fail closed。
 * - `current`: default が在る scope だけ張る。無い scope では既存 link を外す
 *   (current は optional — 無い状態は合法)。
 *
 * op 個別に「この link をどう動かすか」を考えるより、scope 単位で DB -> fs を
 * reconcile する方が deactivate の `was_default` / `next_default` の分岐を
 * 持たなくて済み、partial failure の後始末も repair と同じ形になる。
 */
function reconcileIterationLinks(
  ports: CliPorts,
  fs: IterationFsPort,
  scope: IterationInfo["scope"],
  componentPath: string,
): { warnings: string[]; changed: number } {
  const warnings: string[] = [];
  let changed = 0;
  const activeDir = scope === "project" ? "docs/active" : `${componentPath}/active`;
  const actives = activeIterationsOf(ports.store.driver, scope, componentPath);
  const expected = new Set<string>();
  for (const it of actives) {
    expected.add(it.name);
    const link = activeLinkPath(scope, componentPath, it.name);
    const written = fs.writeSymlink(link, relativeSymlinkTarget(link, iterationDirOf(it)));
    if (!written.ok) warnings.push(`${written.error.code}: ${written.error.message}`);
    else if (written.value.changed) changed += 1;
  }
  const listed = fs.listSymlinks(activeDir);
  if (!listed.ok) {
    warnings.push(`${listed.error.code}: ${listed.error.message}`);
  } else {
    for (const name of listed.value) {
      if (expected.has(name)) continue;
      const removed = fs.removeSymlink(`${activeDir}/${name}`);
      if (!removed.ok) warnings.push(`${removed.error.code}: ${removed.error.message}`);
      else if (removed.value.changed) changed += 1;
    }
  }
  const currentLink = currentLinkPath(scope, componentPath);
  const def = defaultIterationOf(ports.store.driver, scope, componentPath);
  if (def === undefined) {
    const removed = fs.removeSymlink(currentLink);
    if (!removed.ok) warnings.push(`${removed.error.code}: ${removed.error.message}`);
    else if (removed.value.changed) changed += 1;
  } else {
    const pointed = fs.writeSymlink(
      currentLink,
      relativeSymlinkTarget(currentLink, iterationDirOf(def)),
    );
    if (!pointed.ok) warnings.push(`${pointed.error.code}: ${pointed.error.message}`);
    else if (pointed.value.changed) changed += 1;
  }
  return { warnings, changed };
}

/**
 * applied な iteration command の fs 側 (派生 state) を組む。**DB commit 後にだけ呼ぶ。**
 *
 * fs は SQLite transaction に乗らないので、ここでの失敗は command の成否にせず
 * warning として返す。狂った派生 state は `iteration.repair` が DB から組み直す。
 */
function applyIterationFsEffects(
  ports: CliPorts,
  operation: string,
  iteration: IterationInfo,
): string[] {
  const warnings: string[] = [];
  const fs = ports.iteration_fs;
  const iterDir = iterationDirOf(iteration);
  switch (operation) {
    case "iteration.open": {
      if (fs === undefined) break;
      const created = fs.createSkeleton(iterDir);
      if (!created.ok) warnings.push(`${created.error.code}: ${created.error.message}`);
      break;
    }
    case "iteration.activate":
    case "iteration.deactivate":
    case "iteration.set_default": {
      if (fs === undefined) break;
      warnings.push(
        ...reconcileIterationLinks(ports, fs, iteration.scope, iteration.component_path)
          .warnings,
      );
      break;
    }
    case "iteration.switch": {
      if (fs !== undefined) {
        warnings.push(
          ...reconcileIterationLinks(ports, fs, iteration.scope, iteration.component_path)
            .warnings,
        );
        warnings.push(...writeMemberLinks(ports, fs, iteration).warnings);
      }
      warnings.push(...stampIterationMembers(ports, iteration));
      break;
    }
    case "iteration.carry": {
      if (fs !== undefined) warnings.push(...writeMemberLinks(ports, fs, iteration).warnings);
      warnings.push(...stampIterationMembers(ports, iteration));
      break;
    }
    // dispose は fs を触らない。dir / symlink は残す (`disposed_at` の marker だけ)。
    // active set には入っていない (dispose の guard) ので link の reconcile も不要。
    default:
      break;
  }
  return warnings;
}

/**
 * `iteration.repair`。replication Option A の裁定で committed tree が device を跨ぐ
 * carrier なので、2 つの半分を持つ:
 *
 * 1. **tree -> DB**: `fs.scanTree()` + `vault_scan` の generated frontmatter から
 *    iterations / members / active set / optional default を空の (または一部だけ
 *    ある) DB へ組み直す。seq は `iteration:` の記録値だけを読み、欠け・衝突・
 *    partial tree は `failures` に offending path を載せて fail closed (DB には
 *    何も書かない)。`vault_scan` 未注入で DB が空なら `unsupported_feature`。
 * 2. **DB -> fs**: `active/<label>` link、`current` symlink (default の在る scope
 *    のみ)、member link、generated frontmatter key、欠けた skeleton subdir を
 *    DB state から組み直す。managed `active/` dir 内の stale link は外す。
 *    file / dir は消さない。
 */
function repairIterations(
  kind: string,
  ports: CliPorts,
  fs: IterationFsPort,
): CliResponse {
  const warnings: string[] = [];
  const repaired: Record<string, unknown>[] = [];
  const reconstructed: ReconstructedIteration[] = [];
  const repositoryId = ports.store.context.repository_id;
  let changed = false;

  // --- phase 1: tree -> DB ---
  const vaultScan = ports.vault_scan;
  const rebuilt = { iterations: 0, members: 0, doc_members: 0, actives: 0 };
  if (vaultScan === undefined) {
    if (listAllIterations(ports.store.driver).length === 0) {
      return failure(kind, {
        code: "unsupported_feature",
        message: "iteration.repair の tree -> DB rebuild には vault_scan port が必要 (未注入)",
      }, CLI_EXIT_UNAVAILABLE);
    }
    warnings.push("vault_scan 未注入 — tree -> DB rebuild は skip (DB -> fs のみ)");
  } else {
    const scanned = fs.scanTree();
    if (!scanned.ok) return failure(kind, scanned.error, CLI_EXIT_NOT_APPLIED);
    // `.md` 全文の generated key を index 化する。読めない file は seq 記録を
    // 落とす可能性があるので黙って飛ばさず fail closed。
    const files = new Map<string, Partial<IterationProperties> | undefined>();
    const readFailures: IterationTreeFailure[] = [];
    for (const path of vaultScan.files()) {
      const text = vaultScan.read(path);
      if (!text.ok) {
        readFailures.push({ path, reason: `file が読めない: ${text.error.message}` });
        continue;
      }
      files.set(path, readIterationProperties(text.value));
    }
    const outcome = readFailures.length > 0
      ? { ok: false as const, failures: readFailures }
      : planIterationRebuild({
        scan: scanned.value,
        files,
        componentPaths: new Set(componentDocumentPaths(ports.store.driver).keys()),
        ...(ports.iteration_history === undefined ? {} : { history: ports.iteration_history }),
      });
    if (!outcome.ok) {
      return {
        kind,
        ok: false,
        exit_code: CLI_EXIT_NOT_APPLIED,
        result: {
          repository_id: repositoryId,
          disposition: "rejected",
          failures: outcome.failures,
          warnings,
        },
      };
    }
    warnings.push(...outcome.warnings);
    // stamp を持たない iteration を first-commit metadata から復元した記録 —
    // disclosure として result に残す (ul-browser 2026-09-30 手動 recipe の実装化)。
    for (const entry of outcome.reconstructed) reconstructed.push(entry);
    const applied = applyIterationRebuild(
      ports.store.driver,
      outcome.plan,
      new Date().toISOString(),
    );
    if (!applied.ok) {
      return {
        kind,
        ok: false,
        exit_code: CLI_EXIT_NOT_APPLIED,
        result: {
          repository_id: repositoryId,
          disposition: "rejected",
          failures: applied.failures,
          warnings,
        },
      };
    }
    warnings.push(...applied.applied.warnings);
    rebuilt.iterations = applied.applied.iterations;
    rebuilt.members = applied.applied.members;
    rebuilt.doc_members = applied.applied.doc_members;
    rebuilt.actives = applied.applied.actives;
    changed ||= applied.applied.iterations + applied.applied.members +
        applied.applied.doc_members + applied.applied.actives + applied.applied.births > 0;
  }

  // --- phase 2: DB -> fs ---
  const all = listAllIterations(ports.store.driver);
  for (const iteration of all) {
    // git は空 dir を commit しないので、committed tree では subdir が欠けうる。
    // `createSkeleton` ではなく `ensureSkeleton` — 欠けた分だけを補う。
    const ensured = fs.ensureSkeleton(iterationDirOf(iteration));
    if (!ensured.ok) warnings.push(`${ensured.error.code}: ${ensured.error.message}`);
    else if (ensured.value.created) changed = true;
    const links = writeMemberLinks(ports, fs, iteration);
    warnings.push(...links.warnings);
    if (links.changed > 0) changed = true;
  }
  // scope ごとに active set / default を reconcile する。managed `active/` の stale
  // link の prune と `current` の有無 (default なし scope では外す) もここで済む。
  const scopes = new Map<string, { scope: IterationInfo["scope"]; component_path: string }>();
  for (const iteration of all) {
    scopes.set(`${iteration.scope}${iteration.component_path}`, {
      scope: iteration.scope,
      component_path: iteration.component_path,
    });
  }
  for (const scope of scopes.values()) {
    const reconciled = reconcileIterationLinks(ports, fs, scope.scope, scope.component_path);
    warnings.push(...reconciled.warnings);
    if (reconciled.changed > 0) changed = true;
    const current = defaultIterationOf(ports.store.driver, scope.scope, scope.component_path);
    repaired.push({
      scope: scope.scope,
      component_path: scope.component_path,
      active_iterations: activeIterationsOf(ports.store.driver, scope.scope, scope.component_path)
        .map((it) => it.iteration_id),
      ...(current === undefined ? {} : {
        iteration_id: current.iteration_id,
        current_link: currentLinkPath(current.scope, current.component_path),
      }),
      member_links_checked: current === undefined ? 0 : memberPathsOf(ports, current, false).length,
    });
  }
  // frontmatter の再投影は member 全員が対象 (mind も含む)。carry 先が current とは
  // 限らないので current 以外の iteration の member も拾う。
  const memberPaths = new Set<string>();
  for (const iteration of all) {
    for (const path of memberPathsOf(ports, iteration, true)) memberPaths.add(path);
  }
  let stamped = 0;
  for (const path of memberPaths) {
    const stampedFile = stampIterationFile(ports, path);
    if (stampedFile.warning !== undefined) warnings.push(stampedFile.warning);
    else {
      stamped += 1;
      if (stampedFile.changed === true) changed = true;
    }
  }
  return {
    kind,
    ok: warnings.length === 0,
    exit_code: warnings.length === 0 ? CLI_EXIT_OK : CLI_EXIT_NOT_APPLIED,
    result: {
      repository_id: repositoryId,
      disposition: changed ? "applied" : "noop",
      rebuilt,
      reconstructed,
      repaired,
      frontmatter_stamped: stamped,
      warnings,
    },
  };
}

/**
 * SQLite で live と読めた所属について、**wish の node が今も document に在るか**を確かめる。
 *
 * projection の locator が指す file と node を読み、anchor がその wish の id であることを見る。
 * 読めなければ `document_missing` の broken にする。**つながっているとは報告しない。**
 * wish を別 file へ動かした直後で observer がまだ新しい locator を写していない間もここに落ちる。
 * 保守側 (live と言わない) に倒す。
 */
function confirmWishDocument(ports: CliPorts, link: MindWishLinkView): MindWishLinkView {
  const missing: MindWishLinkView = { ...link, state: "broken", reason: "document_missing" };
  const wish = parseComponentId(link.wish_component_id, "wish_component_id");
  if (!wish.ok) return missing;
  const locatorText = readDocumentProjection(ports.store, wish.value)?.document_locator;
  if (locatorText === undefined) return missing;
  const locator = parseDocumentLocator(locatorText, "locator");
  if (!locator.ok) return missing;
  const node = ports.document.inspectLocator(locator.value);
  return node.ok && node.value.component_id === wish.value ? link : missing;
}

/**
 * local の COMPONENTS に無い wish link (`wish_not_registered`) を、vault の登録 repo DB へ
 * read-time で解決する (2 層 DB: vault が repo の上)。`resolveWishInRepositories` の結果を
 * MindWishLinkView へ畳む:
 *
 * - live → live + `resolved_repository_id`
 * - document_missing / not_a_wish → 同じ reason の broken + `resolved_repository_id`
 * - unresolved (到達できない repo が残り、居場所を確かめ切れない) → `repository_unreachable`
 * - not_registered → 変更なし (登録 repo のどこにも居ない)
 *
 * registry が壊れていれば request 全体を `invalid_field_type` で落とす。壊れた registry を
 * 「登録 0 件」と読み違えると、全 link が黙って wish_not_registered のまま返る。
 */
function resolveWishLinks(
  root: string,
  links: readonly MindWishLinkView[],
): Result<readonly MindWishLinkView[]> {
  const loaded = loadRegistryEntries(root);
  if (!loaded.ok) return loaded;
  const entries = loaded.value;
  // 同じ wish が複数 mind にぶら下がることがあるので、wish ごとに 1 回だけ解決する。
  const resolutions = new Map<string, WishRepositoryResolution>();
  const resolved = links.map((link): MindWishLinkView => {
    if (link.reason !== "wish_not_registered" || link.wish_component_id === undefined) {
      return link;
    }
    let resolution = resolutions.get(link.wish_component_id);
    if (resolution === undefined) {
      resolution = resolveWishInRepositories(entries, link.wish_component_id);
      resolutions.set(link.wish_component_id, resolution);
    }
    const base = {
      mind_component_id: link.mind_component_id,
      child_value: link.child_value,
      wish_component_id: link.wish_component_id,
    };
    switch (resolution.state) {
      case "live":
        return { ...base, resolved_repository_id: resolution.repository_id, state: "live" };
      case "document_missing":
        return {
          ...base,
          resolved_repository_id: resolution.repository_id,
          state: "broken",
          reason: "document_missing",
        };
      case "not_a_wish":
        return {
          ...base,
          resolved_repository_id: resolution.repository_id,
          state: "broken",
          reason: "not_a_wish",
        };
      case "unresolved":
        return { ...base, state: "broken", reason: "repository_unreachable" };
      case "not_registered":
        return link;
    }
  });
  return ok(resolved);
}
