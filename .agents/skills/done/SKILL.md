---
name: done
description: Complete one workflow v4 task through the vendored Core. Sends a skill.phase done request carrying the task's component_id/state_revision and the verification performed, then promotes durable decisions. done never closes a wish — wish.complete is a separate explicit user instruction only.
---

# Done (v4)

Close exactly one workflow v4 task and record its outcome through the vendored
Core at `.agents/workflow-v4/`.

## Request

```json
{"kind":"skill.phase","phase":"done","task":{"component_id":"t-...","state_revision":0},"verification":"<what was run and observed>","operation_prefix":"fin-"}
```

Resolve `component_id` / `state_revision` from the `doit` handoff or
`.agents/workflow-v4/wf4.sh cli` read ops (`document.list_nodes`,
`mind_wish.list`). Halt on the first non-`applied` disposition.

## Bounded evidence

Verification evidence is bounded at capture, before it enters a turn,
journal, or return (token hygiene `w-01M3N7RSMH`, user GO 2026-09-29):

- Screenshots and other visual captures: downscale at capture (max edge
  1600 px — `sips -Z 1600`, or the capture tool's own scale option) and cap
  the count to what the check shows. A verification record cites at most 3
  captures inline; the rest stay as files referenced by path.
- Evidence that does not fit inline goes to a file (`.agent-state/` or the
  repo's docs home) and the record carries the path — never the payload.
- The `verification` field holds what was run and observed — commands,
  outcomes, paths — not copied payloads.

## Output spill

Any single output over 64 KB lands in a file; only the file path appears
in the turn or journal surface (token hygiene `w-01M3N7RSMH`). This covers
tool results, captured evidence beyond the capture bound, rendered
reports, and returned payloads alike — the payload goes to a file, the
record carries the path.

## Task-boundary artifact cleanup

Large artifacts are cleared when the task reaches done or dropped (token
hygiene `w-01M3N7RSMH`): spilled outputs and captures beyond the inline
bound are transient — delete them at the boundary unless a committed
document or record references the path. What a record still names stays;
everything else is removed as part of this bookkeeping, so transient bulk
never outlives the task.

Artifacts over 10 MB are the one exception: they are not deleted here.
The workflow side emits a retention hand-off for the ops-suite retention
stage (ONE retention owner) — one record per artifact at
`.agent-state/retention-queue/<UTCts>-<task_id>.md` carrying
`artifact:` path, `size_bytes:`, `task:` id, `produced_by:` agent, and
`referenced_by:` — the doc/record paths that still name it. The suite
owns the split + prune pass; the workflow side never splits or prunes
itself.

## Document marker

The checkbox on the task's Markdown node is the document-side source of truth
for task status; the Core does not write it back. After `task.complete`
returns `applied`:

1. Flip the node's marker `[doing]` -> `[done]` in the owning file. Marker
   only — keep the `^t-...` anchor and every other byte of the node. This
   edit is inside the `docs_only` scope.
2. Verify with a read before finishing: `document.read_task` shows `[done]`,
   or `cutover.audit` reports no `status_ahead` for the id. A stale `[doing]`
   marker makes the next `cutover.bind` / `cutover.audit` flag the node
   `status_ahead` against the DB.

## Findings promotion

Technical findings, root causes, and gotchas from the task are written into the
owning spec or rule at done/retro (or at discovery) — never kept only in a PM
file, handoff note, or the bounded return (user ruling 2026-09-29). Check
"findings promoted to spec/rule?" before finishing; a finding with no owning
spec opens a draft wish.

## Retrospective (opt-in)

After the marker is verified, run the per-task retrospective only when it is
enabled: `.agents/workflow-v4/wf4-retro.sh --enabled` exits 0 when
`WF4_RETRO=1` or `.workflow/repository.json` sets `"retrospective": true`.
When enabled, run `wf4-retro.sh <task_id> --write` — `--write` is the default
invocation so the report lands in the journal under `.workflow.nosync/retro/`;
drop it only for a dry look. Relay the short report. When disabled, do
nothing — the check itself must not run.

## Wish closure boundary

**`done` never closes a wish.** Closing a wish is a separate decision the user
makes and instructs explicitly. When — and only when — the user asks to close a
wish, send:

```json
{"kind":"wish.complete","wish":{"component_id":"w-...","state_revision":0},"reason":"<the user's own reason>","operation_prefix":"close-"}
```

The runtime rejects an empty or missing `reason`; carry the user's own words,
not a paraphrase. The actor defaults to `user` — do not set it from the agent.

`wish.complete` accepts only `doing -> done`. A wish still in `plan`, `ready`,
or `pending` moves one transition per `wish.transition` request, each carrying
the user's verbatim `reason`:

```json
{"kind":"wish.transition","wish":{"component_id":"w-...","state_revision":0},"operation":"wish.drop","reason":"<the user's own reason>","operation_prefix":"close-"}
```

Allowed `operation` values: `wish.request_ready`, `wish.set_pending`,
`wish.start_doing`, `wish.drop`. So `plan -> done` is `request_ready` ->
`start_doing` -> `wish.complete` (three requests, taking the new
`state_revision` from each applied response); `plan -> dropped` is a single
`wish.drop`.

## Session release

When the task ran on a Worker pane, this declaration is also what releases
that session — the Worker clears on the PM's done, never on its own judgement,
and a finished session takes no next task. The canonical session-lifecycle
rule is the shared `herdr.md` instructions; this skill only points at it.
