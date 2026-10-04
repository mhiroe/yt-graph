---
title: yt-graph README
kind: wish
weight: 0
visible: true
children:
  - "docs/spec_*.md"
tags:
  - project
---

# yt-graph

YouTube channel discovery explorer — pick one favorite channel as a seed, then
grow a navigable graph of similar / interesting channels.

## Project overview

- Seed-based channel discovery for your own YouTube account: reads happen
  through a dedicated-account logged-in session inside a ContentHub instance
  (`YTG_SOURCE=contenthub`); the fixture adapter (`YTG_SOURCE=fixture`,
  default) needs no credentials.
- Candidates come from two sources: subscription-graph recommendation and a
  ChatGPT wall-bounce consult via `chappy-cli`.
- `jev` (local judgment tool) scores and filters out uninteresting candidates;
  the human previews candidates and routes them (preview-and-route UX) — AI
  never makes the final call.
- Playback viewer is `yt-client` (needs ContentHub webview host support);
  ad blocking via AdGuard.
- Specs live in `docs/` (`spec_product.md`, `spec_repo_workflow.md`,
  `spec_provision.md`); workflow v4 (`planner` / `doit` / `done`).

## Usage

- App code lives in the bootstrap iteration: `docs/iterations/bootstrap/app/`.
- `cd docs/iterations/bootstrap/app && pnpm install && pnpm dev` starts the
  local API (`:8787`, SQLite at `app/data/yt-graph.sqlite`) and the Vite web UI
  (`:5173`, `/api` proxied to the API).
- Adhoc actions (human-initiated one-shots, separate from batch runs): the
  inspection drawer offers `evaluate now` / `re-evaluate` on candidate/later
  channels (`POST /api/judge {channel_id, force}`) and `expand` on
  accepted/seed channels (`POST /api/expand {channel_id}`). Batch `judge`
  (no body) still sweeps every unjudged candidate.
- Relation-edge walk (`POST /api/walk {channel_id}`, accepted/seed only):
  traverses the stored edges around a channel and extends one hop through
  each neighbor's relation surfaces, writing typed edges — subscriptions
  `influence`, playlist curation `reference`, playlist co-billing `collab`,
  playlist co-membership `community`, fingerprint overlap `behavioral` —
  and surfacing their endpoints as candidates with `edge_walk` evidence.
  No search/consult calls; `event` edges have no adapter surface yet.
- Subscription-gap CF (candidate source inside `discover`, fail-soft):
  viewers whose public subscriptions partially overlap the account's own
  contribute their non-overlapping subs as missing-edge candidates
  (`subscription_gap` evidence, one row per contributing viewer). Needs the
  adapter's `mySubscriptions` + `commentAuthorChannels` surfaces — absent
  surfaces make the pass contribute nothing and report the gap.
- UI loop: enter a seed → `discover` → `judge` → click a node/row to open the
  inspection drawer (channel detail, discovery evidence, AI evaluations,
  related edges, routing history — `GET /api/inspect?channel_id=`) →
  `accept` / `later` / `reject` (persisted to `human_decision`) → `expand` on
  an accepted node re-runs discovery from it.
- Playback component (separable, extraction-ready) lives at
  `playback/bootstrap/app/` — its own pnpm package with no imports into the
  core app; external integrations go through fail-soft adapter seams
  (`src/seams/`). `cd playback/bootstrap/app && pnpm install && pnpm dev`
  serves its web UI on `:5174`; `pnpm smoke` exercises the seams.
  It is a mockup of the kid-facing viewer: curated channel feed,
  PIN-locked viewing limits, points-gate budget (unconnected → local
  default), 30/10 viewing rhythm, and an iframe embed as the playback
  surface floor. Env: `VITE_PLAYBACK_FEED` (`auto`|`export`|`fixture`),
  `VITE_PLAYBACK_EXPORT_URL` (default `/feed-export.json`).

## script / app usage

- `pnpm dev` — run API + web UI together (`scripts/dev.mjs`)
- `pnpm dev:api` / `pnpm dev:web` — run either side alone
- `pnpm smoke` — self-contained API boot check (scratch port, in-memory DB)
- `pnpm accept` — full-loop acceptance (fixture source + heuristic judge +
  stub consult): discover → judge → preview fields → route → expand
- `pnpm check:edgewalk` — fixture edge-walk check (in-memory DB): typed
  relation edges, hop-2 surfacing, reject/idempotency guards
- `pnpm check:gapcf` — fixture subscription-gap CF check: similar-viewer
  overlap → missing-edge candidates, fail-soft when adapter surfaces absent
- `pnpm probe:source` — connectivity smoke against the configured source
  adapter (`YTG_SOURCE=fixture|contenthub`, fixture is the default)
- `pnpm probe:contenthub` — bounded read-only check against the live
  ContentHub yt session: `yt.session.check` / `yt.auth.inspect` /
  `yt.subscriptions.mine`. Fails closed (skips) when the dedicated yt
  instance is not running or not authenticated. Env: `YTG_CONTENTHUB_ROOT`
  (transport root override), `YTG_CONTENTHUB_TIMEOUT_MS` (response wait,
  default 120s)
- `pnpm judge` — discovery → judgment one-pass on a scratch DB
  (`YTG_JUDGE=auto|jev|heuristic|staged`; `staged` runs the Tier0-3 funnel,
  upper tiers escalate only while inconclusive and are port-wired only)
- curiosity profile seam: `YTG_PROFILE=auto|fixture|off` (auto = fail-soft
  absent profile until a real dokoitsu source lands; fixture = canned
  profile for dev/checks)
- `pnpm export:adopted [outPath]` — dump the adopted-channel export contract
  (`{generated_at, channels:[…]}` of `accepted` channels only) to a JSON file
  (default `data/export/adopted-channels.json`); the same document is served
  live at `GET /api/export/adopted` for the playback client's channel feed seam
- discovery consult wall-bounce: `YTG_CONSULT=auto|chappy|stub|off`
  (auto = chappy when `chappy status` shows a signed-in account)
- `pnpm lint` — `tsc --noEmit` typecheck (thin lint until a real linter lands)
- `pnpm build` — typecheck + `vite build`

## Verification

- Minimum check is a smoke run: `cd docs/iterations/bootstrap/app && pnpm smoke`
  boots the API and verifies `/api/health` + `/api/graph`.

## Environment

- Primary language: `TypeScript`
- framework / app shape: `React + Three.js (3D graph) + Vite` web UI over a
  local API (SQLite)
- runtime / package manager: `pnpm`
- external: YouTube Data API v3 + OAuth 2.0, chappy-cli, jev, yt-client /
  ContentHub, AdGuard
- the canonical workflow detail lives in `AGENTS.md`, `docs/spec_repo_workflow.md`, and `docs/spec_product.md`

## Setup

1. Required tools: Node.js 22.x (`node:sqlite` via `--experimental-sqlite`)
   and `pnpm`. YouTube credentials / chappy-cli / jev are only needed for the
   live adapters; the fixture adapter path needs no credentials.
2. `cd docs/iterations/bootstrap/app && pnpm install`
3. `pnpm dev` → open http://localhost:5173
4. playback app (optional): `cd playback/bootstrap/app && pnpm install`,
   `pnpm dev` → open http://localhost:5174
