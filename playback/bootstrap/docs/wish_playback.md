---
title: playback client — curated YouTube viewing over yt-graph accepted channels
kind: wish
weight: 0
visible: true
children: []
tags:
  - wish
  - playback
iteration: 1
iteration_label: bootstrap
iteration_created: 2026-09-30T15:58:11.354Z
---

# playback client: yt-graph 採用 channel の curated YouTube viewer
> [!meta]- w-01M3SGPYH2
^w-01M3SGPYH2

## ユーザーの要求 (verbatim-intent、user rulings 2026-09-29 / 2026-09-30)

- 専用の YouTube 再生 client を作り、yt-graph が収集・採用した channel を
  観る (user 2026-09-29:
  `.agent-state/decision-2026-09-29-playback-client.md`)。
- 子供も視聴に使う → 再生面は採用済み channel に限定する **curated
  surface** (open YouTube ではない)。yt-graph の accept/reject route が
  upstream の curation gate。
- 配置 (user 2026-09-30:
  `.agent-state/decision-2026-09-30-playback-client-component.md`):
  最終的には partner (dokoitsu) 側から呼び出す形になるが、まずこの repo
  内で作る。**分離可能な component** として構築し、後で clean に別 repo
  へ extraction できる構造にする。docs も component 単位で分ける
  (この file がその起点)。
- kid / UX 要件 (user 2026-09-29):
  - 視聴 limit + parental control (親ロック)。
  - 学習ポイント制 — 学習で獲得した point に応じて観られる長さ / 量を
    制御する。point source は dokoitsu (partner / points source 想定)。
    dokoitsu 側は未実装なので seam のみ用意し、未接続時は fail-soft。
  - 視聴 rhythm: 30 分の視聴ごとに 10 分の休憩を強制。
  - 基本機能として登録 channel set も視聴可。
  - 再生 browser は **ul-browser** 優先 (使えたら)。
  - アニメ channel starter set:
    `.agent-state/anime-channels-2026-09-29.md` (テレ東系 / キッズ向け
    公式 channel の seed list。curation 済みではない — accept/reject は
    人の route)。

## scope (bootstrap iteration)

- component skeleton / app scaffold (`playback/bootstrap/app`) —
  separable 構造: yt-graph core への依存は interface seam 経由のみ。
- curated channel feed: yt-graph の採用 channel set を読む
  (export seam task t-01M3RZVVED の output を consume。未着の間は
  fixture / local read で進める)。
- playback surface: ul-browser / ContentHub webview embed による動画再生。
- 視聴 limit + 親ロック (parental lock)。
- 学習ポイント gate seam (dokoitsu pipe、未接続時 fail-soft)。
- 30min/10min rhythm enforcement。

## 明示的に scope 外

- dokoitsu 側の実装 (points / learning management は partner 側の scope)。
- open YouTube browsing — 採用済み / 登録済み channel 以外を出さない。
- yt-graph core 本体の変更 (export seam 契約は post-PoC wish 側)。
- 子供向けコンテンツ自体の審査基準の精緻化 — 別途 user と詰める。

## 設計境界

- **Content safety for children is a playback-side concern** — この
  component が kid-facing surface を own する。採用判定の curation 自体は
  yt-graph の accept/reject route が担い、こちらはその結果に限定して
  表示する。
- 機械アクセス制約 (`docs/spec_product.md`「制約と未決事項」、user
  ruling 2026-09-29): login は**専用 account**、access は read-only /
  human-like pacing。再生 session も同じ専用 account 方針に従う。
- separable component 契約: `playback/` 以下の code / spec / docs は
  yt-graph repo 外へそのまま切り出せる単位。yt-graph core への参照は
  export contract (t-01M3RZVVED) 経由に限定し、core 内部への直接依存を
  作らない。
- 外部連携は adapter seam: 再生 browser (ul-browser 優先、fallback は
  ContentHub webview / yt-client)、points source (dokoitsu)。provider /
  product を engine boundary に固定しない。

## task 分解

- [ ] component skeleton / app scaffold: separable playback/bootstrap/app (own pnpm + Vite + React + TS entry、yt-graph core への依存は interface seam のみ) ^t-01M3SGQWVC
- [ ] curated channel feed: yt-graph 採用 channel set を読む (export seam t-01M3RZVVED を consume — 未着の間は fixture で fail-soft) ^t-01M3SGR0AW
- [ ] playback surface: ul-browser 優先の動画再生面 (fallback は ContentHub webview / yt-client embed、adapter seam) ^t-01M3SGR2FY
- [ ] viewing limits + parental lock: 視聴 limit の設定・強制と親ロック (親 unlock 無しに limit 変更不可) ^t-01M3SGR5HF
- [ ] learning-points gate seam: 学習 point で視聴可能な長さ/量を gate (dokoitsu pipe、未接続時 fail-soft の既定 policy) ^t-01M3SGR7S0
- [ ] viewing rhythm enforcement: 30 分視聴ごとに 10 分休憩を強制 (休憩中は再生 block) ^t-01M3SGRBKR

## 受け入れ条件

- `playback/bootstrap/app` が standalone で scaffold 起動する
  (own entry、smoke check 通過。yt-graph app 非依存)。
- curated feed が採用済み channel のみを列挙する (export seam 未着の間は
  fixture で検証)。
- 動画が再生面 (ul-browser 優先、fallback embed) で開く。
- 視聴 limit と親ロックが効く (親 unlock 無しに limit 変更不可)。
- points gate seam が dokoitsu 未接続でも fail-soft の既定 policy で動く。
- 30 分視聴後に 10 分休憩を強制する (休憩中は再生を block)。

## open questions

- readiness — 各 task の着手可否と優先順位は user が判断する。
- ul-browser が playback browser として実際に使えるか (embed / session
  維持 / 専用 account login の可否) — 未検証。使えない場合の fallback
  順序 (ContentHub webview / yt-client / system browser) を user と詰める。
- 「基本機能の登録チャンネル」の source: yt-graph 採用 set のみか、
  playback 側で別途手動登録する list も持つか。
- 学習ポイントの semantics: 獲得 / 消費レート、ledger の置き場
  (playback local か dokoitsu か)、dokoitsu 未実装の間の暫定 policy。
- 親ロックの仕組み (PIN / ローカル account / device 側制約)。
- extraction 時に `docs/spec_product.md` のどの節を component 側へ
  移すか。

## cross-wish dependencies

- **blocked by**: task t-01M3RZVVED (adopted-channel export seam) —
  post-PoC wish w-01M3RZSXN0
  (`docs/iterations/bootstrap/docs/wish_yt-graph-post-poc.md`) に残る。
  playback はこの export contract を consume する側。未着の間は
  fixture で進められるよう feed を seam の後ろに置く。
- blocks: なし (将来 dokoitsu が呼び出す playback surface の受け口になる
  が、contract が立つのは extraction 後)。
- trigger: なし。dokoitsu pipe は dokoitsu 側実装が着た時点で有効化
  (それまでは seam のみ、fail-soft)。
