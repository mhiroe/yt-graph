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

- Seed-based channel discovery for your own YouTube account: OAuth sign-in,
  subscriptions / recommendations as the signal source.
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

- FIXME(project): write a representative run example here — not yet implemented.

## script / app usage

- FIXME(project): list the public commands or scripts here — not yet implemented.

## Verification

- まずは `pnpm exec node path/to/script.js --help` のような smoke 確認を最小検証とします。

## Environment

- Primary language: `TypeScript`
- framework / app shape: `React + Three.js (3D graph) + Vite` web UI over a
  local API (SQLite)
- runtime / package manager: `pnpm`
- external: YouTube Data API v3 + OAuth 2.0, chappy-cli, jev, yt-client /
  ContentHub, AdGuard
- the canonical workflow detail lives in `AGENTS.md`, `docs/spec_repo_workflow.md`, and `docs/spec_product.md`

## Setup

1. FIXME(project): list the required tools (pnpm, YouTube API credentials / OAuth client, chappy-cli, jev)
2. FIXME(project): write the dependency install command
3. FIXME(project): write the shortest path to first run
