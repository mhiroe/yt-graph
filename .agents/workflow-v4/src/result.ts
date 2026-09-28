// Slice A の pure contract は例外を投げず、すべて Result で返す。
// unknown 値を既定値へ落とさないため、失敗は必ず code 付きの WorkflowError になる。

/** 失敗 code。新しい失敗を足す時は、既存 code へ寄せずにここへ追加する。 */
export type WorkflowErrorCode =
  // identity / id
  | "invalid_id"
  | "invalid_address"
  | "repository_id_mismatch"
  | "duplicate_repository_entry"
  // 既存 vault ID の登録 (bugfix 6)。ID の prefix (`m` / `w` / `t`) と kind の食い違い。
  | "component_id_kind_mismatch"
  // kind / status
  | "unknown_component_kind"
  | "unknown_status"
  | "status_not_allowed_for_kind"
  | "missing_status"
  | "unexpected_status"
  // relation
  | "unknown_relation_type"
  | "relation_source_not_local"
  | "relation_self_reference"
  // transition
  | "illegal_transition"
  | "terminal_status"
  // protocol / capability
  | "unknown_protocol_version"
  | "protocol_incompatible"
  | "unsupported_operation"
  | "unsupported_query"
  | "unsupported_feature"
  // command envelope
  | "unknown_operation"
  | "missing_field"
  | "unexpected_field"
  | "invalid_field_type"
  | "target_id_required"
  | "target_id_forbidden"
  | "expected_revision_required"
  | "expected_revision_forbidden"
  | "invalid_revision"
  // idempotency
  | "operation_id_reused"
  // change feed
  | "cursor_not_repo_scoped"
  | "change_notification_carries_body"
  // document (Slice C)
  | "invalid_locator"
  | "ambiguous_locator"
  | "locator_escapes_repository"
  | "document_not_found"
  | "unknown_region_name"
  | "unknown_request_kind"
  // document (Slice E)
  //
  // `document_region_unresolved` と `id_anchor_placement_undecided` を落とした。どちらも
  // 「まだ決めていない」を表す code だったが、Slice E 第 1 段の実測で両方とも決着したので、
  // 未決を表す code を残さない。残すと呼び出し側が「後で決まる」前提の retry を書ける。
  //
  // - named region は記法が未確定だったのではなく Markdown に存在しなかった
  //   (`document_region_not_in_markdown`)。
  // - anchor の置き場は未定義ではなく未作成だった。register が作るので失敗しない。
  | "document_region_not_in_markdown"
  | "document_region_contains_foreign_identity"
  | "title_rename_requires_file_move"
  // document (所属の書き、artifact 0.10.0)
  //
  // 所属の正本は親 node の `children` property。frontmatter は file root node の持ち物なので、
  // heading node を親にした write は `children_requires_file_root`。実測に無い形は
  // `children_shape_unsupported` で止め、推測で読まない。
  | "children_requires_file_root"
  | "children_shape_unsupported"
  | "frontmatter_missing"
  | "invalid_child_link"
  // document (mind -> wish の id 要素、artifact 0.13.0)
  //
  // mind が wish を id で持つ (`my-wish-data.md` の hierarchy 節)。id 要素を書けるのは
  // `kind: mind` の file だけ。wish の `children` は今までどおり node link。
  | "invalid_child_id"
  | "children_id_requires_mind"
  // document (heading hierarchy の移動、artifact 0.10.0)
  //
  // file 内の heading node の所属は heading hierarchy が表す。移動は subtree を丸ごと運び、
  // identity と本文を 1 byte も変えない。運べない形はそれぞれの code で止める。
  | "heading_move_requires_heading_node"
  | "heading_move_crosses_file"
  | "heading_move_into_own_subtree"
  | "heading_move_exceeds_depth"
  | "heading_move_swallows_nodes"
  | "document_structure_unreadable"
  // replication (Slice D)
  | "invalid_sequence"
  | "replication_source_is_local"
  | "journal_sequence_reused"
  | "event_not_found"
  | "event_aggregate_mismatch"
  | "adopted_event_not_in_conflict"
  // iteration (schema 6)。label / component_path の形と scope の種類。
  | "invalid_iteration_scope"
  | "invalid_iteration_label"
  | "reserved_iteration_label"
  | "invalid_component_path";

export type WorkflowError = {
  readonly code: WorkflowErrorCode;
  readonly message: string;
  /** 失敗した位置。envelope や payload の field path を入れる。 */
  readonly path?: string;
};

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkflowError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(code: WorkflowErrorCode, message: string, path?: string): Result<T> {
  return { ok: false, error: path === undefined ? { code, message } : { code, message, path } };
}

/** Result 配列を畳む。最初の失敗をそのまま返す。 */
export function collect<T>(results: readonly Result<T>[]): Result<T[]> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
