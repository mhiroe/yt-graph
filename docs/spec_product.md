---
title: product spec
weight: 0
visible: false
children: []
tags:
  - spec
---

# product spec

## index

- [purpose](#purpose)
- [scope](#scope)
- [users and usage](#users-and-usage)
- [I/O and main flows](#io-and-main-flows)
- [technical prerequisites](#technical-prerequisites)
- [discovery strategy](#discovery-strategy)
- [設計原則](#設計原則)
- [制約と未決事項](#制約と未決事項)

## purpose

- YouTube channel を単位とした Discovery / Explorer tool。x-graph (X の人物探索)
  の YouTube 版。
- 目的は YouTube 推薦のような「既知の好みに近いもの」ではなく、
  **興味の延長線上にある未知・意外性のある channel の発見**
  (serendipity)。距離 0〜1 は YouTube に任せ、yt-graph は 2〜4 hop を
  狙う (2026-09-29 consult)。
- ユーザーがお気に入り channel を 1 本 seed に選び、類似・関連する
  「見る価値のある channel」を navigable graph 上で発見・探索する。
- 最初の MVP (Phase 1 PoC) は「seed channel から graph を育てて channel を
  発見する体験が subscription feed / search より有効か」を検証するところまで。

## scope

- Phase 1 (現 scope):
  - YouTube OAuth (自分の account) と subscriptions の読み取り
  - seed channel の選択
  - candidate discovery の系統 (2026-09-29 consult で拡張):
    - subscriptions / account signal を元にした推薦
    - relation-edge walk: seed の周辺を collab / event・community /
      reference / influence / behavioral-similarity の edge で辿る
    - collaborative filtering: 自分と登録が部分重複する viewer の
      subscription gap (missing edge) 抽出 — 実現性は未検証
    - ChatGPT (chappy-cli) への wall-bounce consult による候補生成
  - jev による interestingness score / filter (面白くない候補の除外)
  - channel graph の navigable 表示
  - preview-and-route UX (候補 preview → 人間が採用 / 除外を route)
  - 採用 node からのさらなる展開
  - 調査画面: 収集済み channel / candidate を人が掘る inspection UI
    (x-graph の review surface と同発想 — 詳細・evidence・AI 評価・
    関連 edge を一覧)。user 指示 2026-09-29。
  - adhoc mode: pipeline / 定期 run とは別に、人間起点の one-shot
    探索・評価アクション (例: この channel を今すぐ展開、この候補を
    今評価)。user 指示 2026-09-29。
- 後送り:
  - multi-user 対応、Graph DB、embedding similarity、高度な推薦 model
  - YouTube 以外 source との統合
  - 再生: 専用 YouTube 再生 client を別途作る方針 (user 2026-09-29)。
    yt-graph が収集・採用した channel を観るための viewer で、
    **子供の視聴にも使う**想定 → 表示対象は採用済み channel に限定する
    curated surface。yt-client / ContentHub webview host との関係は
    別 repo 側で詰める (contenthub_pm と API 契約を調整してから組み込む)

## users and usage

- 想定ユーザー: 個人 (自分)。自分の YouTube account で OAuth login して使う。
  - 副次的利用: 再生は専用 client 経由で**子供も使う**想定
    (user 2026-09-29) — 再生面は採用済み channel に限る curated
    surface であることが前提。
- 典型 flow: OAuth auth → seed channel 選択 → candidate 生成 → jev filter →
  graph 表示 → node 選択で channel preview → 採用 / 除外 route。
- AI の score は最終判断に使わない。preview を見て人間が route する。

## I/O and main flows

- Input:
  - YouTube account の OAuth grant と subscriptions / recommendations signal
  - seed channel (ユーザーが 1 本選択)
  - chappy-cli 経由の ChatGPT consult 結果 (候補 channel list)
  - jev の interestingness 判定
  - ユーザーの採用 / 除外 route 操作
- Output:
  - channel graph (node = channel; edge の意味付けは未決 — 類似度 / 共通
    audience / consult 由来など)
  - channel preview (metadata / 代表動画)
- Main flows:
  - auth → seed → discover → filter → graph → preview → route → expand

## technical prerequisites

- Primary language: `TypeScript`
- framework / app shape: `React + Three.js (3D graph) + Vite web UI over a local API (SQLite)`
- runtime / package manager: `pnpm`
- formal test: `pnpm test`
- lint: `pnpm lint`
- external integrations:
  - YouTube Data API v3 + OAuth 2.0 (scope と quota 戦略は未決; chappy consult 参照)
  - chappy-cli (ChatGPT consult; ContentHub file transport)
  - jev (local judgment CLI)
  - AdGuard (ad blocking; 利用環境側)
  - yt-client / ContentHub webview host (別 repo 依存)
  - dokoitsu (個人 concierge agent; Curiosity Profile の将来 source —
    未実装、adapter seam で接続)

## discovery strategy

2026-09-29 の chappy consult で固めた方向
(record: `.agent-state/chappy-consult-2026-09-29-discovery.md`;
note: `docs/chatgpt/YouTube発見方法比較.md` — gitignored)。

- 候補評価の軸: Interest × Novelty × Distance × Surprise。
- User Curiosity Profile: ジャンル / keyword の集合ではなく「何を
  面白いと感じるか」の活動パターン (Topic / Activity / Social /
  Style)。フィルターではなく探索の出発点として使い、profile からの
  距離を変える distance knob を持つ。accept/reject 履歴と channel ごと
  の「ここが好き」一言で学習させる構想。X 探索等との共通化も視野。
  実データの供給元は **dokoitsu** (個人 concierge agent、ユーザーの
  情報を蓄積する側) を想定 — dokoitsu 側は未実装なので、yt-graph は
  profile source を adapter seam として用意し pipe を意識する
  (user 指示 2026-09-29)。
- candidate 発見は keyword search 中心にしない。入口だけ検索し、
  channel / 人間関係を graph walk で辿る。
- collaborative filtering: 自分と登録 channel が一部重なる viewer を
  見つけ、その人が登録していて自分が未登録の channel (gap /
  missing edge) を候補にする。「既知領域は似るが未知領域を持つ人」
  (~50% overlap) を重視し、複数の似た viewer が共有する未知
  channel を強い signal とする。
- 評価は段階的: Tier 0 metadata → Tier 1 transcript → Tier 2 sampled
  frames / VLM → Tier 3 強い LLM/VLM。複数動画を横断して「この
  channel では繰り返し何が起きているか」(Channel Activity DNA) を
  抽出し、DNA と Curiosity Profile の適合を jev 等の安価な層で大量
  判定する。
- 二段構え: 人間の嗜好 graph が候補を発見 → AI が意味・面白さを理解
  → 人間が採用 / 却下。scout は候補を持ち帰るだけで決定しない。

## 設計原則

- AI engine / consult / judgment は交換可能な adapter。model や provider を
  code に固定しない。
- AI は候補生成と score まで。最終 route は人間。
- 「この channel を評価する」と「この channel の周辺を探索する」は別操作。

## 制約と未決事項
- 機械アクセス判定への配慮 (user ruling 2026-09-29): YouTube への自動
  アクセスは human-like pacing / read 主体に留め、検知・BAN リスクを
  抑える。ログイン session は本人の main account ではなく**専用
  account** で行う — 自動巡回が account の推薦 profile / 状態を汚損
  するため。ContentHub session adapter は専用 account で login する前提。
  「自分の subscriptions」baseline は専用 account では取れない点に注意
  (本人 channel の公開 subscriptions 経由か、専用 account への複製かは
  未決)。
- YouTube Data API で related-channels 廃止後の類似 channel discovery surfaces
  (詳細は `.agent-state/` の chappy consult 記録と `docs/` 側 summary を参照)。
- OAuth scope の最小セット (v1 は `youtube.readonly` のみを想定)。
- Data API quota: `search.list` は専用 "Search Queries" bucket で default
  ~100 calls/day (2026-09-28 に Google docs で検証済み、
  `.agent-state/verification-2026-09-28.md`)。expansion の主経路は
  `playlistItems.list` / `channels.list` / `subscriptions.list`
  (shared 10k-unit bucket, 1 unit/call)。
- YouTube Home feed は Data API から取得不可 — signal として使えない。
- collaborative filtering 経路の実現性 (未検証 2026-09-29): 他人の公開
  subscriptions の取得可否 (ContentHub session 経路と Data API 双方)、
  「似た viewer」を見つける入口 (comment author 等)、similarity /
  gap の scoring 方式。
- Channel Activity DNA の schema、transcript と VLM の切り分け基準。
- Curiosity Profile: 明示入力か accept/reject 履歴からの学習か、
  dokoitsu 蓄積データからの供給か (user 2026-09-29: dokoitsu pipe を
  意識する方針。dokoitsu 側は未実装)。
- cold-start: seed 1 本からの candidate 展開方法。
- interestingness の定義と jev criteria。
- graph 表現 (2D/3D、edge semantics)、preview の中身。
- yt-client / ContentHub 連携の API 契約。
