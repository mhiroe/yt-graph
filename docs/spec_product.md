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
- [設計原則](#設計原則)
- [制約と未決事項](#制約と未決事項)

## purpose

- YouTube channel を単位とした Discovery / Explorer tool。x-graph (X の人物探索)
  の YouTube 版。
- ユーザーがお気に入り channel を 1 本 seed に選び、類似・関連する
  「見る価値のある channel」を navigable graph 上で発見・探索する。
- 最初の MVP (Phase 1 PoC) は「seed channel から graph を育てて channel を
  発見する体験が subscription feed / search より有効か」を検証するところまで。

## scope

- Phase 1 (現 scope):
  - YouTube OAuth (自分の account) と subscriptions の読み取り
  - seed channel の選択
  - candidate discovery の 2 系統:
    - subscriptions / account signal を元にした推薦
    - ChatGPT (chappy-cli) への wall-bounce consult による候補生成
  - jev による interestingness score / filter (面白くない候補の除外)
  - channel graph の navigable 表示
  - preview-and-route UX (候補 preview → 人間が採用 / 除外を route)
  - 採用 node からのさらなる展開
- 後送り:
  - multi-user 対応、Graph DB、embedding similarity、高度な推薦 model
  - YouTube 以外 source との統合
  - 再生 viewer yt-client + ContentHub webview host 対応
    (別 repo; contenthub_pm と API 契約を調整してから組み込む)

## users and usage

- 想定ユーザー: 個人 (自分)。自分の YouTube account で OAuth login して使う。
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

## 設計原則

- AI engine / consult / judgment は交換可能な adapter。model や provider を
  code に固定しない。
- AI は候補生成と score まで。最終 route は人間。
- 「この channel を評価する」と「この channel の周辺を探索する」は別操作。

## 制約と未決事項
- YouTube Data API で related-channels 廃止後の類似 channel discovery surfaces
  (詳細は `.agent-state/` の chappy consult 記録と `docs/` 側 summary を参照)。
- OAuth scope の最小セット (v1 は `youtube.readonly` のみを想定)。
- Data API quota: `search.list` は専用 "Search Queries" bucket で default
  ~100 calls/day (2026-09-28 に Google docs で検証済み、
  `.agent-state/verification-2026-09-28.md`)。expansion の主経路は
  `playlistItems.list` / `channels.list` / `subscriptions.list`
  (shared 10k-unit bucket, 1 unit/call)。
- YouTube Home feed は Data API から取得不可 — signal として使えない。
- cold-start: seed 1 本からの candidate 展開方法。
- interestingness の定義と jev criteria。
- graph 表現 (2D/3D、edge semantics)、preview の中身。
- yt-client / ContentHub 連携の API 契約。
