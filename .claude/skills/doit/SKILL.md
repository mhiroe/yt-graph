---
name: doit
description: Execute one workflow v4 task through the vendored Core. Requires the user's explicit readiness decision, drives .agents/workflow-v4/wf4.sh with skill.phase requests, writes implementation code only after task.start_doing applies, halts on the first non-applied disposition, and hands bookkeeping to done.
---

# Do It (v4)

Execute exactly one workflow v4 task against the vendored Core runtime at
`.agents/workflow-v4/`.

## Preconditions

- The wish was planned by `planner` and the **user** gave the readiness
  decision. Do not start `doit` on a wish the planner only proposed.
- The repository is provisioned: `.workflow/repository.json` exists. If it does
  not, run `.agents/workflow-v4/wf4.sh provision <repository-id>` once.

## Related-work evidence — check at start

Before sending the phase request, verify the owning Story (the task's
`^w-` heading) carries the planner's `> related-work evidence:` prelude
line (canonical form in `planner` "Related-work gate"), then confirm the
evidence still covers the corpus. All checks are read-only; on any halt
do not send the phase request — report the finding verbatim to the
dispatcher (remediation is a planner refresh entry, never an executor
waiver).

- **missing** → HALT: the related-work gate never ran for this Story.
- **wrong Story / malformed** → HALT: the line's `story` id differs from
  the wish's component id, its `@<rev>` exceeds the wish's current
  `wf4.sh revision <w-id>` (the recorded rev is the evidence-write basis;
  later transitions legitimately advance it), fields are missing, the
  schema tag is not `v1`, or a `truncated` flag is recorded.
- **related-set line missing / malformed** → HALT: the Story must also
  carry one `> related set: v1` line beside the evidence line (the
  planner's classified related set, t-01M4F8WHHK): all five class keys
  present (`owner`/`sibling`/`duplicate`/`blocks`/`blocked-by`), values
  `none` or comma-separated `w-` ids, schema tag `v1`. Freshness rides
  the evidence line's `at` — both lines are written in the same pass,
  so the set line carries no timestamp of its own.
- **stale** → HALT, judged by two bounded delta re-reads against the
  line's own `at` timestamp:
  1. `wish_query.ts preflight --title '<evidence outcome>' --subject
     <w-id> --state-changed-since <at>` — `complete:false` → halt; any
     candidate other than the recorded `owner` → stale → halt.
  2. `wish_query.ts body-scan --term <each recorded terms value>` —
     `complete:false` → halt; `matched_digest` differs from the recorded
     `set` → stale → halt (the related file set moved).

## Request

Existing planned task:

```json
{"kind":"skill.phase","phase":"doit","wish":{"component_id":"w-...","state_revision":0},"task":{"component_id":"t-...","state_revision":0},"operation_prefix":"impl-"}
```

Or let the runtime create the planned task from the wish:

```json
{"kind":"skill.phase","phase":"doit","wish":{"component_id":"w-...","state_revision":0},"task_title":"...","operation_prefix":"impl-"}
```

With iteration layout, `task_locator` points inside the owning wish's
iteration docs (`<component>/<it>/docs/...` or `docs/iterations/<it>/...`) —
a task inherits its iteration through the wish, so the locator must sit in
the same iteration. `task_iteration_id` is the explicit-membership override:
needed only when the scope has actives but no default (create fails closed)
or the task must join a non-default active iteration. Resolve it via
`iteration.list` — never guess.

```json
{"kind":"skill.phase","phase":"doit","wish":{"component_id":"w-...","state_revision":0},"task_title":"...","task_locator":"<component>/<it>/docs/wish_<component>.md#heading","task_iteration_id":"it-...","operation_prefix":"impl-"}
```

## Session record

`wf4.sh` auto-attaches the calling session to a doit request: when the
request omits `session`, it resolves `herdr pane current` (pane id, agent,
agent session id) and injects it, so the runtime appends a `session.attach`
activity right after `task.start_doing` applies — the retrospective's link
to the transcript. No action needed under herdr.

Outside herdr (or when the auto-attach resolves to the wrong pane — e.g. a
delegated run), pass `session` explicitly and it is used instead:

```json
{"kind":"skill.phase","phase":"doit","wish":{...},"task":{...},"session":{"pane":"w16:p1H","agent":"devin","session_id":"..."},"operation_prefix":"impl-"}
```

All subfields are optional; send what you can resolve.
`herdr agent get <pane>` returns `agent_session.value`. An explicit
`session` is never overridden by the auto-attach; individual missing
subfields are filled in.

## Discipline

- Use only component IDs returned by `applied` responses or the read ops
  (`wf4.sh cli` with `document.inspect_locator` / `document.list_nodes` /
  `mind_wish.list`). Never guess an id.
- Write no implementation code until `task.start_doing` returns `applied`.
  `noop` means another actor already holds the task — stop; do not adopt it.
- After `task.start_doing` applies, set the task node's marker to `[doing]`
  in the owning document (marker only, keep the `^t-...` anchor). The
  checkbox is the document-side source of truth for status; a stale marker
  makes `cutover.audit` report the node `status_ahead` against the DB.
- When `task.create_planned` returned a fresh id, the document node must
  carry it: if the node lacks `^t-...`, write the anchor with
  `document.register_component_id` before flipping the marker.
- Halt on the FIRST non-`applied` disposition (including `noop`) and report the
  response verbatim instead of retrying.
- Bound verification evidence at capture (downscale + count cap) and spill
  any single output over 64 KB to a file, so only the path reaches the
  turn/journal surface — the binding text is `done` "Bounded evidence" /
  "Output spill". Large artifacts the task produced are cleared at the
  task boundary per `done` "Task-boundary artifact cleanup".
- Right after this pane is assigned its role — and before the first handoff —
  align the pane label per "Tab and pane naming" in the shared `herdr.md`
  instructions. That document is the canonical rule — consult it for the
  label shape; this skill only points at it.
- Implement, verify, and review the one task, then hand completion bookkeeping
  to `done`. Do not close the wish.
