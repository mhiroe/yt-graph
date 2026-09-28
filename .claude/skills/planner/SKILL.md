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
  `src/harness/skill_entry.ts` (`skill.phase` / `wish.complete` request kinds).
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

## Boundaries

- `mutation_scope` is `docs_only`: planner edits the wish's Markdown document
  and spec text, never implementation code.
- Planner ends by presenting the readiness decision to the user. It does not
  mark the wish `ready` itself; `doit` requires the user's explicit readiness
  decision first.
- If a response disposition is not `applied`, stop and report — do not retry
  with guessed state.

## Tab naming

When planning starts, name (or adopt) the work's tab per "Tab and pane
naming" in the shared `herdr.md` instructions. That document is the canonical
rule — consult it for the label shape; this skill only points at it.
