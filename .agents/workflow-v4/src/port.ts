// WorkflowPort の論理境界。local function、CLI、socket、FileExchange のどれで運んでも意味を変えない。
// Slice A は capability / command / change feed の形だけを固め、read model の実装は後続 slice に置く。

import type { Result } from "./result.ts";
import type { ComponentAddress, ComponentId, OperationId, RepositoryId } from "./ids.ts";
import type { ComponentKind, ComponentStatus, Revision } from "./components.ts";
import type { WorkflowCapabilities } from "./capabilities.ts";
import type { Command } from "./commands.ts";
import type { CommandResponse } from "./responses.ts";
import type { RepoCursor, SubscribeChangesResult } from "./changes.ts";

/**
 * ComponentSummary は raw Markdown、Plan tree、conversation 本文を含めない。
 * title と locator は Markdown 由来の local projection であり、workflow state の正本ではない。
 */
export type ComponentSummary = {
  readonly address: ComponentAddress;
  readonly kind: ComponentKind;
  readonly status?: ComponentStatus;
  readonly outgoing_relation_ids: readonly string[];
  readonly title_projection?: string;
  readonly document_locator?: string;
  readonly state_revision: Revision;
  readonly document_projection_revision: Revision;
};

/**
 * 一つの repo へ scope された Port。cross-repo client は repository_id で接続先 Port を選ぶ。
 * version は capabilities() の protocol_version が持つ。
 */
export interface WorkflowPort {
  readonly repository_id: RepositoryId;
  capabilities(): WorkflowCapabilities;
  submit(command: Command): Result<CommandResponse>;
  getReceipt(operationId: OperationId): CommandResponse | undefined;
  subscribeChanges(afterRepoCursor: RepoCursor | undefined): SubscribeChangesResult;
}

/** 後続 slice で実装する read query。Slice A では名前だけを capability に載せる。 */
export interface WorkflowReadPort {
  getComponentSummary(componentIds: readonly ComponentId[]): readonly ComponentSummary[];
}
