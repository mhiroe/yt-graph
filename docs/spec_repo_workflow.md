---
title: repo workflow spec
weight: 0
visible: false
children: []
tags:
  - spec
iteration: 0
iteration_label: init
iteration_created: 2026-10-10T16:36:39.578Z
---

# repo workflow spec

## index

- [task node model](#task-node-model)
- [test / lint / TDD](#test--lint--tdd)
- [branch policy](#branch-policy)
- [directory layout](#directory-layout)
- [switching iterations](#switching-iterations)
- [document layout](#document-layout)
- [README policy](#readme-policy)

## task node model

- **This repo uses the workflow v4 series.** Wishes and tasks are nodes in the
  Markdown documents under `docs/`; the vendored Core under
  `.agents/workflow-v4/` projects them into SQLite.
- `.workflow/repository.json` is the tracked repository-identity manifest.
  `.workflow.nosync/` is device-local (DB and registry); it is gitignored and
  never committed or synced.
- All Core access goes through `.agents/workflow-v4/wf4.sh` (`skill.phase` /
  `wish.complete`); do not edit the manifest or the DB by hand.
- `planner` shapes a wish's document and presents the readiness decision to the
  user — it never self-approves. `doit` executes only after the user's
  readiness decision and only while `task.start_doing` applies. `done`
  completes the task with recorded verification.
- `done` never closes a wish; `wish.complete` fires only on an explicit user
  instruction carrying the user's own reason.

## test / lint / TDD

- docs だけの変更では、表示確認とリンク・参照先の整合確認を最低限の検証とする。
- formal test が薄いうちは smoke 確認を最小 test scope として扱う。
- smoke の正本 command は `pnpm exec node path/to/script.js --help` を叩き台にする。
- formal test を導入したら `pnpm test` を候補にして spec を更新する。
- FIXME(project): if e2e or integration tests are adopted, fix the adoption conditions here.

## branch policy

- この repo は現時点で shared `git-worktree` に opt-in しない。
- `main` / `master` への直接 push は、ユーザーが明示的に求めた場合だけに限る。
- commit も実行前にユーザーの明示承認を取る (user ruling 2026-09-27)。
- branch 戦略が必要になったら `.agents/worktree-policy.toml` 導入前に `docs/spec_repo_workflow.md` へ判断基準を追記する。
- Cut a topic branch for multi-commit work, wide-impact changes, or destructive changes.
- Docs-only small changes, or continuing work the user has checked out, may stay on the current branch.

## directory layout

- The primary language is `TypeScript`, the main framework / app shape is `React + Three.js (3D graph) + Vite web UI over a local API (SQLite)`, and `pnpm` is the assumed runtime.
- domain 層はまだ固定しない。責務分離が必要になった時点で `docs/spec_domain.md` を追加または育成する。
- `docs/` holds the canonical specs and wishes; handoff between sessions lives in the wish
  documents and the Core's activity, not a `docs/work_log.md`.
- **Work-units live in iteration layout.** A component `<component>/` holds one
  or more iteration dirs `<component>/<it>/{docs,spec,app}`; `docs/` is the
  project-scope sibling (`docs/iterations/<it>/`). `active/<label>` symlinks
  enumerate the active set and `current` is an optional default — several
  iterations may be active at once. See
  `.agents/skills/workflow-v4-contract/references/contract-format.md` "docs
  layout" for the canonical shape.
- **New components are provisioned through the Core, never by hand.**
  `iteration.open` creates the skeleton dir + DB row; `iteration.switch`
  activates it and sets the default. Agents do not mkdir iteration dirs or
  hand-write `current`/`active` links.
- `scripts/`, `apps/`, `packages/` and similar placements are decided per project.
- FIXME(project): fix the actual directory layout here.

## switching iterations

Opening a new iteration on an existing component is an explicit switch — the
app does not span iterations. The Core steps and the generic checklist live in
`.agents/skills/workflow-v4-contract/references/contract-format.md` "opening
and switching an iteration"; this section names this repo's concrete pointers
that the runbook moves.

- **Build / run entrypoint:** FIXME(project): the command / script that builds
  or runs a component's `app/` — and whether it follows `current` or takes an
  explicit `<component>/<label>/` argument.
- **Task-runner paths:** FIXME(project): runner / script paths that reference
  an iteration dir.
- **Cross-repo pointers:** FIXME(project): sync include set entries and other
  repos' references into this repo's app paths (deploy targets, plugin paths).
  Under the optional-default rule these name iteration dirs explicitly or
  resolve `active/` links — they never assume `current` exists.
- **Commit:** the switch is not complete until `active/` + `current` links and
  the pointer edits land in git — the committed tree is the cross-device
  carrier.

## document layout

- Canonical specs: `docs/spec_*.md`. Repo-only laws: `docs/rule_yt-graph.md`.
- Product purpose, scope, I/O, and constraints consolidate in `docs/spec_product.md`.
- Repo workflow rules consolidate here; `AGENTS.md` keeps only the entry points.
- Provision input stays in `docs/spec_provision.md`; promote only what remains in continuous operation into the specs.
- Component-scoped docs belong to their iteration: wishes and task nodes under
  `<component>/<it>/docs/`, component specs under `<component>/<it>/spec/`;
  project-scope wishes under `docs/iterations/<it>/`. Docs outside any
  iteration (`rule_*.md`, `AGENTS.md`, `README.md`, `docs/spec_*.md` that span
  components) stay at their root locations — they are not versioned per
  iteration.
- Markdown is canonical; the SQLite projection is derived state. If they disagree, the Markdown wins and the projection is rebuilt.

## README policy

- README is the user-facing entry and keeps at least: project overview, usage, script / app usage, environment, setup.
- Update README in the same diff when entrypoints, dependencies, startup, or prerequisites change.
- Write setup steps and run examples only after reproducing them locally in the same task.
