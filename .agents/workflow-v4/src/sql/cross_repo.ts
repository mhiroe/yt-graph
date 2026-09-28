// source repo 側の cross-repo intent projection (Slice E)。
//
// **専用 table を作らない。** `persistence.md` "Persistence boundary" が「cross-repo operation の
// `correlation_id`、target repository、step 別 operation ID、intent completion は `OPERATIONS` と
// `ACTIVITIES` へ保持する。専用 coordinator table は initial minimum に追加しない」と決めている。
// 実装は `OPERATIONS` の 2 回の読みだけで、schema を 1 列も足していない。
//
// **intent が開いているかを保存しない。** begin の receipt があって attach の receipt が無い、
// から導く。保存すると維持する側が要る (`laws.md`「導出できるものを保存しない」)。

import { ok, type Result } from "../result.ts";
import {
  componentAddress,
  type OperationId,
  parseComponentId,
  parseOperationId,
  parseRepositoryId,
} from "../ids.ts";
import { parseRelationType } from "../relations.ts";
import { parseDisposition } from "../responses.ts";
import {
  type CrossRepoIntent,
  type CrossRepoIntentView,
  type PendingIntentProjection,
  planRecovery,
  projectPendingIntents,
  type SourceDetachStep,
  type SourceStepProbe,
  type TargetReceiptProbe,
} from "../cross_repo.ts";
import { rowString } from "./driver.ts";
import type { SqliteWorkflowStore } from "./store.ts";

/**
 * target repo の receipt を引く口。
 *
 * **injected にする。** WorkflowPort は 1 repo へ scope されている (`interfaces.md` 原則) ので、
 * source repo の store から target repo を辿れない。辿れる形にすると 1 つの Core が複数 repo の
 * DB を開くことになり、所有境界が壊れる。
 *
 * **`unreachable` を返せる形を必須にする。** `undefined` だけを返す口にすると、接続できない
 * repo に対して「Task は無い」と判断して二重に作りに行く。
 */
export type TargetReceiptLookup = (
  intent: CrossRepoIntent,
) => TargetReceiptProbe;

/**
 * 開いている / 開いていたすべての cross-repo intent を読む。
 *
 * `applied` の begin receipt だけを intent として扱う。`rejected` の begin は intent を
 * 開いていない (同一 repo target、step ID 重複) ので列挙しない。
 */
export function listCrossRepoIntents(
  store: SqliteWorkflowStore,
): Result<readonly CrossRepoIntent[]> {
  const rows = store.driver
    .prepare(
      "SELECT operation_id, target_component_id, correlation_id, payload_json" +
        " FROM operations" +
        " WHERE operation_type = 'relation.begin_external' AND disposition = 'applied'" +
        " ORDER BY created_at, operation_id",
    )
    .all();
  const intents: CrossRepoIntent[] = [];
  for (const row of rows) {
    const beginOperationId = parseOperationId(rowString(row, "operation_id"), "operation_id");
    if (!beginOperationId.ok) return beginOperationId;
    const sourceComponentId = parseComponentId(
      rowString(row, "target_component_id"),
      "target_component_id",
    );
    // begin は target_id required なので、ここが空なら DB 側の壊れである。
    // 既定値へ落とさず、読めなかったことをそのまま返す。
    if (!sourceComponentId.ok) return sourceComponentId;
    const correlationId = rowString(row, "correlation_id");
    const payloadJson = rowString(row, "payload_json");
    if (correlationId === undefined || payloadJson === undefined) return ok(intents);
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    const targetRepositoryId = parseRepositoryId(
      payload["target_repository_id"],
      "target_repository_id",
    );
    if (!targetRepositoryId.ok) return targetRepositoryId;
    const relationType = parseRelationType(payload["relation_type"], "relation_type");
    if (!relationType.ok) return relationType;
    const targetCreate = parseOperationId(
      payload["target_create_operation_id"],
      "target_create_operation_id",
    );
    if (!targetCreate.ok) return targetCreate;
    const sourceAttach = parseOperationId(
      payload["source_attach_operation_id"],
      "source_attach_operation_id",
    );
    if (!sourceAttach.ok) return sourceAttach;
    // **移動の step は optional。**無い intent は「external relation を 1 本足すだけ」で、
    // 畳む相手が無い。片方だけが入った payload は `decide.ts` が begin の時点で rejected に
    // しているので、applied の begin がここへ来ることは無い。**読めなかったら黙って捨てずに返す。**
    const detachStep = parseSourceDetachStep(payload);
    if (!detachStep.ok) return detachStep;

    const source = componentAddress(store.context.repository_id, sourceComponentId.value);
    intents.push({
      begin_operation_id: beginOperationId.value,
      correlation_id: correlationId,
      source,
      target_repository_id: targetRepositoryId.value,
      relation_type: relationType.value,
      target_create_operation_id: targetCreate.value,
      source_attach_operation_id: sourceAttach.value,
      ...(detachStep.value === undefined ? {} : { source_detach: detachStep.value }),
    });
  }
  return ok(intents);
}

/**
 * begin payload から移動の step を読む。
 *
 * **片方だけ入っていたら `undefined` へ倒さない。** 倒すと「移動のつもりで開いた intent が
 * ただの attach として閉じる」ことになり、元の relation が残ったまま誰も気付けない。
 */
function parseSourceDetachStep(
  payload: Record<string, unknown>,
): Result<SourceDetachStep | undefined> {
  const rawComponent = payload["source_detach_component_id"];
  const rawOperation = payload["source_detach_operation_id"];
  if (rawComponent === undefined && rawOperation === undefined) return ok(undefined);
  const componentId = parseComponentId(rawComponent, "source_detach_component_id");
  if (!componentId.ok) return componentId;
  const operationId = parseOperationId(rawOperation, "source_detach_operation_id");
  if (!operationId.ok) return operationId;
  return ok({ operation_id: operationId.value, component_id: componentId.value });
}

/**
 * source repo の step (attach / detach) の receipt。
 *
 * **`correlation_id` ではなく step operation ID で引く。** その ID は intent 自身が持っており、
 * recovery が再送に使う ID でもある。correlation で引くと、同じ correlation を持つ別 step の
 * receipt を拾いうる。
 */
export function readSourceStepProbe(
  store: SqliteWorkflowStore,
  operationId: OperationId,
): SourceStepProbe {
  const row = store.driver
    .prepare("SELECT disposition FROM operations WHERE operation_id = ?")
    .get(operationId);
  if (row === undefined) return { kind: "absent" };
  const disposition = parseDisposition(rowString(row, "disposition"), "disposition");
  // claim 済みで未処理 (disposition が NULL) の row は「まだ結果が無い」なので absent と同じ扱い。
  // 進行中を「終わった」と読み替えない。
  if (!disposition.ok) return { kind: "absent" };
  return { kind: "receipt", disposition: disposition.value };
}

/**
 * source repo の pending intent projection を組む。
 *
 * target 側の receipt は `lookup` が返す。**この関数が他 repo の DB を開かない。**
 */
export function projectCrossRepoIntents(
  store: SqliteWorkflowStore,
  lookup: TargetReceiptLookup,
): Result<PendingIntentProjection> {
  const intents = listCrossRepoIntents(store);
  if (!intents.ok) return intents;
  const views: CrossRepoIntentView[] = [];
  for (const intent of intents.value) {
    const attach = readSourceStepProbe(store, intent.source_attach_operation_id);
    // detach step を持たない intent では読まない。**持つ intent では必ず読む。**
    // 読まずに既定へ倒すと、畳み終わった移動が open に残り続ける。
    const detach = intent.source_detach === undefined
      ? undefined
      : readSourceStepProbe(store, intent.source_detach.operation_id);
    // lookup を thunk で渡す。完了した intent のために target repo へ接続しないかどうかは
    // `planRecovery` の判断であり、ここで先に引いてしまうとその判断が効かない。
    views.push(
      detach === undefined
        ? planRecovery(intent, () => lookup(intent), attach)
        : planRecovery(intent, () => lookup(intent), attach, detach),
    );
  }
  return ok(projectPendingIntents(store.context.repository_id, views));
}
