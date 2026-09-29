---
title: yt-graph rules
weight: 0
visible: false
children: []
tags:
  - rule
---

# yt-graph rules

**Only laws that apply to this repo go here.** Anything that would change with the implementation does not belong.

This repo uses the **workflow v4 series**. The canonical format for this file (layer split,
markers, placement test) is the vendored
`.agents/skills/workflow-v4-contract/references/contract-format.md` — this repo's markers stay
`scope:` / `constitution:` as written here; do not mix conventions mid-repo.

| layer | location | scope |
| --- | --- | --- |
| constitution | `~/.config/ai-agents/instructions/constitution.md` | all repos; changes the workflow itself |
| shared laws | `~/.config/ai-agents/instructions/laws.md` | multiple repos |
| repo laws | this file | this repo only |

The constitution is already read at session entry, so this file does not carry it. Principles
that are the project's reason to exist point at `README.md` and `docs/spec_product.md` as
canonical; do not copy their bodies here.

## index

- [what belongs](#what-belongs)
- [scope of application](#scope-of-application)
- [laws](#laws)

## what belongs

- A law is durable policy that survives task completion — something a task ending cannot
  invalidate. If a decision dies with its task, it is not a law.
- **Do not restate what an upper layer already holds.**

## scope of application

- Each law carries one `scope:` line and one `constitution:` line. Do not create a law missing
  either. `constitution:` names the constitutional clause it concretizes; for a repo-local
  convention write `constitution: none (repo autonomy)`.
- This file holds **this repo's vocabulary only**.
- Areas of interest: `adapters` (YouTube Data API / chappy / jev / yt-client
  boundaries), `discovery` (pipeline / quota / provenance schema), `ui`
  (graph / preview-route), `全域` (repo-wide only).
- Write `全域` (repo-wide) only for what truly applies everywhere; when in doubt, scope it.

## laws

Ordered by scope of application.

- Newly settled decisions are promoted here by `done`; do not fill sections ahead of need.
- Do not split files per area until this file overflows; when splitting, add `docs/rule_*.md` files.

### agent traffic

scope: 全域
constitution: none (repo autonomy)

- agent 間の prompt / report / `.agent-state/` 記録は英語のみとする (gm ruling 2026-09-27)。
  - ユーザー原文が日本語の場合はファイルに書き、英語の意味 + path を送る。
- ユーザーに届くものは bare wish/task id を先頭にしない — 人間可読の title を先に出す。

### YouTube Data API quota

scope: adapters
constitution: none (repo autonomy)

- `search.list` を discovery expansion の主経路にしない。
  - dedicated "Search Queries" bucket で default ~100 calls/day
    (2026-09-28 に Google docs で検証済み)。
  - expansion の主経路は `playlistItems.list` / `channels.list` /
    `subscriptions.list` (shared 10k-unit bucket) とする。

### source adapter seam

scope: adapters
constitution: none (repo autonomy)

- YouTube 取得は `server/sources/` の `SourceAdapter` interface 越しのみ。
  選択は `YTG_SOURCE` env (`fixture` 既定 / `contenthub`)。認証情報を
  要求する実装を pipeline 側に直接書かない (2026-09-29, t-01M3NXG5G2)。
  - `mySubscriptions()` は optional — session を持つ adapter のみが実装する。

### discovery funnel boundary

scope: discovery
constitution: none (repo autonomy)

- pipeline の deterministic cleanup 段では score を付けない。
  落とすのは seed 自身 / 重複 / 既に human reject 済み / provenance 無し
  のみ (2026-09-29, t-01M3NXG93D)。面白さの判定は jev 段以降の仕事。
- search 系 expansion は 1 pass あたり最大 2 query に抑える
  (quota law に連動)。

### local store

scope: 全域
constitution: none (repo autonomy)

- ローカル DB は `node:sqlite` (Node 22, `--experimental-sqlite` flag 要) を
  使う。native module (better-sqlite3 等) は PoC では持ち込まない
  (2026-09-29, t-01M3NXF509 で確定 — install を credential/ネイティブ
  build 無しで通すため)。
