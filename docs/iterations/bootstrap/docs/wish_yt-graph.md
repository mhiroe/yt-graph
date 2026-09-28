---
title: yt-graph PoC — seed-based YouTube channel discovery graph
kind: wish
weight: 0
visible: true
children: []
tags:
  - wish
  - yt-graph
iteration: 1
iteration_label: bootstrap
iteration_created: 2026-09-27T12:49:44.864Z
---

# yt-graph PoC: seed から育てる YouTube channel discovery graph
> [!meta]- w-01M3HEP6BP
^w-01M3HEP6BP

## ユーザーの要求 (verbatim-intent, via gm brief 2026-09-27)

- x-graph-like explorer for YOUTUBE CHANNELS. User picks ONE favorite
  channel as the seed; the tool discovers similar/interesting channels
  and presents them as a navigable graph.
- tied to the user's OWN YouTube account → OAuth auth is in scope
  (subscriptions/recommendations as signal source).
- recommend from the user's subscribed channels.
- uninteresting candidates are filtered out — jev (local judgment tool)
  is expected to help score/filter.
- ChatGPT (via chappy-cli) also generates candidate channels —
  wall-bounce consult is the PM's own task.
- preview candidates then channel through (preview-and-route UX).
- playback viewer is yt-client, which needs ContentHub-side support
  (webview host); coordinate via contenthub_pm when ready.
- ad blocking: use AdGuard.

## 設計 baseline (chappy consult 2026-09-27)

Consult record: `.agent-state/chappy-discovery-consult-2026-09-27.md`
(verbatim response: `-full.md`; chappy note:
`docs/chatgpt/YouTube Discovery Pipeline.md`).

- related-channels discovery API は廃止済み → 複数の弱い signal を
  集約する pipeline を組む。
- Discovery sources (v1 は 4 系統):
  1. seed uploads → semantic search (`search.list`)
  2. seed channel の public subscriptions
  3. seed channel の public playlists (外部 channel 動画を含むもの)
  4. ユーザーの subscriptions → seed-neighborhood prior
- Filter funnel: raw 200–500 → deterministic cleanup → cheap relevance
  → jev judgment (relevance / novelty / signal density /
  distinctiveness) → 30–50 → human preview (accept / reject / later)。
- OAuth scope は `youtube.readonly` のみ。public surface は API key。
  YouTube Home feed は Data API から取れない (要 user 注意喚起済み)。
- Schema は provenance-first: `channel` / `edge` /
  `discovery_evidence` / `channel_snapshot` / `judgment` /
  `human_decision`。
- AI (chappy / jev) は候補生成と score まで。最終 route は人間。

## scope (Phase 1 PoC)

- YouTube OAuth (readonly) + subscriptions 取得
- seed channel 選択 → candidate discovery → jev filter → graph 表示
- channel preview → 採用 / 除外 / 保留 route → 採用 node からの展開
- 後送り: comments/audience overlap、Graph DB、multi-user、
  yt-client / ContentHub playback 連携 (別 repo 依存、API 契約は
  contenthub_pm と調整)

## task 分解 (planner draft — readiness 判断と共に提示)

- [ ] app skeleton: pnpm + Vite + React + TS + local API + SQLite schema
- [ ] YouTube OAuth + API client adapter (`youtube.readonly`; API key
      fallback for public surfaces; quota-aware)
- [ ] discovery pipeline: seed fingerprint → search/subscriptions/
      playlists expansion → candidate merge with provenance
- [ ] chappy-cli consult adapter (candidate generation, wall-bounce)
- [ ] jev judgment adapter (interestingness criteria, score/filter)
- [ ] graph UI + preview-and-route UX + judgement persistence
- [ ] acceptance: 1 seed → candidates → preview → route → expand が
      1 周動くこと

## 受け入れ条件

- `pnpm install` → `pnpm dev` で UI + API が起動する (README 同一 diff)。
- OAuth で自分の subscriptions が読める。
- seed channel を 1 本選ぶと candidate が graph に出る (provenance 付き)。
- jev filter を通った候補だけが preview 対象になる。
- preview → accept / reject / later が永続化される。
- accept した node から再展開できる。

## 判断が要る点 (user / doit 中)

- tech stack 仮置きの確定 (TS / React+Three.js+Vite / pnpm /
  smoke / ddd none / worktree off — x-graph 準拠)。
- Google Cloud project / OAuth client の用意 (user 側の credential)。
- `search.list` quota: 検証済み 2026-09-28 (`.agent-state/verification-2026-09-28.md`)。
  現行ルールは 1 unit/call・専用 "Search Queries" bucket で default
  ~100 calls/day。search 拡張は seed-fingerprint query に絞り、
  playlistItems/channels/subscriptions (shared 10k bucket) を主経路にする。
- interestingness の criteria 具体定義 (jev への渡し方)。
- graph は 3D (Three.js) か 2D か — x-graph 準拠なら 3D。
- preview の中身 (channel metadata + 代表動画; yt-client embed は
  ContentHub 対応待ち)。
