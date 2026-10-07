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

## Interpreting evidence

- A preflight result is evidence for agent or user judgment, never authority
  to merge, link, move, or mint work.
- Continue only when the Core reports `complete: true`. Treat
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
