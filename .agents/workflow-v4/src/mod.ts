// dotfiles 側 Workflow Core の公開入口。
// 共有 contract に加えて、この repo の persistence 実装までを公開する。
//
// **consumer 向けの入口はこの file ではなく `contract.ts`。**
// `sql/*` は dotfiles 側 Core の実装であり、共有 contract artifact には含めない。
// runtime binding (`adapters/node_sqlite.ts`) はここからも公開しない。
// 公開入口が `node:sqlite` を辿ると、wishboard の browser build が壊れる。

export * from "./contract.ts";

export * from "./sql/driver.ts";
export * from "./sql/schema.ts";
export * from "./sql/store.ts";
export * from "./sql/transaction.ts";
export * from "./sql/document_projection.ts";
export * from "./sql/replication.ts";
export * from "./sql/cross_repo.ts";
export * from "./sql/iterations.ts";
export * from "./wish_query.ts";

// Harness。**共有 contract ではない。**
// wishboard は planner / doit / done を走らせないので、artifact へ入れない。
export * from "./harness/skill_adapter.ts";
export * from "./harness/phase_runner.ts";
