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

## Session release

When the task ran on a Worker pane, this declaration is also what releases
that session — the Worker clears on the PM's done, never on its own judgement,
and a finished session takes no next task. The canonical session-lifecycle
rule is the shared `herdr.md` instructions; this skill only points at it.
