---
name: wish-tidy
description: Produce read-only workflow-v4 wish hygiene reports. Use lineage mode to trace an id or keyword across intake, decisions, routed returns, Core lookup evidence, and git history; never use it to edit, merge, move, mint, or complete workflow records.
---

# Wish tidy (v4)

Run the deterministic report adapter from a provisioned workflow-v4 repo:

```sh
.agents/skills/wish-tidy/scripts/wish_tidy.ts lineage --id '<w-... or t-...>'
.agents/skills/wish-tidy/scripts/wish_tidy.ts lineage --keyword '<literal text>'
.agents/skills/wish-tidy/scripts/wish_tidy.ts check2
.agents/skills/wish-tidy/scripts/wish_tidy.ts check3-light
.agents/skills/wish-tidy/scripts/wish_tidy.ts check4
```

`lineage` writes one dated report file per query. The sweep modes —
`check2` (duplicate-request detection), `check3-light` (all-terminal
open-wish sweep), `check4` (Bloat-sentinel pollution consumption) — each
write or replace their own `## check <n>` section inside the shared dated
report `.agent-state/tidy/<YYYYMMDD>-wish-tidy.md`, so re-running a check
the same day updates its section in place. Every mode prints a bounded
JSON summary. Lineage evidence is ordered by source time and names the
evidence path or commit. Treat the reports as discovery evidence, not
authority to change ownership or lifecycle state.

## Sweep methods

- `check2` scans `- [<marker>] <title> ^t-<id>` nodes across
  `docs/wish_*.md` and reports candidate pairs (never merges): exact
  normalized-title duplicates; intra-doc near-duplicates at token
  Jaccard >= 0.60 or difflib ratio >= 0.75; cross-doc pairs at
  Jaccard >= 0.55; plus intake-vs-task overlap (Jaccard >= 0.30 and
  `t-…` anchor citations).
- `check3-light` collects member task markers per `^w-` wish block and
  lists open wishes whose anchored tasks are all terminal
  (`[done]`/`[x]`/`[checked]`/`[dropped]`) as `wish.complete` review
  candidates — a list, never an action. `component.list` over
  `.agents/workflow-v4/wf4.sh cli` supplies DB status evidence; when the
  Core is unreachable or truncated the sweep still runs doc-only and
  exits 3. `cutover.bind_preview` remains the authoritative
  checkbox<->DB divergence op (check 3 full).
- `check4` reads Bloat-sentinel `bloat_*` / `conform_*` conditions and
  `wave:*` aggregates from the monitor `state.sqlite` via
  `sqlite3 -readonly` (override with `WISH_TIDY_MONITOR_DB`), then joins
  flagged doc paths against the all-terminal sweep. It creates no metric
  of its own.

## Lineage sources

- `.agent-state/intake/**/*.md`, including claimed history
- `.agent-state/user-decisions.md`
- `~/.local/state/ai-agents/returns/index.jsonl`, read-only
- `git log --all`
- the installed `wish-query` adapter when available; an incomplete or
  truncated Core result stays visibly incomplete

## Boundaries

- Literal id / keyword matching only. Do not infer relations from proximity.
- Write nothing outside `.agent-state/tidy/`.
- Never edit wish documents, intake, decisions, return-router / monitor state,
  the workflow DB, or git history.
- Never merge, move, link, mint, rank, transition, complete, or apply a
  proposed fix. Route any follow-up through planner / doit / done and the
  owning PM or user decision. `wish.complete` runs only on an explicit
  user instruction — the check3-light candidate list is never an action
  queue.
