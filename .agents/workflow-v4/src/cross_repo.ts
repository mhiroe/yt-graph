// cross-repo intent と recovery の pure 部分 (Slice E)。
//
// **DB も他 repo も触らない。** 引数として渡された intent と receipt の観測だけで、次に何をするかを
// 決める。IO は `sql/cross_repo.ts` (source repo 側の projection) と呼び出し側 (target repo への
// 接続) が持つ。
//
// 設計の出どころは 3 つ。
//
// - `domain.md`: `source pending intent -> target Task create -> source external relation attach
//   -> source intent completed` の順。step 別の stable operation ID を使い、target create の
//   receipt から同じ Task ID を回収して source attach を idempotent に再送する。
// - **移動はこの後ろに source detach を 1 step 足す** (裁定 O4-2 2026-09-15)。順序は local の移動と
//   同じ理由で固定する。local は「先に外すと孤立する」ので attach -> detach。cross-repo では
//   `domain.md`「repo 間で distributed transaction を行わない」により step 間の窓が任意に長いので、
//   先に外すと**どちらの repo からも指されない Task がその窓の間ずっと残る。**
// - `persistence.md`「Cross-repo recovery」: target unavailable なら pending 維持。target Task が
//   明示 dropped / missing なら**自動補償せず user 判断へ送る**。
// - `persistence.md` "Persistence boundary": intent は `OPERATIONS` と `ACTIVITIES` が持つ。
//   **専用 coordinator table を initial minimum へ追加しない。**
//
// **intent の状態を保存しない。** 開いているかどうかは「begin の receipt があって attach の
// receipt が無い」から導く。保存すると誰かが維持する必要が出て、維持されない値は嘘になる
// (`~/.config/ai-agents/instructions/laws.md`「導出できるものを保存しない」)。

import { err, ok, type Result } from "./result.ts";
import {
  type ComponentAddress,
  type ComponentId,
  formatComponentAddress,
  joinPath,
  type OperationId,
  parseComponentId,
  type RepositoryId,
} from "./ids.ts";
import type { RelationType } from "./relations.ts";
import { type Disposition, parseDisposition } from "./responses.ts";

/**
 * source repo が所有する cross-repo intent 1 件。
 *
 * `relation.begin_external` の receipt から組む。**この type に「完了したか」を持たせない。**
 * 完了は attach 側の receipt から導く ([[CrossRepoIntentView]])。
 */
export type CrossRepoIntent = {
  /** intent を開いた operation。両 repo で共通の追跡 key ではない (それは correlation_id)。 */
  readonly begin_operation_id: OperationId;
  /** 両 repo の command / receipt / activity が共有する追跡 key。 */
  readonly correlation_id: string;
  /** relation を所有する source component。必ず local repo。 */
  readonly source: ComponentAddress;
  readonly target_repository_id: RepositoryId;
  readonly relation_type: RelationType;
  /** target repo で Task を作る step の operation ID。再送でも同じ値を使う。 */
  readonly target_create_operation_id: OperationId;
  /** source repo で external relation を足す step の operation ID。 */
  readonly source_attach_operation_id: OperationId;
  /**
   * **移動の intent だけが持つ。**source repo に残っている元の relation を畳む step。
   *
   * 持たない intent は「external relation を 1 本足すだけ」で、畳む相手が無い。移動かどうかを
   * 後から推測できないので、**intent を開く時に宣言させる**。
   */
  readonly source_detach?: SourceDetachStep;
};

/**
 * source repo 側で元の relation を畳む step (裁定 O4-2 2026-09-15)。
 *
 * **caller ではなく intent が持つ。**`domain.md` は「caller が途中で消えても source repo の
 * 未完了 intent から再開できる」と決めている。畳む相手と step ID を caller の記憶に置くと、
 * caller の消滅で「まだ畳んでいない」ことも「何を畳むか」も失われ、source repo に古い relation が
 * 残ったまま誰も気付けない。`target_create_operation_id` / `source_attach_operation_id` を
 * payload に置いたのと同じ理由である。
 *
 * **新しい state を足していない。**この 2 値は begin の `OPERATIONS.payload_json` に載り、
 * 畳んだかどうかは detach step の receipt (同じく `OPERATIONS`) から導く。
 */
export type SourceDetachStep = {
  /** source repo で `relation.detach` を送る step の operation ID。再送でも同じ値を使う。 */
  readonly operation_id: OperationId;
  /** 畳む relation の相手。**source repo の local component**。 */
  readonly component_id: ComponentId;
};

/**
 * target repo の `operation.get_receipt` を引いた結果。
 *
 * **「引けなかった」と「その operation は無い」を別の値にする。** 同じ値にすると、接続できない
 * だけの repo に対して「Task は作られていない」と判断して二重に作りに行く。Slice D の
 * `EVENT_LOOKUP_UNAVAILABLE` と同じ型の区別。
 */
export type TargetReceiptProbe =
  /** receipt があった。`disposition` と、作られた component がそれ。 */
  | {
    readonly kind: "receipt";
    readonly disposition: Disposition;
    readonly result_component_id?: ComponentId;
  }
  /** 接続できたが、その operation ID の receipt が無い。まだ作っていない。 */
  | { readonly kind: "absent" }
  /** target repo へ接続できない。**「無い」と読み替えない。** */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** target repo が active RepoRegistry に無い。scope 外。 */
  | { readonly kind: "out_of_scope" };

/**
 * source repo の step の receipt。local なので引けないことは無い。
 *
 * attach と detach で同じ形を使う。どちらも「local repo の operation を 1 件引いた結果」で、
 * 区別する理由が無い。
 */
export type SourceStepProbe =
  | { readonly kind: "receipt"; readonly disposition: Disposition }
  | { readonly kind: "absent" };

/** 旧名。attach 専用だった頃の呼び出しを壊さない。 */
export type SourceAttachProbe = SourceStepProbe;

/**
 * recovery worker が次に行うこと。
 *
 * **自動補償を 1 つも持たない。** target Task の削除、別 Task の再作成、intent の破棄はどれも
 * ここに無い。`domain.md`「target 側に Task だけが残っても暗黙削除や別 Task の再作成を行わない」。
 */
export type RecoveryAction =
  /** target repo へ Task 作成を (再) 送る。同じ `target_create_operation_id` を使う。 */
  | { readonly kind: "send_target_create"; readonly operation_id: OperationId }
  /**
   * source repo へ external relation を (再) 送る。target の receipt から回収した address を使う。
   * `attach_external` は relation の重複を `noop` にするので、再送は idempotent。
   */
  | {
    readonly kind: "send_source_attach";
    readonly operation_id: OperationId;
    readonly target: ComponentAddress;
  }
  /**
   * source repo の元の relation を (再) 畳む。**移動の intent だけがここへ来る。**
   * `relation.detach` は外れている relation を `noop` にするので、再送は idempotent。
   */
  | {
    readonly kind: "send_source_detach";
    readonly operation_id: OperationId;
    readonly target: ComponentAddress;
  }
  /** すべての step が終わっている。intent は閉じている。 */
  | { readonly kind: "completed"; readonly target: ComponentAddress }
  /** target へ届かない。**pending を維持する。** 何も書かない。 */
  | { readonly kind: "hold"; readonly reason: string }
  /**
   * 人が決める必要がある。**自動で補償しない。**
   * target Task が明示 dropped / missing、または receipt が address を持たない場合。
   */
  | { readonly kind: "needs_user_decision"; readonly reason: string };

/**
 * intent 1 件の projection。
 *
 * **`status` は保存された値ではなく、この関数が receipt から導いた値である。**
 */
export type CrossRepoIntentView = {
  readonly intent: CrossRepoIntent;
  readonly status:
    | "awaiting_target_create"
    | "awaiting_source_attach"
    | "awaiting_source_detach"
    | "completed"
    | "blocked"
    | "needs_user_decision";
  readonly action: RecoveryAction;
  /** target Task が回収できていれば入る。 */
  readonly target?: ComponentAddress;
};

/**
 * target repo の receipt を引く口。
 *
 * **thunk で受け取る。** 完了した intent のために target repo へ接続しないのは、この判断の
 * 一部である。呼び出し側に「先に引いて渡す」形にすると、接続できないだけで完了した intent が
 * 未完了へ倒れる。`decide.ts` の `ComponentLookup` / `EventLookup` と同じ injected lookup の形。
 */
export type TargetReceiptProbeFn = () => TargetReceiptProbe;

/**
 * intent と receipt から次の action を決める。
 *
 * 判断は 1 か所に置く。storage 側や CLI 側で action を差し替えない (Slice D の
 * `decideCommandWithReplication` と同じ形)。
 */
export function planRecovery(
  intent: CrossRepoIntent,
  probeTarget: TargetReceiptProbeFn,
  attach: SourceStepProbe,
  // **既定を `absent` にしてよい唯一の probe。** 移動でない intent は detach step を持たないので、
  // この値を見ない。移動の intent では「まだ畳んでいない」が正しい既定で、`absent` がそれである。
  detach: SourceStepProbe = { kind: "absent" },
): CrossRepoIntentView {
  // 1. source attach が既に通っていれば、attach までは完了。**target を引きに行かない。**
  //    attach が applied / noop なら relation は source repo に入っており、それが attach の完了。
  //    address を引けるかは別の話なので、引けないことを未完了へ倒さない。
  if (
    attach.kind === "receipt" &&
    (attach.disposition === "applied" || attach.disposition === "noop")
  ) {
    return planAfterAttach(intent, detach);
  }

  // 2. attach が rejected / conflict / not_found で残っている。**再送で直らない。**
  //    conflict は owner revision のずれなので caller が読み直して出し直す必要がある。
  if (attach.kind === "receipt") {
    return {
      intent,
      status: "needs_user_decision",
      action: {
        kind: "needs_user_decision",
        reason: `source attach ${intent.source_attach_operation_id} が ${attach.disposition} で` +
          "終わっている。同じ operation ID の再送は同じ結果を返すので、" +
          "新しい operation ID で出し直すか intent を畳むかを決める必要がある",
      },
    };
  }

  // 3. target 側を見る。**引けないことを「無い」へ倒さない。**
  const target = probeTarget();
  switch (target.kind) {
    case "unreachable":
      return {
        intent,
        status: "blocked",
        action: { kind: "hold", reason: `target repo へ接続できない: ${target.reason}` },
      };
    case "out_of_scope":
      return {
        intent,
        status: "blocked",
        action: {
          kind: "hold",
          reason: `target repo ${intent.target_repository_id} が active RepoRegistry に無い`,
        },
      };
    case "absent":
      // まだ作っていない。同じ step operation ID で送る。
      return {
        intent,
        status: "awaiting_target_create",
        action: { kind: "send_target_create", operation_id: intent.target_create_operation_id },
      };
    case "receipt":
      break;
  }

  if (target.disposition === "applied" || target.disposition === "noop") {
    const componentId = target.result_component_id;
    if (componentId === undefined) {
      // receipt はあるが address が無い。**推測で Task を作らない。**
      return {
        intent,
        status: "needs_user_decision",
        action: {
          kind: "needs_user_decision",
          reason: `target create ${intent.target_create_operation_id} の receipt が ` +
            "result component を持たない。どの Task へ attach するか決められない",
        },
      };
    }
    const address: ComponentAddress = {
      repository_id: intent.target_repository_id,
      component_id: componentId,
    };
    return {
      intent,
      status: "awaiting_source_attach",
      action: {
        kind: "send_source_attach",
        operation_id: intent.source_attach_operation_id,
        target: address,
      },
      target: address,
    };
  }

  // target create が rejected / conflict / not_found。**自動補償しない。**
  return {
    intent,
    status: "needs_user_decision",
    action: {
      kind: "needs_user_decision",
      reason: `target create ${intent.target_create_operation_id} が ${target.disposition} で` +
        "終わっている。Task を作れていないので attach する相手が無い",
    },
  };
}

/**
 * attach が通った後の判断。**移動かどうかで分かれる唯一の場所。**
 *
 * 移動でない intent (`source_detach` を持たない) は、attach が通った時点で閉じている。Slice E の
 * 判断をそのまま残す。移動の intent は、**source repo に元の relation が残っている間は閉じない。**
 * 閉じてしまうと「移動したのに旧親からも指されている」状態が open から消え、誰も畳まなくなる。
 */
function planAfterAttach(intent: CrossRepoIntent, detach: SourceStepProbe): CrossRepoIntentView {
  const step = intent.source_detach;
  if (step === undefined) {
    return {
      intent,
      status: "completed",
      action: { kind: "completed", target: unknownTarget(intent) },
    };
  }
  const source: ComponentAddress = {
    // 畳む relation の相手は **source repo の local component**。`relations.ts` の relation key は
    // 必ず repository_id を伴うので、local でも address として組む。
    repository_id: intent.source.repository_id,
    component_id: step.component_id,
  };
  if (detach.kind === "absent") {
    return {
      intent,
      status: "awaiting_source_detach",
      action: { kind: "send_source_detach", operation_id: step.operation_id, target: source },
    };
  }
  if (detach.disposition === "applied" || detach.disposition === "noop") {
    // noop は「既に外れている」。移動としては attach 済み + 旧 relation 無しなので完了である。
    return {
      intent,
      status: "completed",
      action: { kind: "completed", target: unknownTarget(intent) },
    };
  }
  // rejected / conflict / not_found。**同じ operation ID の再送は同じ結果を返す。**
  // conflict は owner revision のずれなので、読み直して新しい ID で出し直す必要がある。
  return {
    intent,
    status: "needs_user_decision",
    action: {
      kind: "needs_user_decision",
      reason: `source detach ${step.operation_id} が ${detach.disposition} で終わっている。` +
        "attach は通っているので Task は移動先から指されているが、" +
        "source repo の元の relation が残っている",
    },
  };
}

/**
 * 完了した intent の target address を表す番人値。
 *
 * **`completed` は source repo の relation の存在で決まっており、target address を引けるかとは
 * 別**である。address を引くために target repo へ接続する形にすると、接続できないだけで完了が
 * 未完了へ倒れ、完了済み intent を再送し続ける。
 *
 * **実 address が要るなら `COMPONENT_RELATIONS` を読む。** attach が通っているなら relation 行が
 * source repo に入っており、そこに target address が正本として入っている。intent の projection の
 * 仕事ではない。
 */
function unknownTarget(intent: CrossRepoIntent): ComponentAddress {
  return {
    repository_id: intent.target_repository_id,
    component_id: "unrecovered" as ComponentId,
  };
}

/**
 * pending intent の一覧 projection。
 *
 * **coverage を必ず伴わせる。** 走査できなかった repo があるのに「pending 無し」と表示すると、
 * 未接続を「片付いている」と読み替えることになる。`relations.ts` の `IncomingRelationView` と
 * 同じ形にしてある。
 */
export type PendingIntentProjection = {
  readonly source_repository_id: RepositoryId;
  /** 開いている intent。`completed` は含めない。 */
  readonly open: readonly CrossRepoIntentView[];
  /** target 側を引けた repository の集合が、対象の全 target repo を満たしているか。 */
  readonly coverage_complete: boolean;
  /** coverage に含められなかった target repository。 */
  readonly missing_repository_ids: readonly RepositoryId[];
};

/** coverage が不完全な時に「pending 無し」を確定表示できないことを関数で示す。 */
export function hasNoPendingIntent(view: PendingIntentProjection): boolean | "unknown" {
  if (view.open.length > 0) return false;
  return view.coverage_complete ? true : "unknown";
}

/** intent view の集合から projection を組む。**completed を open へ混ぜない。** */
export function projectPendingIntents(
  sourceRepositoryId: RepositoryId,
  views: readonly CrossRepoIntentView[],
): PendingIntentProjection {
  const open = views.filter((view) => view.status !== "completed");
  const missing: RepositoryId[] = [];
  for (const view of views) {
    if (view.status !== "blocked") continue;
    const repositoryId = view.intent.target_repository_id;
    if (!missing.includes(repositoryId)) missing.push(repositoryId);
  }
  return {
    source_repository_id: sourceRepositoryId,
    open,
    coverage_complete: missing.length === 0,
    missing_repository_ids: missing,
  };
}

/**
 * intent の step operation ID を検査する。
 *
 * `domain.md` は「target create と source attach には **step 別の** stable operation ID を
 * 割り当てる」と決めている。同じ ID を両 step へ使うと、片方の receipt がもう片方の receipt と
 * 見分けられなくなり、recovery が「もう送った」と誤判定する。
 */
export function checkStepOperationIds(
  beginOperationId: OperationId,
  targetCreateOperationId: OperationId,
  sourceAttachOperationId: OperationId,
  sourceDetachOperationId?: OperationId,
): Result<true> {
  if (targetCreateOperationId === sourceAttachOperationId) {
    return err(
      "invalid_id",
      "target create と source attach は別の operation ID を使う必要がある",
      "source_attach_operation_id",
    );
  }
  if (beginOperationId === targetCreateOperationId) {
    return err(
      "invalid_id",
      "target create は intent を開いた operation と別の ID を使う必要がある",
      "target_create_operation_id",
    );
  }
  if (beginOperationId === sourceAttachOperationId) {
    return err(
      "invalid_id",
      "source attach は intent を開いた operation と別の ID を使う必要がある",
      "source_attach_operation_id",
    );
  }
  if (sourceDetachOperationId === undefined) return ok(true);
  // detach も step 別の ID を持つ。attach と同じ ID にすると、attach の receipt を見て
  // 「detach も送った」と読んでしまい、元の relation が残ったまま intent が閉じる。
  if (
    sourceDetachOperationId === beginOperationId ||
    sourceDetachOperationId === targetCreateOperationId ||
    sourceDetachOperationId === sourceAttachOperationId
  ) {
    return err(
      "invalid_id",
      "source detach は他の step と別の operation ID を使う必要がある",
      "source_detach_operation_id",
    );
  }
  return ok(true);
}

/**
 * `TargetReceiptProbe` を wire 形から parse する。
 *
 * **未知の kind を既定値へ落とさない。** 特に `absent` へ落とさないのが要点で、落とすと
 * 「まだ Task を作っていない」と読んで二重に作りに行く。
 */
export function parseTargetReceiptProbe(
  value: unknown,
  path?: string,
): Result<TargetReceiptProbe> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_field_type", `${path ?? "probe"} は object である必要がある`, path);
  }
  const raw = value as Record<string, unknown>;
  const kind = raw["kind"];
  if (kind === "absent") return ok({ kind: "absent" });
  if (kind === "out_of_scope") return ok({ kind: "out_of_scope" });
  if (kind === "unreachable") {
    const reason = raw["reason"];
    return ok({
      kind: "unreachable",
      reason: typeof reason === "string" && reason.length > 0 ? reason : "理由が渡されていない",
    });
  }
  if (kind === "receipt") {
    const disposition = parseDisposition(raw["disposition"], joinPath(path, "disposition"));
    if (!disposition.ok) return disposition;
    const componentRaw = raw["result_component_id"];
    if (componentRaw === undefined || componentRaw === null) {
      return ok({ kind: "receipt", disposition: disposition.value });
    }
    const componentId = parseComponentId(componentRaw, joinPath(path, "result_component_id"));
    if (!componentId.ok) return componentId;
    return ok({
      kind: "receipt",
      disposition: disposition.value,
      result_component_id: componentId.value,
    });
  }
  return err(
    "invalid_field_type",
    `${path ?? "probe"}.kind が未知である: ${JSON.stringify(kind)}`,
    joinPath(path, "kind"),
  );
}

/**
 * probe が渡されていない intent の扱い。
 *
 * **`absent` へ倒さない。** 「caller が確認していない」と「確認して無かった」は別で、前者を
 * 後者として扱うと target repo を見ないまま Task を作りに行く。`unreachable` にしておけば
 * pending が維持され、coverage も不完全として出る。
 */
export function unprobedTarget(): TargetReceiptProbe {
  return { kind: "unreachable", reason: "target receipt probe が渡されていない" };
}

/** 追跡 key を 1 行で出す。log と projection の表示で同じ形にする。 */
export function formatIntent(intent: CrossRepoIntent): string {
  return `${intent.correlation_id} ${
    formatComponentAddress(intent.source)
  } -${intent.relation_type}-> ${intent.target_repository_id}`;
}
