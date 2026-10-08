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

## 追加 direction (user 2026-09-30 — 実装形態の可能性)

- ユーザーは別途、dokoitsu 側へ**ペアレンタルコントロール付きの
  視聴アプリ**を依頼している。そのアプリのベースは ul-browser で、
  その中で YouTube 視聴機能を再構築する可能性がある。
- その場合、この playback client は**独立 client ではなく機能群**
  (curated feed / limits+lock / points gate / rhythm) として統合される
  可能性が高い —「client はそこと統合する可能性、つまり機能だけと
  なる可能性」(user verbatim 趣旨)。作り方は user が考え中。
- 統合先の表示面: 登録 channel + yt-graph の探索 recommendation を
  出す。加えて TVer (tvtokyo 等) のコンテンツも時間制限付きで視る
  構想。
- よって yt-graph 側では**この web アプリを mockup として作り続けて
  よい** (user 2026-09-30) — 実機が ul-browser 側に移っても、機能・
  UX の検証器としての役割は残る。separable component 方針は変わらず。

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

- [done] component skeleton / app scaffold: separable playback/bootstrap/app (own pnpm + Vite + React + TS entry、yt-graph core への依存は interface seam のみ) ^t-01M3SGQWVC
- [done] curated channel feed: yt-graph 採用 channel set を読む (export seam t-01M3RZVVED を consume — 未着の間は fixture で fail-soft) ^t-01M3SGR0AW
- [done] playback surface: ul-browser 優先の動画再生面 (fallback は ContentHub webview / yt-client embed、adapter seam) ^t-01M3SGR2FY
- [done] viewing limits + parental lock: 視聴 limit の設定・強制と親ロック (親 unlock 無しに limit 変更不可) ^t-01M3SGR5HF
- [done] learning-points gate seam: 学習 point で視聴可能な長さ/量を gate (dokoitsu pipe、未接続時 fail-soft の既定 policy) ^t-01M3SGR7S0
- [done] viewing rhythm enforcement: 30 分視聴ごとに 10 分休憩を強制 (休憩中は再生 block) ^t-01M3SGRBKR

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

# playback usable pass: 実 feed / 実再生面 / points pipe 配線 (kk build)
> [!meta]- w-01M4D5NST7
^w-01M4D5NST7

## ユーザーの要求 (verbatim-intent)

- 2026-10-08 user direction (c-side yt-graph_pm 経由 relay):
  playback client がまだ使える形になっていなければ kk 側で作る。
  mockup (bootstrap iteration, w-01M3SGPYH2 の 6 tasks) は完了済み —
  この wish は「使える client」化の第二ラウンド。
- 残り legs (direction 列挙): 実 adopted-channel feed (export seam
  t-01M3RZVVED の実経路)、embed floor を超えた再生面
  (ul-browser / ContentHub webview)、dokoitsu points pipe 配線。
- 同日の refined rulings (user verbatim —
  `.agent-state/decision-2026-10-08-dokoitsu-viewing-limits.md`
  addendum 参照):
  - 視聴 app は **yt-client** (dedicated YouTube client over
    yt-graph-adopted channels)。dokoitsu は app を作らない —
    points/limits contract provider のみ (contract-level coordination
    のみ、app 側の連絡は持たない)。
    - yt-client repo は両 host に未存在 (検証済み); この repo の
      playback/bootstrap mockup が起点であり、ここから続ける
      (separable 設計、将来の repo split は planner+user 判断)。
  - 製品形態: tinder 的 swipe/route UX は一部品 — client 本体は
    curated channel set 上の **探索/発見 feature** (search-linked
    preview、keyword stock)。

## scope (usable pass)

- 実 feed 経路: ContentHub session source または seed 投入で store を
  実データ化 → 人の accept route → `export-adopted` で feed 生成 →
  playback app が fixture ではなく export を読む (URL 配線込み)。
- video 解決: export は channel 粒度で videoId を持たない — 再生する
  video の決め方をこのラウンドで fix する (export への
  latest-upload 拡張 / channel-page-first UX / per-channel pin の
  いずれか。open question 参照)。
- 再生面: `UlBrowserSurface` / `ContentHubWebviewSurface` stub の実装
  (availability probe + open)。embed floor には YouTube IFrame API の
  制御 channel を足し、limit / rhythm が再生中に pause/block できる
  ようにする (mockup は open gate のみ)。
- points pipe: contract 確定済み
  (decision-2026-10-08-dokoitsu-viewing-limits.md; 127.0.0.1
  `GET /parental/allowance` + `POST /parental/spend`) に沿う
  `HttpPointsGate` adapter。dokoitsu 側 t-01M4D2KWBD が user readiness
  待ちの間は shadow ledger が実効 cap — 配線 task は dependent 扱い。
- kk acceptance: standalone smoke — app 起動、実 feed が採用 channel のみ
  列挙、best surface で再生 open、limit/lock/points/rhythm が enforcement
  する。
- 探索/発見 UX (yt-client 本体定義): curated channel set 上の探索面 —
  search-linked preview (keyword で candidate channel/video を preview
  し route へ繋ぐ)、keyword stock (観たい語の保存・再利用)、swipe
  accept/reject route はその中の一部品として実装。

## 明示的に scope 外

- dokoitsu 側実装 (points authority / ledger / 設定 UI) — partner scope。
- ContentHub / ul-browser 本体の改修 — adapter 側の利用だけ。
- yt-graph core の curation 判定ロジック変更 (accept/reject route は
  人の操作、変えない)。

## task 分解 (usable pass)

(tasks minted via document.create_task — see nodes below)

- [ ] store populate + export 実走: anime starter list seed 投入 → 人の accept route → adopted export 生成 (populate 経路 = seed, user ruling 2026-10-08) ^t-01M4D5Q6VX
- [ ] 実 feed 配線: playback app を export 出力に接続 (VITE_PLAYBACK_EXPORT_URL / public drop) し adopted-only render を検証 ^t-01M4D5QFDN
- [ ] channel-level surface 実装: 再生対象は channel 粒度 (video-level 探索は求めない — user ruling 2026-10-08)。OpenRequest を channel 化し、embed floor は uploads playlist (UU*) embed で channel 丸ごと再生可能にする ^t-01M4D5QFYG
- [ ] 再生面 real host: ContentHubWebviewSurface の availability probe + open 実装 (ul-browser は user ruling 2026-10-08 で今ラウンド対象外 — fallback 順序は維持) ^t-01M4D5QGFE
- [ ] embed floor 制御 channel: YouTube IFrame API で limit/rhythm の pause/block を実装 ^t-01M4D5QH0M
- [ ] HttpPointsGate adapter: dokoitsu 127.0.0.1 allowance/spend contract 配線 (dependent: t-01M4D2KWBD readiness 後) ^t-01M4D5QHJ6
- [ ] kk acceptance smoke: standalone e2e — 実 feed 列挙 / 再生 open / limit+lock+points+rhythm enforcement ^t-01M4D5QJ46
- [ ] 探索/発見 UX: curated channel set 上の search-linked preview + keyword stock + swipe route 部品 (yt-client 本体定義) ^t-01M4D609MF

## 受け入れ条件

- `export-adopted` 実走の出力を playback app が読み、採用 channel のみが
  列挙される (fixture fallback は接続断時のみ)。
- video 再生が embed floor 以外の surface でも開くか、ul-browser 不可が
  検証付きで結論づく (fallback 順序は fixed)。
- 30 分 rhythm と limit が再生中の動画を実際に止める (IFrame API 等の
  制御 channel)。
- dokoitsu 未接続で shadow ledger cap が効き、接続時は daemon の
  remainingMinutes が authoritative になる設計が contract と一致。
- kk 上で standalone smoke が通る。

## open questions

- populate 経路: **answered 2026-10-08 (gm relay)** — anime starter
  list (`.agent-state/anime-channels-2026-09-29.md`) seed 投入 + 人の
  accept route。ContentHub discovery run はこのラウンドでは使わない。
- videoId 解決: **answered 2026-10-08 (in-pane)** — channel 粒度まで;
  video-level で面白いものを見つける機能は求めない。再生は
  channel-page-first (embed floor は channel uploads playlist
  `UU<channelId>` embed で対応可 — sampleVideoId 拡張は不要)。
- ul-browser 実検証: **answered 2026-10-08 (gm relay) — no**、今
  ラウンド対象外。real host は ContentHub webview、fallback embed。
- 再生 session の account: **answered 2026-10-08 (in-pane)** — 専用
  account login あり。spec_product の専用 account 方針を再生面にも
  適用する (playback host = ContentHub webview 内の dedicated-account
  session; embed floor もその session 内で動く)。
- points pipe task の扱い: dependent mint (dokoitsu readiness 待ち) で
  進める提案 — user 判断 (未回答、default = dependent parked)。

## cross-wish dependencies

- **blocked by (soft)**: dokoitsu `t-01M4D2KWBD` の user readiness —
  points pipe の server 側のみ。他 leg は非依存。
- internal: export seam `t-01M3RZVVED` (done) の wire 形を consume。
  export の videoId 拡張が必要なら post-PoC wish (w-01M3RZSXN0) 側の
  contract 変更として扱う。
- cross-repo: ContentHub webview surface (ContentHub repo)、ul-browser
  binary (`~/Documents/ul-browser`) の availability。
- related: viewing-limits contract —
  `.agent-state/decision-2026-10-08-dokoitsu-viewing-limits.md`。
