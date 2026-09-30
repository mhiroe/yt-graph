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
- UI loop: enter a seed → `discover` → `judge` → click a node/row to preview →
  `accept` / `later` / `reject` (persisted to `human_decision`) → `expand` on
  an accepted node re-runs discovery from it.

## script / app usage

- `pnpm dev` — run API + web UI together (`scripts/dev.mjs`)
- `pnpm dev:api` / `pnpm dev:web` — run either side alone
- `pnpm smoke` — self-contained API boot check (scratch port, in-memory DB)
- `pnpm accept` — full-loop acceptance (fixture source + heuristic judge +
  stub consult): discover → judge → preview fields → route → expand
- `pnpm probe:source` — connectivity smoke against the configured source
  adapter (`YTG_SOURCE=fixture|contenthub`, fixture is the default)
- `pnpm probe:contenthub` — bounded read-only check against the live
  ContentHub yt session: `yt.session.check` / `yt.auth.inspect` /
  `yt.subscriptions.mine`. Fails closed (skips) when the dedicated yt
  instance is not running or not authenticated. Env: `YTG_CONTENTHUB_ROOT`
  (transport root override), `YTG_CONTENTHUB_TIMEOUT_MS` (response wait,
  default 120s)
- `pnpm judge` — discovery → judgment one-pass on a scratch DB
  (`YTG_JUDGE=auto|jev|heuristic`)
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
