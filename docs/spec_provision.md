---
title: yt-graph provision
weight: 0
visible: true
children: []
tags:
  - provision
iteration: 0
iteration_label: init
iteration_created: 2026-10-10T16:36:39.578Z
---

# yt-graph provision

この file は `project-starter` に渡す準備入力です。
README の `children` から辿る vault の参照 node / user story を確認し、仕様判断に使う背景をここへ写してください。

## index

- [参照元 node / user story](#参照元-node--user-story)
- [目的](#目的)
- [利用者と利用場面](#利用者と利用場面)
- [成果物と MVP](#成果物と-mvp)
- [技術スタック](#技術スタック)
- [workflow 方針](#workflow-方針)
- [未確定事項](#未確定事項)

## 参照元 node / user story

- README children:
  - なし (新規 project; 仕様の正本は本 file と `docs/spec_product.md`)
- user story:
  - YouTube を見る自分が、お気に入り channel を 1 本 seed に選び、
    「見る価値のある channel」を graph 上で発見・探索するためにこの tool を使う。
- 仕様判断に効く背景:
  - seed は自分の YouTube account に紐づく。OAuth で subscriptions /
    recommendations を signal source に使う。
  - 候補は subscribed channels からの推薦と ChatGPT (chappy-cli) の wall-bounce
    consult の 2 系統から生成する。
  - 面白くない候補は除外する。interestingness の score / filter に jev
    (local judgment tool) を使う。
  - AI が最終判断しない。候補を preview し、人間が route する
    (preview-and-route UX)。
  - 再生 viewer は yt-client。ContentHub 側に webview host 対応が必要
    (contenthub_pm と連携)。ad blocking は AdGuard を使う。

## 目的

- YouTube channel を単位とした Discovery / Explorer tool を作る。
  x-graph (X の人物探索) の YouTube 版。
- 解決したい問題: YouTube の standard recommendation / subscription feed では、
  自分の嗜好に合う「まだ知らない面白い channel」を能動的に探索しにくい。
- Phase 1 (PoC) が検証するのは推荐精度ではなく、
  「seed channel から graph を育てて channel を発見する体験が
  subscription feed / search より有効か」。

## 利用者と利用場面

- 想定ユーザー: 自分 (個人利用)。自分の YouTube account で OAuth login し、
  好きな channel を seed に選んで類似・関連 channel を探索したい場面。
- 典型 flow: OAuth auth → seed channel 選択 → candidate 生成
  (subscriptions-based + chappy consult) → jev で interestingness filter →
  graph 表示 → node 選択で channel preview → 採用 / 除外 route →
  採用 node からさらに展開。

## 成果物と MVP

- 最初の成果物: 自分 1 人で動く最小 prototype。
- MVP 範囲 (Phase 1):
  - YouTube OAuth (自分の account; subscriptions 読み取り)
  - seed channel 選択
  - candidate discovery (subscriptions signal + chappy-cli consult)
  - jev による interestingness score / filter
  - channel graph の navigable 表示
  - preview-and-route UX (候補 preview → 採用 / 除外)
- MVP に入れないもの: multi-user、Graph DB、高度な推薦 model、
  YouTube 以外 source との統合。
- 別 repo 依存: 再生 viewer yt-client + ContentHub webview host 対応
  (contenthub_pm と連携; 本 repo の MVP 外だが preview 経路として設計に組み込む)。

## 技術スタック

- 主言語:
  - TypeScript (user 確定 2026-09-28; x-graph と揃える)
- framework / app 形態:
  - Web UI を core とする: React + Three.js (graph) + Vite (user 確定 2026-09-28; x-graph 準拠)
  - local API と SQLite (user 確定 2026-09-28)
  - AI engine は交換可能な adapter (chappy-cli / jev を boundary の外に置く)。
    model を code に固定しない。
- runtime / package manager:
  - pnpm (user 確定 2026-09-28)
- 外部 integration:
  - YouTube Data API v3 + OAuth 2.0 (Google account)
  - chappy-cli (ChatGPT consult; ContentHub transport)
  - jev (local judgment CLI)
  - AdGuard (ad blocking; 利用環境側)
- test / lint:
  - PoC 期間は最小限 (typecheck + build が通ること + smoke)

## workflow 方針

- workflow series:
  - 4
- test style:
  - smoke (PoC; user 確定 2026-09-28)
- DDD:
  - none (PoC; user 確定 2026-09-28)
- git-worktree:
  - off (user 確定 2026-09-28)

## 未確定事項

- YouTube Data API で related-channels 廃止後の類似 channel 発見 surfaces
  (subscriptions / search / video→channel 経路の組み合わせ; chappy consult で設計)
- OAuth scope の最小セットと quota 戦略 (Data API の quota 厳しい)
- cold-start: seed 1 本からどう candidate を広げるか
- interestingness の定義と jev への criteria 設計 — 初期 criteria は relevance / novelty / signal density / distinctiveness で user 確定 2026-09-28
- graph 表現: node/edge の意味 (channel 類似度? 共通 audience?) — 3D (Three.js) は user 確定 2026-09-28
- preview の中身 (最新動画 list? channel metadata? yt-client embed?)
- yt-client / ContentHub 連携の API 契約 (contenthub_pm と要調整)
