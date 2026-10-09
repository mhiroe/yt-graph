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

## Related-work gate — runs on EVERY entry

Before registering a wish or planning a task — on every planner entry,
regardless of who dispatched the work or how narrow the brief — run the
related-work lookup (user ruling 2026-10-09: agents do only the literal
ask unless the lookup is a gate; wall-bounce prompting does not scale).
A brief's scope narrowing never exempts it.

The lookup has three legs, all bounded:

1. `.agents/skills/wish-query/scripts/wish_query.ts preflight
   --title '<proposed outcome>'` — Core candidate evidence
   (`wish_query.preflight`).
2. `.agents/skills/wish-query/scripts/wish_query.ts body-scan
   --term '<term>' [--term ...]` — bounded body-text scan over
   `docs/wish_*.md`. Title tokens cannot reach prose design inside a
   wish body (the 2026-10-09 miss), so this leg is mandatory; seed terms
   from the proposed outcome plus the dispatch's key nouns.
3. Read every origin document the dispatch/brief cites (PM-PM requests,
   `.agent-state/intake/*`) — cited origins are inside the lookup set.

Fail closed — do NOT register, plan, or mint when:

- a leg returns `complete:false`, any truncation flag, or an adapter
  error: re-run once with tighter bounds/terms; still unclean → report
  to the dispatcher and stop;
- the result is ambiguous about ownership;
- the related set shows WIDER impact than the brief's claimed scope —
  stop and raise scope to the user through the owning PM's question
  route before any write (reference miss: t-01M4EX7NFQ, which accepted
  an asakai-only slice while its cited PM-PM request already placed
  sprint work in Core territory).

Evidence line — one per Story:

On pass, write ONE bounded line in the Story's identity prelude — a
`> ` callout line adjacent to the `> [!meta]- w-…` / `^w-…` block (the
same slot `> sprint:` uses; prelude lines never enter `body_hash`, so
the line cannot stale-flag itself):

    > related-work evidence: v1 at=<YYYY-MM-DDTHH:MMZ> story=<w-id>@<rev> owner=<id>@<rev>|no-match disposition=<candidate_found|no_match_within_bounds> bounds=scan:<n>/<lim>,cand:<n>/<lim> body=files:<n>/<cap>,set:<matched_digest>,terms:"<t1,t2>" origins=<n|none> outcome="<title, ≤40 chars>"

- `story` is the owning wish's `component_id` + the `state_revision` at
  evidence-write time (`wf4.sh revision <w-id>`); the rev is the
  audit basis — later lifecycle transitions (e.g. `request_ready`) bump
  it legitimately.
- `set` is the body-scan's `matched_digest` (membership fingerprint of
  the matched file set — content edits inside an unchanged set do not
  alter it); `terms` are the exact normalized scan terms, so the delta
  check re-runs byte-identically.
- Write or refresh the line at the END of the planning pass (after task
  mints); refresh in place on every later planner entry — one canonical
  line, never a trail.
- A truncated leg blocks the write: `truncated` never appears in a
  committed line.
- Candidate lists never persist — the line records ids, counts, and the
  digest only.
- Keep the whole line ≤ ~480 chars.

Related-set line — one per Story, beside the evidence line:

On pass the planner also resolves WHICH Stories are related and how —
a planner run plans a wish TOGETHER with its related set, never in
isolation (user ruling 2026-10-09). Write ONE bounded `> ` line in the
same identity-prelude slot (adjacent to `> related-work evidence:`):

    > related set: v1 owner=<w-id|none> sibling=<w-id,...|none> duplicate=<w-id,...|none> blocks=<w-id,...|none> blocked-by=<w-id,...|none>

- Classes (relative to the primary Story): `owner` — the related Story
  owns the overlapping scope (defer or coordinate through it);
  `sibling` — adjacent non-overlapping scope in the same area;
  `duplicate` — overlap large enough to propose merge/drop; `blocks` —
  the primary blocks it; `blocked-by` — it blocks the primary.
- Bounds: ≤8 ids total, ≤4 per class, comma-separated with no spaces,
  `none` for an empty class, whole line ≤ ~480 chars. A set that does
  not fit the line is itself the "wider impact" halt — raise scope to
  the user before writing anything.
- Write it even when the lookup found nothing (all classes `none`) —
  the line proves the classification ran. Refresh in place on every
  planner entry, never a trail.
- This is the run's RESOLVED set, not the raw candidate list — the
  candidate-lists-never-persist rule still stands.
- The durable relations themselves land as standing
  `Blocks:`/`Blocked by:`/`Related:`/`Coordinated with:` lines in the
  Story's `### Cross-wish dependencies and triggers` section (create
  the section if absent) — same pass, both records agree.

## Related-set planning — cross-wish edits

The run may apply edits to any Story inside the recorded related set.
Each seam is gated by the thing it actually mutates — never reuse the
primary's revision or hash on a related Story.

- **Move a task between Stories** — `wf4.sh cli
  '{"kind":"document.read_task","component_id":"<t-id>"}'` (fetch
  `block_hash` + `owner_locator`), then
  `wf4.sh cli '{"kind":"document.move_task","component_id":"<t-id>",
  "expected_hash":"<block_hash>","new_parent_component_id":"<related
  Story or section node>"}'`. The gate is the MOVED block's hash — it
  does not detect concurrent edits to the destination Story, so
  sequence moves last in a pass and let `cutover.bind` reconcile the
  doc↔DB projection afterwards. Works within one file and across files;
  `noop` if already there, `conflict` on a stale hash — never retry a
  conflict without re-reading.
- **Mint a task on a related Story** — `document.create_task` with the
  RELATED wish's `component_id` + `expected_revision` (re-read
  `wf4.sh revision <w-id>` immediately before use), locator inside its
  own doc (same shape as under "Requests").
- **Cross-wish relation lines** — prose `Blocks:`/`Blocked by:`/
  `Related:`/`Coordinated with:` lines in BOTH Stories'
  `### Cross-wish dependencies and triggers` sections. These are plain
  doc edits under `docs_only` — there is no dedicated Core op for them,
  and Core `relation.attach` types are lineage semantics only and must
  not be stretched for topical links (standing convention). Apply them
  deliberately, one line per side; every added line is disclosed in the
  readiness package.
- **Split a related Story** — additive only: `component.register` for
  the new Story, then task moves + relation lines. A split never drops
  the source Story.
- **Merge / drop of a related Story** — PROPOSAL only. Execution stays
  user-gated via `wish.transition` carrying the user's verbatim reason;
  planner lists the proposal in the readiness package and never fires
  the transition itself.
- **Dry-run mode** — the pass emits the related set plus the per-Story
  proposal and preview diff while mutating nothing else: no task
  moves/mints, no relation lines, no lifecycle requests. The only
  writes are the two identity-prelude lines (they never enter
  `body_hash`, so the projected body is untouched). This is the
  organize step's dry-run shape (sprint design, Q5).
- The wider-impact halt stands unchanged: a related set showing scope
  beyond the brief stops the run before any write.

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
  routed by decision class (`herdr.md` "User questions (routing by decision
  class)"): a co-present direct user turn may be answered in the PM's own
  reply; absent user, a user-decision question goes to `gm_secretary`
  (intake) and a gm-judgment question to `gm`.
- The wish's **cross-wish dependencies and triggers** — what it blocks, what
  blocks it, and any pre-authorized wake path.
- The **related-set impact** — for every member of the recorded related set,
  one line stating what this plan does to it: relation lines added, tasks
  moved/minted, a split applied, a merge/drop proposal pending the user
  gate, or `no change`. A related Story the run touched is never absent
  from the package.

Neither may live only in a PM file, handoff note, or dispatch claim. If a
question or dependency is still external, write it into the document first,
then present readiness.

## Boundaries

- `mutation_scope` is `docs_only`: planner edits the wish's Markdown document
  and spec text, never implementation code.
- The related set rides the EXISTING request shape — `skill.phase` planner
  still opens `wish.plan_begin` on ONE wish. There is no multi-wish request
  kind in the harness (decision t-01M4F8WHHK, 2026-10-09): `docs_only` is a
  phase-level scope, not per-component, so a single `plan_begin` already
  covers doc edits on related Stories; and every cross-wish mutation seam
  (`document.move_task` / `document.create_task` / `wish.transition`)
  already carries its own gate on the mutated object (block hash / target
  revision / user verbatim) — a batched related-set request would add
  Core contract surface for zero new capability. The skill loops per
  related wish instead. Revisit only if a
  future need demands one atomic multi-wish transaction.
- Re-entering planner on a wish that is already in `plan` is a resume: the
  `wish.plan_begin` response reports `noop` (the state already holds) and the
  run still completes with `docs_only` open — proceed to the document work.
- Planner ends by presenting the readiness decision to the user. It does not
  mark the wish `ready` itself; `doit` requires the user's explicit readiness
  decision first. To park a wish, the user instruction goes through
  `wish.transition` with `wish.set_pending` + a verbatim `reason`.
- Dropping a task (dedupe / superseded / cancelled) is doc-first: set the
  node's marker to `[dropped]` in the owning doc, then run
  `wf4.sh cli '{"kind":"cutover.bind"}'` — bind emits the typed `task.drop`
  (`cutover-drop-<id>`). Bind is a repo-wide reconcile, not a scoped op: it
  drives every checkbox↔DB divergence, so run it on a converged tree and read
  `status_transitions` / `findings` in the report. The op's `reason` is
  mechanical (`cutover bind: ...`) — record the human reason in the task line,
  the commit, or the return. Raw `workflow.submit` is NOT a sanctioned agent
  seam (the caller hand-builds the command envelope — the wart this path
  replaces). There is no `task.transition` request kind.
- If the run halts (`halted_at` set / exit 3) or returns an error, stop and
  report — do not retry with guessed state.

## Tab naming

When planning starts, name (or adopt) the work's tab per "Tab and pane
naming" in the shared `herdr.md` instructions. That document is the canonical
rule — consult it for the label shape; this skill only points at it.
