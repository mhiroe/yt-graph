---
name: retro
description: Collect and analyze workflow v4 per-task retrospectives across repos — journal signals, wf4 defects, token waste, process friction. Use for periodic retro review, or in debug mode when a watch prompt reports a new journal.
---

# Retro (v4)

Read what the retrospective pipeline produced and turn it into findings:
what broke, what wasted tokens, what to change. This skill analyzes; it does
not fix — fixes go through the normal planner / doit flow as new work.

## Pipeline

- `done` runs `.agents/workflow-v4/wf4-retro.sh <task_id> --write` on every
  completed task — emission is unconditional, no flag or env switch
  (gm.md:1142). One journal lands
  per completed task under `.workflow.nosync/retro/journal/<date>/`.
- `wf4-retro.sh --aggregate` folds journals since `.journal-cursor` into
  `retro/ledger.md` — run it per repo for the periodic pass.
- `.agents/workflow-v4/wf4-retro-scan.sh` is the cross-repo collector used
  here. It discovers every repo under `$WF4_RETRO_SCAN_ROOT` (default
  `~/Documents`) whose `.agents/workflow.toml` declares `version = 4`.

## Collect

```sh
# one compact line per journal + per-repo signal counts
wf4-retro-scan.sh scan [--limit N|--all] [extra_repo_root ...]

# journals that appeared since last poll (state: .scan-seen)
wf4-retro-scan.sh poll

# real-time: push each new journal to a monitoring PM pane (debug mode)
wf4-retro-scan.sh watch <pm_pane_id> [interval_sec]
```

Flag glossary (the second column of scan output):

| flag | meaning |
| --- | --- |
| `OPEN` | task not `done` in the DB when the journal was written |
| `PARITY` | doc marker disagrees with DB status (or marker missing) |
| `NO-MARKER` | marker lookup found nothing |
| `CHAIN` | op chain anomaly: non-applied op or incomplete chain |
| `NO-VERIFY` | no verification recorded at `task.complete` |
| `RESIDUE` | uncommitted paths at report time (upper bound, not attribution) |
| `NO-SESS` | no `session.attach` — executor session unknown |
| `NO-TRANS` | session recorded but transcript unresolved |
| `BIG-TRANS` | transcript >= 2048 KB or any message/tool output >64 KB |
| `OLD-FMT` | journal predates the full-report format — missing fields are format, not defects |
| `FRICTION` | a friction line no other flag claimed |

## Analyze

1. Run `scan`. Journals flagged `OLD-FMT` only need a glance — their missing
   fields are format age, not breakage.
2. Read flagged journals in full only where the flag needs evidence
   (`PARITY`, `CHAIN`, `BIG-TRANS`, `FRICTION`). `RESIDUE` is an upper-bound
   flag — only escalate when it repeats or blocks commit attribution.
3. Classify each finding:
   - **wf4 defect** — the tooling itself failed: marker lookup missed an
     existing node, transcript resolution dead where a transcript exists,
     `session.attach` never emitted, non-applied ops, journal fields missing
     from a new-format file.
   - **token waste** — `BIG-TRANS` transcripts, >64 KB tool outputs, sessions
     carrying finished work into the next task (the known bloat pattern).
   - **process friction** — repeated residue, missing verification, stale
     markers the worker never flipped.
4. Record durable findings in the monitoring repo's
   `.workflow.nosync/retro/findings.md` — one line each: date, repo, task id,
   class, evidence pointer. Keep the file append-only; it feeds the periodic
   review.
5. Report bounded: findings grouped by class with repo + journal path as
   evidence. A recurring defect is a wish/task candidate — propose it, never
   open it yourself.

## Boundaries

- Never hand-edit `.workflow.nosync/workflow.sqlite` or
  `.workflow/repository.json`. All Core access goes through `wf4.sh`.
- Read-only on other repos. Flag flips and redeploys need the user's go.
- Watch prompts are notifications, not task delegations — analyze, report,
  and wait. Do not treat one journal as a mandate to fix.
