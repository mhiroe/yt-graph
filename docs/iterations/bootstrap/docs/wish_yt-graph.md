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
Consult record (2026-09-29, discovery strategy 拡張):
`.agent-state/chappy-consult-2026-09-29-discovery.md` — 詳細は
`docs/spec_product.md` "discovery strategy" を正本とする。
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
- 再生の方向 (user 2026-09-29): 専用 YouTube 再生 client を別途作り、
  yt-graph の収集・採用 channel を観る。子供も視聴に使うため、
  再生面は採用済みに限る curated surface (詳細は spec_product.md)。
- 追加 direction (user 2026-09-29): x-graph 同様の調査画面 (inspection
  UI) と adhoc mode (人間起点の one-shot 探索/評価)。詳細は
  `docs/spec_product.md` scope / 制約。
- 制約 (user 2026-09-29): 機械アクセス判定に注意。自動巡回は本人
  account を汚損するため、ログインは**専用 account** で行う。
  ContentHub adapter 依頼へ addendum 済み。
- 補足 (user 2026-09-29): 自分の好み (Curiosity Profile) の実データは
  dokoitsu が蓄積する想定 (dokoitsu 側は未実装)。yt-graph は profile
  source を adapter seam として用意し、dokoitsu への pipe を意識する。

## task 分解 (planner 2026-09-28 — 夜間 PoC run 用に再分解)

夜間 run (2026-09-29 01:00 JST 頃開始) は user credential 無しで進む順に並べる。
YouTube 取得は adapter の背後に置き、credential が無い間は fixture adapter で
pipeline と UI を通す。

- [ ] app skeleton: pnpm + Vite + React + TS + Three.js 3D graph + local API +
      SQLite provenance-first schema (channel / edge / discovery_evidence /
      channel_snapshot / judgment / human_decision)
  - smoke: `pnpm install` → `pnpm dev` で UI + API 起動、README 同一 diff
- [ ] YouTube source adapter: interface + fixture adapter (credential 不要)
  - data source は ContentHub のログイン済みセッション経由 (x-graph 方式、user 確定
    2026-09-28)。ContentHub 側 adapter は contenthub_pm に依頼済み; 届いたら
    ContentHub 実装を差し込む。API-key adapter は不採用 (理由:
    `.agent-state/decision-2026-09-28-readiness.md`)
- [ ] discovery pipeline: seed fingerprint → search / subscriptions / playlists
      expansion → candidate merge with provenance → deterministic cleanup
  - fixture adapter で 1 seed → candidate 群が provenance 付きで DB に入る
  - discovery の方向は 2026-09-29 consult で拡張 (spec_product.md
    "discovery strategy"): relation-edge walk と subscription-gap
    collaborative filtering、段階評価 (Channel Activity DNA)。PoC の
    fixture 範囲は変えず、expansion source の設計余地として記録。
- [ ] jev judgment adapter: 初期 criteria relevance / novelty / signal density /
      distinctiveness (user 確定 2026-09-28) で score / filter
- [ ] chappy consult adapter: ChatGPT で candidate 生成 (wall-bounce)
  - 前提: ContentHub 起動 + chappy main slot の ChatGPT login。未 login なら
    adapter は skip して他 source で続行 (夜間 run を止めない)
- [ ] graph UI + preview-and-route UX (accept / reject / later 永続化) +
      accept node からの再展開
  - UI 系は x-graph 同様の調査画面 (inspection) と adhoc 操作の土台に
    なるよう意識する (user 指示 2026-09-29; PoC では preview/route が
    先行、調査画面・adhoc mode の詳細は spec_product.md scope 参照)
- [ ] acceptance (fixture): 1 seed → candidates → jev → preview → route →
      expand が 1 周動く
- [ ] user subscriptions signal (ContentHub session 経由) — **夜間対象外**:
      ContentHub 側 adapter の到着待ち
  - 旧案 YouTube OAuth (`youtube.readonly`) は 2026-09-28 に不採用 (ContentHub
    session 経路へ切替; 理由は `.agent-state/decision-2026-09-28-readiness.md`)

## 受け入れ条件

- `pnpm install` → `pnpm dev` で UI + API が起動する (README 同一 diff)。
- OAuth で自分の subscriptions が読める。
- seed channel を 1 本選ぶと candidate が graph に出る (provenance 付き)。
- jev filter を通った候補だけが preview 対象になる。
- preview → accept / reject / later が永続化される。
- accept した node から再展開できる。

## 判断が要る点 (user / doit 中)

- tech stack: user 確定 2026-09-28 (TS / React+Three.js+Vite / pnpm /
  smoke / ddd none / worktree off)。
- Google Cloud project / OAuth client の用意 (user 側の credential)。
- `search.list` quota: 検証済み 2026-09-28 (`.agent-state/verification-2026-09-28.md`)。
  現行ルールは 1 unit/call・専用 "Search Queries" bucket で default
  ~100 calls/day。search 拡張は seed-fingerprint query に絞り、
  playlistItems/channels/subscriptions (shared 10k bucket) を主経路にする。
- interestingness の初期 criteria は user 確定 2026-09-28 (4 基準)。jev への渡し方は jev adapter task で決める。
- graph は 3D (Three.js): user 確定 2026-09-28。
- preview の中身 (channel metadata + 代表動画; yt-client embed は
  ContentHub 対応待ち)。
