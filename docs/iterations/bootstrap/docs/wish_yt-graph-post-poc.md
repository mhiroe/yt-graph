---
title: yt-graph post-PoC — inspection UI / adhoc mode / discovery expansion
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

# yt-graph post-PoC: inspection UI / adhoc mode / discovery 拡張
> [!meta]- w-01M3RZSXN0
^w-01M3RZSXN0

## 背景

9-task PoC (w-01M3HEP6BP) の scope guard で除外された項目の planner
sweep (2026-09-30、gm_secretary directive)。来源は spec_product.md
scope / discovery strategy と asakai 2026-09-28/29、user rulings
2026-09-29。gm 境界確認 (9/29): 「調査画面 / adhoc mode は 9-task
readiness 対象外 → planner で新 task 化 + readiness QUESTION を gm へ
送ってから doit」に基づく。

## scope (user-ratified 2026-09-29、planner 未採番)

- 調査画面 (inspection UI): 収集済み channel / candidate を人が掘る
  画面 — 詳細 / evidence / AI 評価 / 関連 edge の一覧。x-graph の
  review surface と同発想 (user 2026-09-29)。
- adhoc mode: pipeline / 定期 run とは別の、人間起点 one-shot 探索・
  評価アクション (この channel を今すぐ展開、この候補を今評価)
  (user 2026-09-29)。
- discovery expansion (spec_product.md "discovery strategy" が正本):
  - relation-edge walk: seed 周辺を collab / event・community /
    reference / influence / behavioral-similarity edge で辿る
  - subscription-gap collaborative filtering: 登録重複 viewer の
    missing edge を候補化 (実現性未検証; comment-author channel
    surface は contenthub_pm へ addendum 依頼済み)
  - staged evaluation + Channel Activity DNA: Tier 0 metadata →
    Tier 1 transcript → Tier 2 sampled frames / VLM → Tier 3 強い
    LLM/VLM; DNA と Curiosity Profile の適合を安価層で大量判定
  - Curiosity Profile adapter seam: profile source の差し替え可能な
    seam (供給元は dokoitsu 想定、dokoitsu 側未実装 → fail-soft seam
    のみ用意)
  - distance knob: Interest × Novelty × Distance × Surprise 軸で
    profile からの距離を調整

## 明示的に scope 外

- 専用 YouTube 再生 client 本体 — 別 repo で製作する方針 (user
  2026-09-29)。yt-graph 側の接点は採用 channel の curated surface
  export と ContentHub webview host との API 契約だけ。
- w-01M3HEP6BP の残 task t-01M3NXGS3D — PoC wish 側で継続
  (ContentHub yt adapter は kk で live 確認済み 2026-09-30)。

## task 分解 (planner sweep 2026-09-30)

- [ ] inspection UI: 収集済み channel/candidate の調査画面 (詳細 / evidence / AI 評価 / 関連 edge) ^t-01M3RZVSCZ
- [ ] adhoc mode: 人間起点の one-shot 探索・評価アクション (即時 expand / evaluate) ^t-01M3RZVSR9
- [ ] relation-edge walk: collab/community/reference/influence/behavioral edge で seed 周辺を辿る ^t-01M3RZVT32
- [ ] subscription-gap collaborative filtering: viewer overlap の missing edge 候補 (feasibility spike; comment-author surface は ContentHub 依存) ^t-01M3RZVTDP
- [ ] staged evaluation + Channel Activity DNA: Tier0-3 funnel と安価層での大量判定 ^t-01M3RZVTRM
- [ ] Curiosity Profile adapter seam: dokoitsu 供給想定の fail-soft seam ^t-01M3RZVV3E
- [ ] adopted-channel export seam: 別 repo 再生 client への curated surface 契約 ^t-01M3RZVVED

## user direction 2026-09-30 — discovery UX の可能性

- yt-graph の web アプリは **mockup として作り続けてよい** (user
  2026-09-30) — 実 playback client が ul-browser 側に統合される可能性
  があっても、探索 UX の検証器として継続。
- swipe / route UX: Tinder のように候補をスライドして
  好き / 嫌い を振り分ける形がよい (preview-and-route の進化形)。
- YouTube search との連動、候補の preview、keyword 入力 +
  keyword ストック — yt-graph の探索と組み合わせて次の興味を
  見つける形。
- 探索で育った graph 自体が見えると面白い (探索 graph の可視化を
  inspection 面として)。

## open questions

- 新 scope (inspection UI / adhoc mode / discovery expansion 各 task)
  の readiness — 着手可否と優先順位は user が判断する。
- 専用 playback client の起票先 — 別 repo の新規 wish か。yt-graph 側
  は export seam task のみ。
- subscription-gap CF の実現性 — ContentHub adapter の comment-author
  / subscription surface で取れるか未検証 (feasibility spike 内で確認)。

## cross-wish dependencies

- blocks: なし。w-01M3HEP6BP (PoC) の後続 scope。
- blocked by: ContentHub adapter の read-kinds (comment-author /
  subscription surface) — contenthub_pm 側 deliverable。Curiosity
  Profile の実データは dokoitsu 実装待ち — adapter seam で fail-soft。
- trigger: PoC wish の残 task 完了を待たずに着手可能 (PoC との依存は
  seam 経由のみ)。
