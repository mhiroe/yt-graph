#!/usr/bin/env bash
# wf4-retro — per-task retrospective report for workflow v4 (prototype).
#
# usage: wf4-retro.sh <task_id> [--write] | --aggregate
#
# --aggregate folds journal entries written since .journal-cursor into
# retro/ledger.md (record-now / aggregate-later per the v4 retro design).
#
# Reads the device-local Core DB (.workflow.nosync/workflow.sqlite), git state,
# and (when resolvable) the agent session transcript. Prints a short
# went-well / wasted / change report. With --write it also appends the same
# report to .workflow.nosync/retro/journal/<date>/<ts>-<id>.md — the journal
# file carries the full report so the aggregate pass can read it standalone.
# --write only lands a journal for a terminal task (done / dropped): a journal
# on a task still doing is a snapshot of an unfinished run, not a retro.
# --write is idempotent per task x state_revision: a re-run for the same
# state reports the existing journal instead of writing a duplicate.
#
# Residue subtracts structural noise before flagging, so the flag means task
# dirt: task-own paths (files touched in the change window + the marker doc —
# still uncommitted because retro runs pre-commit) and grep -E exclusions,
# one pattern per line ('#' comments allowed), read from
#   .workflow/retro-residue.exclude         — repo-shared (e.g. a vault tree)
#   .workflow.nosync/retro/residue.exclude  — device-local standing WIP
#   WF4_RETRO_RESIDUE_EXCLUDE               — one extra pattern
#
# Journal emission is unconditional (gm.md:1142): the done skill runs
# `wf4-retro.sh <task_id> --write` on every completed task — measured cost
# ~1.6KB stdout (~400 tokens) per task, journal bodies are read only by the
# mechanical aggregate, never by agents. There is no on/off switch: the
# "retrospective" repository.json flag and the WF4_RETRO* env knobs were
# removed rather than inverted. `--enabled` survives only as a deprecated
# stub that always exits 0, so skill text deployed before the removal keeps
# working during rollout — new callers must not use it.
# All reads are local. Degrades to "unavailable" per check.
set -euo pipefail

# deprecated compat stub for pre-removal done skill text
if [ "${1:-}" = "--enabled" ]; then
  exit 0
fi

# --- aggregate: journal diff since cursor -> ledger.md -----------------------
# Reads journal entries newer than .journal-cursor (relpath sort order is
# chronological), appends one dated section per run to retro/ledger.md, and
# advances the cursor. Journal files carry the full per-task report, so this
# pass only re-reads them — no DB or git access needed.
if [ "${1:-}" = "--aggregate" ]; then
  root="${WF4_ROOT:-}"
  if [ -z "$root" ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  fi
  retro_dir="$root/.workflow.nosync/retro"
  journal_dir="$retro_dir/journal"
  cursor_file="$retro_dir/.journal-cursor"
  ledger="$retro_dir/ledger.md"
  cursor=""
  [ -f "$cursor_file" ] && cursor=$(cat "$cursor_file")
  new_entries=$(find "$journal_dir" -name '*.md' -type f 2>/dev/null \
    | sed "s|^$journal_dir/||" | sort | awk -v c="$cursor" '$0 > c' || true)
  n_new=$(printf '%s\n' "$new_entries" | grep -c . || true)
  if [ "$n_new" -eq 0 ]; then
    echo "aggregate: no new journal entries since ${cursor:-(beginning)}"
    exit 0
  fi
  mkdir -p "$retro_dir"
  {
    echo "## $(date +%Y-%m-%dT%H:%M:%S) aggregate — $n_new journal(s)"
    echo
    printf '%s\n' "$new_entries" | while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      f="$journal_dir/$rel"
      tid=$(sed -n 's/^# retro //p' "$f" | head -1)
      title=$(sed -n 's/^title: //p' "$f" | head -1)
      verif=$(sed -n 's/^verification: //p' "$f" | head -1)
      marker=$(sed -n 's/^marker: //p' "$f" | head -1)
      residue=$(sed -n 's/^residue: \([0-9]*\).*/\1/p' "$f" | head -1)
      session=$(sed -n 's/^session: //p' "$f" | head -1)
      transcript=$(sed -n 's/^transcript: //p' "$f" | head -1)
      echo "### ${tid:-$rel} — ${title:-(untitled)}"
      echo "- verification: ${verif:-(none)}"
      echo "- marker: ${marker:-?} | residue: ${residue:-0} | session: ${session:-?} | transcript: ${transcript:-?}"
      # friction bullets: lines between the section header and the marker line
      awk '/^wasted \/ friction:/{f=1;next} /^marker:/{f=0} f&&/^  /' "$f" \
        | sed 's/^  */  - /'
      echo
    done
    # signals: second pass with a heredoc-fed loop so counters persist
    # (a piped `while` would run in a subshell).
    n_friction=0; n_residue=0; n_transcript=0
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      f="$journal_dir/$rel"
      awk '/^wasted \/ friction:/{f=1;next} /^marker:/{f=0} f&&/^  /{found=1} END{exit !found}' "$f" \
        && n_friction=$((n_friction + 1))
      r=$(sed -n 's/^residue: \([0-9]*\).*/\1/p' "$f" | head -1)
      [ "${r:-0}" -gt 0 ] && n_residue=$((n_residue + 1))
      # resolved only when a transcript line exists and is not "unavailable"
      # (journals from before the field existed must not count as resolved)
      t=$(sed -n 's/^transcript: //p' "$f" | head -1)
      [ -n "$t" ] && [ "$t" != "unavailable" ] && n_transcript=$((n_transcript + 1))
    done <<EOF_ENTRIES
$new_entries
EOF_ENTRIES
    echo "### signals"
    echo "- friction flagged: $n_friction/$n_new"
    echo "- residue flagged: $n_residue/$n_new"
    echo "- transcripts resolved: $n_transcript/$n_new"
    echo
  } >> "$ledger"
  last=$(printf '%s\n' "$new_entries" | tail -1)
  printf '%s\n' "$last" > "$cursor_file"
  echo "aggregate: $n_new journal(s) -> $ledger (cursor: $last)"
  exit 0
fi

task_id="${1:-}"
[ -n "$task_id" ] || { echo "usage: wf4-retro.sh <task_id> [--write] | --aggregate" >&2; exit 2; }
write=0
[ "${2:-}" = "--write" ] && write=1

root="${WF4_ROOT:-}"
if [ -z "$root" ]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi
db="$root/.workflow.nosync/workflow.sqlite"
[ -f "$db" ] || { echo "wf4-retro: $db missing; run wf4.sh provision first" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "wf4-retro: sqlite3 required" >&2; exit 1; }

# --- DB row for the task ----------------------------------------------------
row=$(sqlite3 "$db" \
  "SELECT status, state_revision, created_at FROM components WHERE component_id='$task_id'" 2>/dev/null || true)
[ -n "$row" ] || { echo "wf4-retro: no component $task_id" >&2; exit 1; }
status=${row%%|*}; rest=${row#*|}; rev=${rest%%|*}; created_at=${rest#*|}
title=$(sqlite3 "$db" \
  "SELECT title_projection FROM components WHERE component_id='$task_id'" 2>/dev/null || true)
locator=$(sqlite3 "$db" \
  "SELECT document_locator FROM components WHERE component_id='$task_id'" 2>/dev/null || true)
completed_at=$(sqlite3 "$db" \
  "SELECT created_at FROM operations
    WHERE target_component_id='$task_id' AND operation_type='task.complete' AND disposition='applied'
    ORDER BY created_at DESC LIMIT 1" 2>/dev/null || true)
verification=$(sqlite3 "$db" \
  "SELECT payload_json FROM operations
    WHERE target_component_id='$task_id' AND operation_type='task.complete' AND disposition='applied'
    ORDER BY created_at DESC LIMIT 1" 2>/dev/null | python3 -c \
    'import json,sys
try: print(json.loads(sys.stdin.read()).get("verification","") or "")
except Exception: print("")' 2>/dev/null || true)

# --- op chain ---------------------------------------------------------------
ops=$(sqlite3 "$db" \
  "SELECT operation_type || '|' || disposition FROM operations
    WHERE target_component_id='$task_id' OR result_component_id='$task_id'
    ORDER BY created_at" 2>/dev/null || true)
bad_ops=$(printf '%s\n' "$ops" | grep -v '|applied$' | grep -v '^$' || true)
have_create=$(printf '%s\n' "$ops" | grep -c 'task.create_planned|applied' || true)
have_ready=$(printf '%s\n' "$ops" | grep -c 'task.request_ready|applied' || true)
have_doing=$(printf '%s\n' "$ops" | grep -c 'task.start_doing|applied' || true)
have_done=$(printf '%s\n' "$ops" | grep -c 'task.complete|applied' || true)
chain_ok=1
[ "$have_doing" -ge 1 ] && [ "$have_done" -ge 1 ] || chain_ok=0

# --- marker parity ----------------------------------------------------------
# node 行だけを拾う (id が backtick 参照で出る file を誤認しない)。code comment に
# 置かれる task node (`// - [done] ... ^t-` 等) も拾えるよう、行頭の comment
# prefix を許す。探す場所は projection が持つ document_locator が正本 — module 配下
# (`visualiserN/` 等) の node も拾える。locator が無い / file が無い時は tracked
# file 全体へ git grep で fallback し、最後に docs/ だけ未追跡分も見る。
node_re="^[[:space:]]*(<!--|//|/\\*|#|\\*|--)?[[:space:]]*- \[[^]]*\].*\^$task_id"
marker_line=""; marker_file=""; marker_state="missing"
locator_file="${locator%%#*}"
if [ -n "$locator_file" ] && [ -f "$root/$locator_file" ]; then
  marker_line=$(grep -nE "$node_re" "$root/$locator_file" 2>/dev/null | head -1 || true)
  [ -n "$marker_line" ] && marker_file="$locator_file"
fi
if [ -z "$marker_file" ]; then
  marker_line=$(git -C "$root" grep -nE "$node_re" \
    -- '*.md' '*.ts' '*.tsx' '*.js' '*.jsx' '*.swift' '*.py' '*.rs' '*.go' \
    '*.c' '*.cc' '*.cpp' '*.h' '*.hpp' '*.m' '*.mm' '*.java' '*.kt' '*.rb' \
    '*.sh' '*.css' '*.scss' '*.vue' '*.svelte' 2>/dev/null | head -1 || true)
  if [ -z "$marker_line" ]; then
    marker_line=$(grep -rnE "$node_re" "$root/docs" 2>/dev/null | head -1 || true)
  fi
  if [ -n "$marker_line" ]; then
    marker_file="${marker_line%%:*}"
    marker_file="${marker_file#"$root"/}"
  fi
fi
if [ -n "$marker_line" ]; then
  marker_state=$(printf '%s' "$marker_line" | sed -n 's/.*- \[\([^]]*\)\].*/\1/p')
  [ -n "$marker_state" ] || marker_state="no-checkbox"
fi

# off-line anchor fallback: `^id` が node 行に無い時、行末 anchor を含む node
# block を indent で辿り、その node の checkbox を parity に読む。codec はこの
# 形を block anchor (identity_only) と見る — 正しい置き場は node 行末なので、
# 解決できても placement defect として friction 側へ残す。
anchor_off=""
if [ -z "$marker_file" ]; then
  anchor_re="[[:space:]]\^$task_id[[:space:]]*\$"
  anchor_files=$(
    {
      if [ -n "$locator_file" ] && [ -f "$root/$locator_file" ]; then
        printf '%s\n' "$locator_file"
      fi
      git -C "$root" grep -lE "$anchor_re" \
        -- '*.md' '*.ts' '*.tsx' '*.js' '*.jsx' '*.swift' '*.py' '*.rs' '*.go' \
        '*.c' '*.cc' '*.cpp' '*.h' '*.hpp' '*.m' '*.mm' '*.java' '*.kt' '*.rb' \
        '*.sh' '*.css' '*.scss' '*.vue' '*.svelte' 2>/dev/null || true
      if [ -d "$root/docs" ]; then
        (cd "$root" && grep -rlE "$anchor_re" docs 2>/dev/null) || true
      fi
    } | awk 'NF && !seen[$0]++'
  )
  if [ -n "$anchor_files" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      hit=$(python3 - "$root/$f" "$task_id" <<'PY_RESOLVER'
import re, sys
path, tid = sys.argv[1], sys.argv[2]
anchor_re = re.compile(r"[ \t]\^" + re.escape(tid) + r"[ \t]*$")
task_re = re.compile(r"^[ \t]*(?:<!--|//|/\*|#|\*|--)?[ \t]*- \[([^\]]*)\]")
fence_re = re.compile(r"^[ \t]{0,3}(" + chr(96) + r"{3,}|~{3,})")
try:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
except OSError:
    sys.exit(0)
indents, tasks, anchors = [], {}, []
in_fm = False
fence = None
for i, text in enumerate(lines):
    s = text.lstrip(" \t")
    indents.append(len(text) - len(s))
    if i == 0 and s == "---":
        in_fm = True
        continue
    if in_fm:
        if s == "---":
            in_fm = False
        continue
    m = fence_re.match(text)
    if m is not None:
        marker = m.group(1)
        rest = s[len(marker):]
        if fence is None:
            # backtick fence の info string は backtick を含められない (CommonMark)。
            # chr(96) = ` — この python は $( ) 内 heredoc なので literal backtick は書けない。
            if marker[0] == "~" or chr(96) not in rest:
                fence = (marker[0], len(marker))
                continue
        elif marker[0] == fence[0] and len(marker) >= fence[1] and rest.strip() == "":
            fence = None
            continue
    if fence is not None:
        continue
    tm = task_re.match(text)
    if tm is not None:
        tasks[i] = tm.group(1)
    if anchor_re.search(text):
        anchors.append(i)
for a in anchors:
    if a in tasks:
        print("%d\t%d\t%s" % (a + 1, a + 1, tasks[a]))
        sys.exit(0)
    cur = indents[a]
    for j in range(a - 1, -1, -1):
        if not lines[j].strip() or indents[j] >= cur:
            continue
        if j in tasks:
            print("%d\t%d\t%s" % (a + 1, j + 1, tasks[j]))
            sys.exit(0)
        cur = indents[j]
sys.exit(0)
PY_RESOLVER
) || true
      if [ -n "$hit" ]; then
        a_line=${hit%%$'\t'*}; rest=${hit#*$'\t'}
        n_line=${rest%%$'\t'*}; marker_state=${rest#*$'\t'}
        marker_file="$f"
        [ "$a_line" != "$n_line" ] && anchor_off="$f:$a_line"
        break
      fi
    done <<EOF_ANCHOR_FILES
$anchor_files
EOF_ANCHOR_FILES
  fi
fi

# --- change window + residue ------------------------------------------------
n_commits=0; files_touched=0; window_files=""
if [ -n "$completed_at" ]; then
  n_commits=$(git -C "$root" log --since="$created_at" --until="$completed_at" \
    --format='%H' 2>/dev/null | wc -l | tr -d ' ' || true)
  window_files=$(git -C "$root" log --since="$created_at" --until="$completed_at" \
    --name-only --format='' 2>/dev/null | sort -u || true)
  files_touched=$(printf '%s\n' "$window_files" | grep -c . || true)
fi
# uncommitted residue at report time (repo-wide; v4 attributes neither commits
# nor dirty state to a task, so this is an upper-bound flag, not attribution).
# Structural noise is subtracted before counting so the flag means task dirt:
# task-own paths (change-window files + the marker doc) are exact-match
# subtracted, then grep -E exclusions are applied (see header).
residue_paths=$(git -C "$root" status --porcelain -uall 2>/dev/null \
  | sed 's/^...//; s/^"//; s/"$//' | awk 'NF' || true)
own_paths=$(
  {
    if [ -n "$marker_file" ]; then printf '%s\n' "$marker_file"; fi
    printf '%s\n' "$window_files"
  } | awk 'NF' | sort -u
)
if [ -n "$own_paths" ]; then
  residue_n_all=$(printf '%s\n' "$residue_paths" | grep -c . || true)
  residue_paths=$(printf '%s\n' "$residue_paths" \
    | grep -vxF -f <(printf '%s\n' "$own_paths") || true)
  own_n=$((residue_n_all - $(printf '%s\n' "$residue_paths" | grep -c . || true)))
else
  own_n=0
fi
excl_patterns=$(
  for ef in "$root/.workflow/retro-residue.exclude" \
            "$root/.workflow.nosync/retro/residue.exclude"; do
    if [ -f "$ef" ]; then cat "$ef"; fi
  done
  if [ -n "${WF4_RETRO_RESIDUE_EXCLUDE:-}" ]; then
    printf '%s\n' "$WF4_RETRO_RESIDUE_EXCLUDE"
  fi
)
excl_patterns=$(printf '%s\n' "$excl_patterns" \
  | sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' || true)
if [ -n "$excl_patterns" ]; then
  residue_n_pre=$(printf '%s\n' "$residue_paths" | grep -c . || true)
  residue_paths=$(printf '%s\n' "$residue_paths" \
    | grep -vE -f <(printf '%s\n' "$excl_patterns") || true)
  excl_n=$((residue_n_pre - $(printf '%s\n' "$residue_paths" | grep -c . || true)))
else
  excl_n=0
fi
residue_n=$(printf '%s\n' "$residue_paths" | grep -c . || true)

# --- session + transcript (best-effort) -------------------------------------
# Source: session.attach activity rows — doit appends one right after
# task.start_doing applies; done appends one as fallback for tasks whose
# doit attach never landed. Earliest row wins: the doer, not a later
# completer, owns the transcript.
# The wishboard relay links / v3 activity fallback was removed 2026-09-24 when
# .wishboard/cache and docs/activity were physically deleted from wishboard.
session_id=""; session_agent=""; session_pane=""
session_row=$(sqlite3 "$db" \
  "SELECT detail_json FROM activities
    WHERE component_id='$task_id' AND activity_type='session.attach'
    ORDER BY created_at ASC LIMIT 1" 2>/dev/null || true)
if [ -n "$session_row" ]; then
  eval "$(printf '%s' "$session_row" | python3 -c '
import json,sys
try: d=json.loads(sys.stdin.read()) or {}
except Exception: d={}
print("session_id=%r" % (d.get("session_id") or ""))
print("session_agent=%r" % (d.get("agent") or ""))
print("session_pane=%r" % (d.get("pane") or ""))' 2>/dev/null || true)"
fi
# Fallback: no attach row at all (task closed before auto-attach, or doit/done
# ran outside wf4.sh). Resolve the calling pane the way wf4.sh does. The
# canonical --write caller is the done flow, so this IS the task.done session;
# the (done-time) tag marks that provenance — on a manual dry-run of an old
# task it is the reporting session, never silently the doer's. Partial attach
# rows are NOT filled: a completer's session_id must not overwrite the doer's
# absent one. Resolution failure leaves the fields empty -> "? ? unrecorded".
session_via=""
if [ -z "$session_row" ]; then
  herdr_bin=""
  if command -v herdr >/dev/null 2>&1; then
    herdr_bin="herdr"
  elif [ -n "${HERDR_BIN_PATH:-}" ] && [ -x "$HERDR_BIN_PATH" ]; then
    herdr_bin="$HERDR_BIN_PATH"
  elif [ -x "$HOME/.local/bin/herdr" ]; then
    herdr_bin="$HOME/.local/bin/herdr"
  fi
  if [ -n "$herdr_bin" ]; then
    eval "$("$herdr_bin" pane current 2>/dev/null | python3 -c '
import json,sys
try: p=(json.load(sys.stdin).get("result") or {}).get("pane") or {}
except Exception: p={}
sid=(p.get("agent_session") or {}).get("value")
print("session_id=%r" % (sid if isinstance(sid,str) else ""))
print("session_agent=%r" % (p.get("agent") if isinstance(p.get("agent"),str) else ""))
print("session_pane=%r" % (p.get("pane_id") if isinstance(p.get("pane_id"),str) else ""))' 2>/dev/null || true)"
    [ -n "$session_pane$session_agent$session_id" ] && session_via="done-time"
  fi
fi
tr_stats="unavailable"
if [ -n "$session_id" ]; then
  tr_file=$(find "$HOME/.claude/projects" "$HOME/.codex/sessions" \
    -name "*$session_id*" -type f 2>/dev/null | head -1 || true)
  if [ -n "$tr_file" ]; then
    tr_stats=$(python3 - "$tr_file" <<'PY' 2>/dev/null || echo "unavailable"
import json, sys
path = sys.argv[1]
size = 0; lines = 0; big = 0
with open(path, "rb") as fh:
    for raw in fh:
        lines += 1; size += len(raw)
        if len(raw) > 64 * 1024:
            big += 1
print(f"{size/1024:.0f} KB, {lines} events, {big} tool outputs >64 KB")
PY
)
  fi
  # Devin keeps transcripts in a sqlite db, not session files. Read-only URI;
  # missing db / unknown session / unreadable db all degrade to "unavailable".
  # session_id is sanitized before interpolation (diagnostic query only).
  if [ "$tr_stats" = "unavailable" ]; then
    case "$session_id" in
      *[!A-Za-z0-9._-]*) ;;
      *)
        sdb="$HOME/.local/share/devin/cli/sessions.db"
        if [ -f "$sdb" ]; then
          devin_stats=$(sqlite3 "file:$sdb?mode=ro" \
            "SELECT COUNT(m.node_id), COALESCE(SUM(LENGTH(m.chat_message)),0),
                    COALESCE(SUM(LENGTH(m.chat_message) > 65536),0)
               FROM sessions s LEFT JOIN message_nodes m ON m.session_id = s.id
              WHERE s.id = '$session_id'" 2>/dev/null || true)
          if [ -n "$devin_stats" ]; then
            tr_stats=$(printf '%s' "$devin_stats" | python3 -c '
import sys
parts = sys.stdin.read().strip().split("|")
if len(parts) != 3:
    print("unavailable")
else:
    n, size, big = int(parts[0]), int(parts[1]), int(parts[2])
    if n == 0 and size == 0:
        print("unavailable")
    else:
        print(f"{size/1024:.0f} KB, {n} events, {big} messages >64 KB")' 2>/dev/null || echo "unavailable")
          fi
        fi
        ;;
    esac
  fi
fi

# --- report -----------------------------------------------------------------
report=$(
echo "== wf4 retro: $task_id"
echo "title: ${title:-(untitled)}"
echo "status: $status (rev $rev)  window: ${created_at:-?} -> ${completed_at:-open}"
echo "verification: ${verification:-(none recorded)}"
echo
echo "went well:"
if [ "$chain_ok" = 1 ] && [ -z "$bad_ops" ]; then
  echo "  op chain applied clean (ready/doing/done present, no anomalies)"
else
  echo "  (none detected)"
fi
echo "wasted / friction:"
[ -n "$bad_ops" ] && printf '%s\n' "$bad_ops" | sed 's/^/  non-applied op: /' || true
[ "$chain_ok" = 0 ] && echo "  op chain incomplete: create=$have_create ready=$have_ready doing=$have_doing done=$have_done"
if [ "$marker_state" != "done" ]; then
  echo "  marker parity: doc shows [$marker_state] vs DB status=$status (${marker_file:-no anchor file})"
fi
if [ -n "$anchor_off" ]; then
  echo "  anchor off node line at $anchor_off — marker read from the containing node; ^$task_id belongs at the end of the checkbox line"
fi
if [ "$residue_n" -gt 0 ]; then
  echo "  uncommitted residue at report time: $residue_n path(s)"
fi
echo "marker: [$marker_state] (${marker_file:-no anchor file})"
echo "change window: $n_commits commits, $files_touched files"
suppressed=""
if [ "$own_n" -gt 0 ] || [ "$excl_n" -gt 0 ]; then
  suppressed=" (task-own/excluded suppressed: $own_n/$excl_n)"
fi
echo "residue: $residue_n dirty path(s)${residue_paths:+: $(printf '%s\n' "$residue_paths" | head -8 | tr '\n' ' ')}$suppressed"
echo "session: ${session_pane:-?} ${session_agent:-?} ${session_id:-unrecorded}${session_via:+ ($session_via)}"
echo "transcript: $tr_stats"
echo "change candidate:"
echo "  (fill in during aggregate pass — journal holds the record)"
)
printf '%s\n' "$report"

if [ "$write" = 1 ]; then
  case "$status" in
    done|dropped) ;;
    *)
      echo "wf4-retro: $task_id status=$status is not terminal — journal skipped" >&2
      exit 1
      ;;
  esac
  journal_root="$root/.workflow.nosync/retro/journal"
  # one journal per task x state_revision: a re-run of done/retro on an
  # unchanged task must not emit a second record. New journals carry a
  # `state_revision:` header; pre-fix journals only have `(rev N)` on the
  # status line — match both so old journals still dedupe.
  dup=$(find "$journal_root" -type f -name "*-${task_id}*.md" \
    -exec grep -lE "^state_revision: $rev\$|[(]rev $rev[)]" {} + 2>/dev/null \
    | head -1 || true)
  if [ -n "$dup" ]; then
    echo "journal: $dup (already recorded at rev $rev — skipped)"
    exit 0
  fi
  out_dir="$journal_root/$(date +%Y/%m/%d)"
  mkdir -p "$out_dir"
  out="$out_dir/$(date +%Y%m%dT%H%M%S)-$task_id.md"
  {
    echo "# retro $task_id"
    echo "state_revision: $rev"
    echo
    printf '%s\n' "$report"
  } > "$out"
  echo "journal: $out"
fi
