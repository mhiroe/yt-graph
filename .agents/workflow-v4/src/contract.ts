// 共有 contract の公開入口。**consumer が取り込むのはこの file であり、`mod.ts` ではない。**
//
// ここから辿れる範囲は browser-safe な pure contract だけに保つ。identity / domain / relation /
// protocol / capability / command / response / idempotency / change feed / decide / fixture。
//
// Slice D で replication contract (`replication.ts`) を足した。Journal record は device を跨ぐ
// wire 形なので、version と digest を固定した artifact で受け渡し先と合わせる必要がある。
// persistence 側 (`sql/replication.ts`) はここから辿れない。
//
// Slice E で cross-repo intent contract (`cross_repo.ts`) を足した。intent と recovery action は
// 2 つの repo の間で意味を合わせる必要があるので、pure contract 側に置く。source repo 側の
// projection 実装 (`sql/cross_repo.ts`) はここから辿れない。
//
// Slice C で document contract (`document.ts` / `region.ts` / `document_ops.ts`) を足した。
// 3 つとも pure で、file も hash binding も辿らない。filesystem を触る `adapters/fs_document.ts`
// と CLI (`cli/*`) はここから辿れない側に置く。
//
// artifact 0.10.0 で所属の書きの codec (`children.ts`) を足した。親 node の `children` property を
// 読む規則を plugin (bridge) と共有するため、pure contract 側に置く。
// artifact 0.11.0 で task block の codec (`task_block.ts`) を足した。理由は同じ。
//
// `sql/*` と `adapters/*` と `cli/*` をここへ足さない。persistence は dotfiles 側 Core の実装であって
// 共有 contract ではない。artifact 生成はこの file から import graph を辿るので、ここへ 1 行足すと
// そのまま consumer の配布物が増える。生成 check が `sql/` と `adapters/` の混入を拒否する。

export * from "./result.ts";
export * from "./ids.ts";
export * from "./vault_ids.ts";
export * from "./components.ts";
export * from "./transitions.ts";
export * from "./relations.ts";
export * from "./protocol.ts";
export * from "./repository.ts";
export * from "./capabilities.ts";
export * from "./commands.ts";
export * from "./decide.ts";
export * from "./responses.ts";
export * from "./idempotency.ts";
export * from "./changes.ts";
export * from "./replication.ts";
export * from "./port.ts";
export * from "./document.ts";
export * from "./region.ts";
export * from "./document_ops.ts";
export * from "./children.ts";
export * from "./task_block.ts";
export * from "./cross_repo.ts";
// artifact 0.20.0。iteration の label / path 規則と generated frontmatter key の
// upsert は browser 側でも必要 (wishboard が `iteration:` property を読む) ので
// pure contract 側に置く。`sql/iterations.ts` と `adapters/fs_iteration.ts` は
// ここから辿れない。
export * from "./iterations.ts";
// artifact 0.29.0。sprint の row 形 / registry (docs/sprints.md v2) parse / `sprint:`
// callout key の codec — committed tree を読む consumer (wishboard) が使うので
// pure contract 側に置く。`sql/sprints.ts` はここから辿れない。
export * from "./sprints.ts";
