---
name: wish-query
description: Query workflow v4 wishes and tasks through the vendored Core before proposing new work or judging ownership. Read-only and bounded; use it for exact lookup and related-work preflight, never to mint, link, merge, rank independently, or change planner/doit/done state.
---

# Wish query (v4)

Use this skill before proposing a new wish or task when an existing Epic
(wish file) or Story (anchored node inside it) may already own the outcome.
It is a read-only discovery adapter, not a lifecycle phase.

## Entry point

Run the deterministic adapter from the current workflow-v4 repository:

```sh
.agents/skills/wish-query/scripts/wish_query.ts preflight --title '<proposed outcome>'
.agents/skills/wish-query/scripts/wish_query.ts list --id '<w-... or t-...>'
.agents/skills/wish-query/scripts/wish_query.ts body-scan --term '<term>' [--term ...]
```

The adapter locates the repository root, delegates to
`.agents/workflow-v4/wf4.sh cli`, and returns the Core JSON unchanged. It does
not read SQLite directly and does not write a cache, document, relation, or
workflow state.

`preflight` accepts:

- required `--title`
- optional `--subject <component-id>` with `--expected-revision <revision>`
- optional `--iteration`, `--state-changed-since`, `--scan-limit`, and
  `--candidate-limit`

`list` accepts optional `--id`, `--kind`, `--status`, `--iteration`,
`--state-changed-since`, and `--limit` filters. Use `list --id` for an exact
lookup. The Core owns bounds and validation; the adapter only parses a narrow
command surface and enforces a hard response-size ceiling.

Both `preflight` candidates and `list` rows may carry an optional `sprint`
field: the `sprint_id` of the latest sprint rostering that component inside
its effective iteration — the same binding rule as the `> sprint:` callout
key written by `sprint.issue`. The field is absent (never `null`) when the
component is not sprint-bound. A bound candidate means an accepted sprint
already claims the work; `sprint.current` / `sprint.members` via
`wf4.sh cli` resolve the sprint's goal and roster.

`body-scan` is the adapter-local body-text leg: a bounded case-insensitive
substring scan over `docs/wish_*.md` for terms title tokens cannot reach
(prose design inside wish bodies). It never touches Core — no DB read, no
Core call — so it also runs where the repo is not yet provisioned.

- at least one `--term` (repeatable; normalized NFKC + lowercase, OR match)
- optional `--dir` (default `docs`), `--glob` (default `wish_*.md`),
  `--max-files` (200), `--max-matches` (40), `--file-bytes` (256 KiB)
- result (`wf4.body-scan.v1`): `scanned_files`, `matched_files` (capped),
  `matched_total`, `matched_digest` (fnv1a8 over the full matched path set —
  the membership fingerprint `planner`/`doit` record and re-check),
  `per_term` counts, `truncated` + `truncation` reasons
  (`dir_missing`, `file_cap`, `file_bytes`, `match_cap`)
- exceeding any cap — or a missing scan dir — sets `truncated:true` /
  `complete:false` and exits 3 — fail closed, never silently partial

## Interpreting evidence

- A preflight or body-scan result is evidence for agent or user judgment,
  never authority to merge, link, move, or mint work.
- Continue only when the result reports `complete: true`. Treat
  `stale_revision`, `incomplete`, or either truncation flag as a stop requiring
  a narrower/fresher read.
- `candidate_found` means inspect the candidate's owning wish file and Story
  node before deciding whether new work is needed.
- `no_match_within_bounds` proves only the declared bounded slice; it is not a
  fleet-wide uniqueness claim.
- Keep personal notes as a fast cache, but verify any durable ownership or
  lifecycle conclusion against this Core read and the canonical wish docs.

## Boundaries

- Never invoke `skill.phase`, `wish.transition`, `wish.complete`, raw
  `workflow.submit`, or document mutation from this skill.
- Never duplicate Core tokenization, scoring, relation evidence, or ordering
  in the adapter.
- Do not change `planner`, `doit`, `done`, monitor, or intake behavior based on
  this skill alone. Those integrations require separate contract decisions.
- Do not persist query results in `.agent-state`; rerun the bounded read when
  freshness matters.
