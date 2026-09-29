---
name: planner
description: Clarify, reconcile, and decompose a workflow v4 wish at the document level, then present the readiness decision to the user. Planner replaces task-tuner in v4; it never approves readiness itself and never touches implementation code (mutation_scope docs_only). Drives the vendored Core under .agents/workflow-v4 through the skill.phase entry only.
---

# Planner (v4)

Planner is the v4 replacement for `task-tuner`. It shapes a wish's *document* —
title, scope, decomposition, acceptance criteria — until it is ready for
`doit`, then hands the readiness decision to the user. Planner never
self-approves.

## Runtime entry

All Core interaction goes through the vendored runtime at
`.agents/workflow-v4/`:

- Skill work: `.agents/workflow-v4/wf4.sh '<request-json>'` — wraps
  `src/harness/skill_entry.ts` (`skill.phase` / `wish.complete` / `wish.transition`
  request kinds).
- Read-only CLI ops: `.agents/workflow-v4/wf4.sh cli '<request-json>'` — raw
  `src/cli/main.ts` read ops (`document.inspect_locator`, `document.list_nodes`,
  `mind_wish.list`).
- First use in a repo: `.agents/workflow-v4/wf4.sh provision <repository-id>`
  writes `.workflow/repository.json` and creates the device-local DB under
  `.workflow.nosync/`.

## Requests

Existing wish:

```json
{"kind":"skill.phase","phase":"planner","wish":{"component_id":"w-...","state_revision":0},"operation_prefix":"plan-"}
```

New wish (register, then plan):

```json
{"kind":"skill.phase","phase":"planner","register":{"kind":"wish","title":"...","locator":"docs/spec_*.md#heading"},"operation_prefix":"plan-"}
```

With iteration layout, the locator belongs to an iteration dir:
`<component>/<it>/docs/wish_<component>.md#heading` for component scope,
`docs/iterations/<it>/wish_<repo>.md#heading` for project scope. The path's
`<it>` segment is the birth iteration; membership goes to the scope's default
iteration. Add `iteration_id` inside `register` when the scope has no default
(register fails closed naming the active labels) or when the wish must join a
non-default active iteration. Resolve `iteration_id` from `iteration.list` /
`iteration.current` read ops — never guess one.

```json
{"kind":"skill.phase","phase":"planner","register":{"kind":"wish","title":"...","locator":"<component>/<it>/docs/wish_<component>.md#heading","iteration_id":"it-..."},"operation_prefix":"plan-"}
```

Resolve `component_id` / `state_revision` only from `applied` responses or the
read ops above — never guess an id.

After `component.register` applies for a new wish, the document section that
represents it must carry `^w-...`; if it does not, write the anchor with
`document.register_component_id`. Unanchored wishes are invisible to
`cutover.scan` / `cutover.bind`.

The same holds for tasks at plan time: **a planned task must carry its `^t-`
anchor before it can be dispatched** — `task.start_doing` rejects unanchored
tasks (`task_document_anchor_missing`). Mint and bind each task node through
`document.create_task` (raw CLI op), never by writing the `^t-` anchor by hand:

```json
{"kind":"document.create_task","operation_id":"plan-t-1","wish_component_id":"w-...","expected_revision":<wish rev>,"title":"<task title>","locator":"docs/wish_<x>.md#Tasks"}
```

`operation_id` must be unique per task. `locator` names the section the
checkbox line joins (the wish's `Tasks` section or the file root). The
response's `component_id` is the minted `t-...` id; on `applied` the line
`- [ ] <title> ^<id>` is written and the projection is bound in the same
request. To bind an anchor on a Task that already exists (repair), pass
`component_id` instead of the mint fields.

## Readiness prerequisites

Before presenting the readiness decision, confirm the wish document carries
(user ruling 2026-09-29, sufficiency classes 3-4):

- An **Open questions** list holding every pending user question — each one
  also sent through the single user-question channel (`gm`, per `herdr.md`).
- The wish's **cross-wish dependencies and triggers** — what it blocks, what
  blocks it, and any pre-authorized wake path.

Neither may live only in a PM file, handoff note, or dispatch claim. If a
question or dependency is still external, write it into the document first,
then present readiness.

## Boundaries

- `mutation_scope` is `docs_only`: planner edits the wish's Markdown document
  and spec text, never implementation code.
- Re-entering planner on a wish that is already in `plan` is a resume: the
  `wish.plan_begin` response reports `noop` (the state already holds) and the
  run still completes with `docs_only` open — proceed to the document work.
- Planner ends by presenting the readiness decision to the user. It does not
  mark the wish `ready` itself; `doit` requires the user's explicit readiness
  decision first. To park a wish, the user instruction goes through
  `wish.transition` with `wish.set_pending` + a verbatim `reason`.
- If the run halts (`halted_at` set / exit 3) or returns an error, stop and
  report — do not retry with guessed state.

## Tab naming

When planning starts, name (or adopt) the work's tab per "Tab and pane
naming" in the shared `herdr.md` instructions. That document is the canonical
rule — consult it for the label shape; this skill only points at it.
