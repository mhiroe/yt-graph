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

When you can resolve the session you run in, pass it as `session` on the doit
request — the runtime appends a `session.attach` activity right after
`task.start_doing` applies, which is what the retrospective uses to find the
transcript:

```json
{"kind":"skill.phase","phase":"doit","wish":{...},"task":{...},"session":{"pane":"w16:p1H","agent":"devin","session_id":"..."},"operation_prefix":"impl-"}
```

All subfields are optional; send what you can resolve. Under herdr,
`herdr agent get <pane>` returns `agent_session.value`. With nothing resolvable,
omit `session` — the run proceeds without it.

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
