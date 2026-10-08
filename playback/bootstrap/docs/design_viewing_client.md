# Viewing client design proposal — playback Phase A

Proposal for the 検証 UI → 視聴 client pass (wish `w-01M4D5NST7` task
`t-01M4D609MF`, phase A). No implementation yet — user picks a direction,
then Phase B implements. Design input: chappy consult note
`~/.local/share/chappy/consult-ytclient-design.md` (2 screens + 2 drawers +
1 overlay system) — adopted as the base shape, grounded here against the
landed seams.

## What exists (seams — stable, shell untouched)

- `feed.listChannels()` — export drop, channel-grain `{id,title,handle,
  description}` (no thumbnail field in the contract)
- `surface` — `selectSurface` (ul → contenthub → embed); embed gives
  `embedUrl` (`videoseries?list=UU…&enablejsapi=1`)
- `EmbedControl` — pause / resume / block / unblock on the live embed
- `pointsGate` — `HttpPointsGate` hybrid: live `/parental` (policy `v1`,
  `remainingMinutes`, break notes) else shadow ledger
- `ViewingRhythm` + `ParentalLock` — local 30/10 and PIN (mockup grade)

## Screen map — 2 screens, no chrome chrome

```
        ┌────────── Discover ──────────┐         ┌──── Watch ────┐
        │  [search field        ][♥ n] │  like   │  (content 100%)│
        │                          ↑   │ ──────► │  auto-hide     │
        │        card stack            │ tap/Ent │  top+bottom    │
        │     (liked → drawer)         │         │  chrome        │
        │  [budget badge, corner]      │ ◄────── │  [badge corner]│
        └──────────────────────────────┘   Esc   └────────────────┘
```

- **Discover** — center card stack, one search field on top, a `♥ n` affordance
  on the edge, limits badge in a corner. No sidebar, no tab bar.
- **Watch** — the embed fills the viewport region; top strip (back · channel
  name · fullscreen tier) and bottom strip (pause / stop) appear on pointer
  movement or keypress, auto-hide ~2.5 s. Nothing else renders — no
  related-videos, no comments.
- Transitions: `card → Watch` on tap/↑/Enter; `Watch → Discover` on Esc.
- Drawers (not screens): **search drawer** — focusing the field expands saved
  keywords; picking one filters/refills the stack. **Liked drawer** — `♥ n`
  opens the stocked list (play / remove / reorder only).
- Overlay system (not a screen): the limits overlay — see below.

## Channel card

- Center portrait card, ~70% of the Discover area. Carries: **title,
  @handle, short description** (all in the export contract) + a monogram tile
  (initial on a channel-color hash) as the visual anchor.
- **No per-video thumbnails**: the contract is channel-grain; real channel
  art would need a feed-contract extension (`thumbnailUrl`) — flagged as a
  seam change, not required for Phase B.
- Swipe/drag: right = like → stocked drawer, left = skip → bottom of deck,
  up / Enter / tap = watch now. Mouse gets the same verbs as 3 small buttons
  under the card. A subtle direction tint follows the drag.
- Deck state: exhausted stack shows "all channels reviewed — reset / open
  likes" — with 3 adopted channels today, loop-back keeps the motion honest.

## Watch layout + 2-tier fullscreen

- Base state: embed sized to the free area; chrome invisible.
- **Full-window (tier 1)** — `F`: the player grows to fill the app window,
  all layout chrome removed, still in-page (pure state change — cheap, works
  in any host).
- **True fullscreen (tier 2)** — `Shift+F` (or second `F`): Fullscreen API on
  the player container. Kept as a distinct tier because the eventual
  WKWebView host maps it to native fullscreen — the boundary is an adapter
  seam, not a new surface.
- `Esc` unwinds one tier at a time (fullscreen → full-window → normal →
  Discover). Playback continues across tier changes — same `EmbedControl`.
- Auto-hide: any pointer/key activity shows the two strips; idle hides them.
  During a limit block the strips are replaced by the overlay (below).

## Limits overlay — 3 strengths, renders state only

Dokoitsu (via `pointsGate.allowance`/`remainingMs`) and the local rhythm are
the policy authorities; the UI only draws what they say.

1. **Badge (L0, ambient)** — `⏱ NN min` pill, corner of both screens; tints
   as budget shrinks. `remainingMinutes:null` → `unmetered`.
2. **Break (L1, modal over player)** — enforced break (`remainingMinutes:0`
   + break-until note, or local rhythm trip): `EmbedControl.block()` pauses
   + inerts the embed in place; scrim shows "break — resumes HH:MM"; on lift,
   `unblock()+resume()` continues the same video — already landed behavior.
3. **Lock (L2, full-app scrim)** — parental lock state: entire app is
   covered; only a PIN affordance (local mockup) or "ask a parent" message.
   Applies on both screens; Discover offers no way around it.

## Interaction model

| key / gesture | action |
| --- | --- |
| `←` / drag left | skip card |
| `→` / drag right | like → drawer |
| `↑` / `Enter` / tap card | watch channel |
| `Esc` | Watch → Discover; unwind fullscreen tiers first |
| `Space` | pause / resume (through `EmbedControl`) |
| `F` | full-window; `Shift+F` (or `F` again) true fullscreen |
| `/` | focus search field |
| `L` | open liked drawer |

Swipe + keyboard bind to the same action set — one interaction vocabulary.

## Changes vs stays

**Changes (shell only):** `App.tsx` replaced by `Discover`/`Watch` screen
components + overlay system + drawers; the debug header (feed source /
surface / watched counters) folds into the limits badge + a small parent
area; `ParentPanel` becomes a gear-icon drawer instead of an always-on panel.

**Stays (seams untouched):** `channelFeed`, `pointsGate`, `playbackSurface`,
`EmbedControl`, `ParentalLock`, `ViewingRhythm`, feed drop + sync, vite
bridge — all reused as-is.

**Seam-change flags (optional, not required):**
- `thumbnailUrl` in the export contract would enable real channel art —
  needs a core-side export field; optional polish.
- Card search = **filter over the curated set** (title/desc match), not
  YouTube search — the surface stays adopted-only by law; real YouTube
  search would violate the curated-surface contract and is NOT proposed.

## Open choices for the user

1. **Watch surface when ContentHub is live.** `selectSurface` prefers
   `contenthub-webview`, but that surface is an *external* host window — the
   in-app limits overlay / control channel cannot reach it. Recommendation:
   the kid-facing Watch pins the **embed floor** (only surface the limits
   overlay can actually govern); treat ContentHub/ul-browser as a
   parent-side alternate. Needs your call — pick embed-always, or keep the
   preferred-surface order and accept external playback?
2. **Card vs list discovery.** Card stack = the pinned user image (恋活 app
   feel). A compact grid is denser and scales to more channels. Card is
   recommended (matches the ruling); grid is the real alternative if the
   adopted set grows large.
3. **Search semantics.** Keyword filters the curated channel set (title /
   desc match) + stock = saved words. Anything beyond (real YouTube search,
   video-level results) is off-contract — confirm the filter-only reading.
4. **Empty-deck behavior.** With ~3 channels the stack exhausts fast:
   loop-back + "reviewed" stamp, or hard stop with the liked drawer as the
   real feed? Suggest hard stop → the liked drawer becomes the daily feed.
5. **Fullscreen key shape.** `F` cycles normal → full-window → true
   fullscreen → normal, vs two distinct keys. Suggest cycle + `Esc` unwind.

## User direction (2026-10-08, in-pane — all 5 choices resolved)

1. **Watch surface = embed floor.** Kid-facing Watch pins the embed
   floor — the only surface the limits overlay governs.
   ContentHub/ul-browser stay parent-side alternates.
2. **Card stack.** Tinder-like swipe deck (user's original image).
3. **Search = filter-only.** Filters the curated adopted set +
   keyword stock; no real YouTube search (curated-surface contract).
4. **Empty deck = hard stop.** Liked drawer is the way back in /
   daily feed.
5. **Fullscreen: F cycles** normal → full-window → true fullscreen →
   normal, Esc unwinds. PLUS mouse action: ダブルクリック等を fullscreen
   tier に割り当てる。オーバーレイ切り替えボタンは当初案だったが、
   double-click があれば不要かも (user refinement 2026-10-08) —
   ボタンは実装してみて冗長なら落とす (mouse-first で十分なら省く)。
   さらに遷移モデル (user refinement 2026-10-08): カード click で
   そのまま全画面再生 (Watch へ fullscreen 遷移)、戻る時は
   ダブルクリック — Enter/再生 verb と同じ入口で fullscreen
   行き、double-click が back/tier 解除を兼ねる形に合わせる。
   カード役割 (user refinement 2026-10-08): カードは swipe で流す
   (like/skip の deck 操作)、click/tap は再生 entry。

## 追加 refinement — card flow model (user direction 2026-10-08)

初回実装の Tinder deck (上のカードを捲る) はイメージと違う。
user の本来のイメージ: **Cover Flow (昔の iTunes の曲選択)** —
カードが横方向 (左→右) に流れるストリームで、中央の 1 枚に
フォーカスが当たる。
判定モデル (user direction 2026-10-08, verbatim): 「真ん中に来た
やつをしばらく見て like押すみたいな感じ　基本左から右へ流す」—
flow は基本 左→右 の閲覧 conveyer。中央フォーカスのカードを見て
like を明示操作 (button/key) で押す。明示的な skip verb は持たず、
そのまま流し去るのが skip 相当 (liked だけが残り、skip された
ものは後ろに残る / deck 消化の定義は実装側が最小で整える)。
- 方向 (user direction 2026-10-08): 概要 OK だが現状は右→左に
  流れているので **逆** — 未消化カードは左に待機し、中央を通って
  右へ抜ける、左→右の流れにする。
- 本番 gesture 要件 (user direction 2026-10-08): swipe/drag は
  本番環境 (ContentHub webview / WKWebView 実 host、touch pointer
  含む) で効くこと — dev の mouse drag で済ませない。pointer
  events は mouse+touch を理論上カバーするが、実 host での動作は
  acceptance 時に検証する (webview で pointer event が届かない
  場合の fallback = ボタン/キー操作は既存のまま残す)。
