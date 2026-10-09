# Workflow v4 Contract Format

**The canonical format reference for workflow v4 repos.** Covers the wish / task node format,
the spec format, the three-layer rule split, and the v4 docs layout. Read this only when a v4
skill or task requires it — never in full at session start.

v4 carries this as a package reference instead of inlining it into every `docs/rule_*.md` /
`docs/spec_*.md`. Where a repo doc says "the vendored workflow contract", it means this file at
`.agents/skills/workflow-v4-contract/references/contract-format.md`.

## index

- [node format](#node-format)
- [spec format](#spec-format)
- [rule layers](#rule-layers)
- [docs layout](#docs-layout)
- [reading rules](#reading-rules)

## node format

Wishes and tasks are Markdown nodes under `docs/`; the vendored Core under
`.agents/workflow-v4/` projects them into the device-local SQLite DB.

- **Anchors are the identity.** A task node carries `^t-<id>` at end of line; a wish node
  carries `^w-<id>` the same way (end of its line, or on the property line directly beneath a
  heading). Ids are allocated by the Core (`skill.phase` / `cutover.bind`); never hand-mint one.
  A node that gets an id keeps it forever — moving the node between files or sections does not
  change it; re-run `cutover.bind` so the projection follows.
- **Checkbox is the document-side status.** `[ ]` drafted, `[backlog]` planned, `[ready]` ready
  with prerequisites in place, `[x]` explicit execute-now instruction from the user, `[doing]`
  running (`doit` flips it), `[done]` complete (`done` flips it), `[resume]` stopped mid-run.
  Unknown checkbox states are user-land; never rewrite them. Deleting a finished node is the
  user's operation, not `done`'s.
- **Marker scans read the node line only.** A status scan reads the checkbox and the `^t-` /
  `^w-` / `^m-` anchor on the node's own line — nothing else. A `^id` inside backticks or prose
  (including quoted examples like this one) is a mention, not an anchor; a checkbox marker
  inside a code span is not a status. Scans that match `^id` anywhere in a file misfire on
  exactly these cases.
- **Notes nest under the node.** Plain bullets under a task node are its notes, acceptance
  criteria, and references. A nested checkbox is a child subtask — no separate `children` list.
- **Code placement is canonical.** A task whose representative implementation point is settled
  lives in that code's comment, with identical notation minus one comment leader
  (`//` / `#` / `--` / `;` / `*` / `<!--` — in Markdown files strip nothing). One node per task;
  do not split body and `^t-` id across files.
- **State lives in the DB.** v4 drops the per-node property callout (`> [!meta]-`) — status,
  links, and history are Core-side. The Markdown node holds existence, position, text, and the
  anchor only.
- **One generated binding key is the exception.** An accepted `sprint.issue`
  writes `> sprint: <sprint_id>` inside the node's `[!meta]` callout (creating
  the callout when absent). It marks the latest sprint whose roster contains
  the node inside its effective iteration, is produced only by the Core
  projection, and is rewritten from the DB by `sprint.repair` when it drifts —
  never hand-write it. Read-side the same binding appears as the `sprint`
  field on `wish_query.preflight` / `component.list` / `document.list_nodes`
  rows.

## spec format

`docs/spec_*.md` are the canonical specification documents.

- **Frontmatter** (fixed key order): `title` (same as the H1), `weight` (`0`; user-owned, agents
  never change it unprompted), `visible` (`false` for specs), `children` (`[]`; heading
  hierarchy carries in-file structure), `tags` (at least `spec`). Keep an H1 after the
  frontmatter.
- **`## index` first.** An unordered link list at the top; agents read the index and open only
  the needed sections. No numbered headings — reordering must not require renumbering.
- **Headings express hierarchy.** `#` near the file root, `##` child, `###` grandchild. A node's
  body runs to the next heading at the same or higher level.
- **Relations are wikilinks** in the body (`[[file]]` / `[[file#heading path]]`), not
  frontmatter. Agents do not guess related nodes.
- **Implementation references** go directly under the spec item in `file_path:symbol` form; do
  not force one where none exists.
- **Settled content only.** Leave only continuously maintained content in the body; v4 keeps no
  `docs/work_log.md` (history lives in the DB activity and Git).

## rule layers

Settled policy that survives task completion splits into three layers. The format below is what
`docs/rule_*.md` files and the global `constitution.md` / `laws.md` follow.

| layer | location | scope |
| --- | --- | --- |
| constitution | `constitution.md`, delivered by the session entrypoint | all repos; changes the workflow itself |
| shared laws | `laws.md`, same entrypoint-delivered instructions dir | multiple repos |
| repo laws | repo-local `docs/rule_*.md` | this repo only |

- **Placement test (top to bottom; first match wins):** dies with its task -> spec; changes how
  the workflow proceeds -> constitution; needs the same judgment in two or more repos -> shared
  law; otherwise -> repo-local law. Shared cutoff at every step: if the agent would not judge
  differently without the statement, write it nowhere.
- **Markers are citation identifiers.** Each law carries one scope line and one
  constitution-binding line under its `###` heading — never omit either. The canonical pair is
  `適用範囲:` / `憲法:` (Japanese) with `憲法: なし (repo 自治)` for unbound laws; repos that
  adopted the English template use `scope:` / `constitution:` with `constitution: none (repo
  autonomy)`. A repo keeps one convention and its checker (`scripts/check_rule_layers.py` in
  dotfiles) matches it — do not mix or translate mid-repo.
- **Repo laws win on conflict.** A repo may hold conventions the constitution lacks; where they
  conflict (mandatory review, imported conventions), the repo law wins — say so in one line on
  the law side. Skills have no autonomy: on skill-vs-constitution conflict, fix the skill.
- **File shape:** fixed sections `## 載せる判定` (points here only), `## 適用範囲` (that file's
  scope vocabulary, 3-5 areas; `全域` only for what truly applies everywhere), `## 法律` (laws
  under `###` headings). Start with one file; split only when it overflows.
- **Rule text is prohibition (`〜しない`) or ownership (`〜を正本とする`) only.** Procedures are
  specs, not rules. Rationale stays in 1-2 line child bullets.

## docs layout

The v4 provision contract (project -> component); iterations are live as of schema 7.

```text
<repo>/
  docs/                            project scope
    rule_<repo>.md                 spans iterations
    sprints.md                     generated Sprint registry (v2)
    iterations/<it>/               project iteration
      wish_<repo>.md               project-owned wish
    active/<it> -> iterations/<it>   one link per ACTIVE iteration
    current -> iterations/<it>     OPTIONAL default (absent = none)
  <component>/                     unit of work (e.g. visualiser/)
    <it>/                          component iteration — starts EMPTY
      docs/                        component docs (wish_<component>.md, task nodes)
      spec/                        component specs — versioned with the app
      app/                         the code — lives INSIDE the iteration
    active/<it> -> ../<it>         one link per ACTIVE iteration
    current -> <it>                OPTIONAL default (absent = none)
```

- **Active set + optional default.** Several iterations of one component may be
  active at once (parallel work is normal — they are different things, not
  branches to merge). `active/<label>` links enumerate the set; `current` exists
  only while a default is set and always points at a member of `active/`. When a
  scope has actives but no default, every single-answer consumer (build entry,
  `component.register` / `task.create_planned` membership, `iteration.current`,
  sync include set) must be given the iteration explicitly or fails closed
  naming the component and the active labels — never auto-picks, never falls
  back to seq or timestamp order.
- **Opening a work-unit.** `iteration.open` creates the empty
  `<component>/<it>/{docs,spec,app}` skeleton plus the DB row; it does not
  activate. `iteration.switch` is the composite `activate + set_default`; the
  granular ops `iteration.activate` / `deactivate` / `set_default` exist for
  parallel work. Component dirs and skeletons are Core-owned — never mkdir them
  by hand.
- Iteration directory labels are FREE — FINAL user ruling 2026-09-23 (verbatim
  recorded in the wish doc; e.g. `visualiser/{mockup,v8}/` + `current -> v8/`;
  supersedes the earlier `itr<N>` ruling). The caller picks the label; the Core
  validates the charset (`[a-z0-9-]`),
  rejects reserved names (`current`/`docs`/`spec`/`app`/`active`) and duplicates per component
  (no reuse — a remake gets a new label). Ordering comes from the DB sequence number,
  never the directory name — the name is display only. The `active/` links and
  the `current` symlink are derived from the DB (canonical) and committed to git
  so other devices inherit them.
- Component docs live under the component path, not under the project iteration.
- Iterations are directories **and** DB rows; a wish's iteration is fixed at birth and the file
  does not move. Only the DB links a project iteration to component iterations — no manifest.
- **`docs/sprints.md` is the generated Sprint registry** (v2): `## current`
  holds the head pointer per iteration; `## sp-*` sections are immutable
  issued entries (goal, iteration, roster). A Sprint belongs to exactly one
  Iteration and groups its members' accepted work; the Core DB is canonical
  and the file is the committed cross-repository projection — never
  hand-edit or delete entries.
- A node doc's frontmatter carries three **generated** keys — `iteration: <seq>`
  (numeric, for compare/sort), `iteration_label: <label>` (the label string, e.g.
  `v8`), and `iteration_created: <iso>` (the iteration's creation timestamp, ISO 8601
  UTC) — written only by the projection, never hand-written (user rulings
  2026-09-23). Ordering authority is the sequence number, never name or timestamp.
  The DB is the source of truth; a stale key is a projection bug, flagged by audit. Purpose:
  filtering / browsing nodes by iteration in Obsidian.
- All existing docs at cutover belong to the first iteration; decayed specs stay there and fall
  out of the next iteration's reference scope.
- **No `docs/work_log.md`.** History is DB activity + Git. Agent-owned docs are English; the
  wish's User area stays in the user's verbatim language.

## opening and switching an iteration

The app lives inside the iteration (`<component>/<it>/app`) and does not span
iterations, so opening a new iteration on an existing component is an explicit
switch with a Core part and an agent-run runbook part.

Core steps (in order — all through `wf4.sh`, never hand-mkdir or hand-link):

1. `iteration.open` — `scope`, `component_path`, a free `name` (label), optional
   `predecessor_iteration_id` (lineage only — it closes nothing, even when the
   predecessor stays active). Creates the empty `<component>/<it>/{docs,spec,app}`
   skeleton and the DB row; does **not** activate.
2. `iteration.carry` — optional; re-exposes existing nodes/components as members
   of the new iteration. The same members can ride `iteration.switch`'s
   `components` / `documents` fields for the one-op form.
3. Activate, per intent:
   - new iteration becomes the working default → `iteration.switch`
     (composite `activate` + `set_default`);
   - parallel work without disturbing the current default → `iteration.activate`
     only;
   - hand the default over later → `iteration.set_default` (target must already
     be active; clearing it entirely is `iteration.deactivate` on the default —
     legal, leaves the scope with no default).

Runbook steps (agent-run — the Core cannot know a repo's pointers):

- **Build / run entrypoint** — repoint at the new iteration's `app/` (through
  `<component>/current` while a default exists; an explicit
  `<component>/<label>/` path when it does not).
- **Task-runner paths** — same rule as the build entry.
- **Cross-repo pointers** — the sync include set and other repos' references
  into the app path (deploy targets, plugin paths). Under the optional-default
  rule an include set names active iteration dirs explicitly or resolves the
  `active/` links; it never assumes `current` exists. A consumer that needs one
  answer and finds no default fails closed naming the component and the active
  labels.
- **Docs references** — durable references name `<component>/<label>/...`;
  `current/...` paths are convenience-only and must not appear in anything
  meant to survive a default change.
- **Commit** — `active/` + `current` links and member symlinks are derived but
  committed state (the cross-device carrier). A switch is not complete until
  the tree state lands in git.

The repo's `docs/spec_repo_workflow.md` names the concrete build entry, runner
paths, and cross-repo pointers for that repo — the runbook above is the generic
checklist those entries fill in.

## reading rules

- Read the constitution in full (it is kept thin by contract). Never read law files in full —
  scan `###` headings + scope lines, open only what overlaps the task.
- `AGENTS.md` / `CLAUDE.md` carry only the route: layer names and locations in a few lines. Do
  not copy article or law bodies into entry files.
- On noticing a task-rule conflict, stop and return to the user — the agent does not rewrite
  rules to proceed.
