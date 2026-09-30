#!/usr/bin/env bash
# wf4-retro-scan — collect retrospective journals across workflow v4 repos.
#
# usage: wf4-retro-scan.sh scan [--limit N|--all] [repo_root ...]
#        wf4-retro-scan.sh poll [--replay]
#        wf4-retro-scan.sh watch <pm_pane> [interval_sec]
#
# scan   prints one compact line per journal plus per-repo signal counts.
# poll   prints journals that appeared since the last poll (state file) and
#        exits — the dry half of watch.
# watch  polls every interval_sec and pushes each new journal to the
#        monitoring PM pane via `herdr agent prompt` (debug-mode real-time
#        pickup; periodic analysis runs scan / --aggregate instead).
#
# Repo discovery: <scan_root>/*/ with .agents/workflow.toml declaring
# `version = 4`. scan_root defaults to $WF4_RETRO_SCAN_ROOT or ~/Documents.
# Explicit repo_root args are added on top. Journal emission is
# unconditional (gm.md:1142) — every discovered v4 repo is scanned; the old
# retrospective flag machinery is gone.
#
# State file for poll/watch: .workflow.nosync/retro/.scan-seen under the
# invoking repo root (WF4_ROOT / git toplevel / cwd); first poll seeds the
# seen set without reporting.
set -euo pipefail

herdr=/Users/m/.local/bin/herdr
scan_root="${WF4_RETRO_SCAN_ROOT:-$HOME/Documents}"
big_trans_kb=2048

die() { echo "wf4-retro-scan: $*" >&2; exit 2; }

discover_repos() {
  local d
  for d in "$scan_root"/*/; do
    [ -f "$d.agents/workflow.toml" ] || continue
    grep -Eq '^[[:space:]]*version[[:space:]]*=[[:space:]]*4' "$d.agents/workflow.toml" || continue
    printf '%s\n' "${d%/}"
  done
}

journals_of() { # repo -> sorted journal paths; missing dir -> empty
  find "$1/.workflow.nosync/retro/journal" -name '*.md' -type f 2>/dev/null | sort || true
}

# --- one-line signal extraction from a journal file --------------------------
# Fills globals: j_tid j_title j_marker j_residue j_transcript j_flags
journal_fields() {
  local f=$1 line
  j_tid=$(sed -n 's/^# retro //p' "$f" | head -1)
  [ -n "$j_tid" ] || j_tid=$(basename "$f" .md | sed -n 's/.*-\(t-[A-Z0-9]*\)$/\1/p')
  j_title=$(sed -n 's/^title: //p' "$f" | head -1)
  # journals from before the full-report format use `- key:` lines and lack
  # title/verification/session/residue — flag OLD-FMT and skip per-field checks
  j_marker=$(sed -n 's/^[- ]*marker: \[\([^]]*\)\].*/\1/p' "$f" | head -1)
  j_transcript=$(sed -n 's/^[- ]*transcript: //p' "$f" | head -1)
  j_flags=""
  add_flag() { j_flags="${j_flags:+$j_flags,}$1"; }
  local status
  status=$(sed -n 's/^[- ]*status: \([a-z]*\).*/\1/p' "$f" | head -1)
  if grep -q '^- status:' "$f"; then
    add_flag OLD-FMT
    [ "$status" = "done" ] && [ -n "$j_marker" ] && [ "$j_marker" != "done" ] && add_flag PARITY
    j_residue=""; return 0
  fi
  j_residue=$(sed -n 's/^residue: \([0-9]*\).*/\1/p' "$f" | head -1)
  local verif session tr_kb tr_big friction
  verif=$(sed -n 's/^verification: //p' "$f" | head -1)
  session=$(sed -n 's/^session: //p' "$f" | head -1)
  friction=$(awk '/^wasted \/ friction:/{f=1;next} /^marker:/{f=0} f&&/^  /' "$f")
  tr_kb=$(printf '%s' "$j_transcript" | sed -n 's/^\([0-9][0-9]*\) KB.*/\1/p')
  tr_big=$(printf '%s' "$j_transcript" | grep -oE '[0-9]+ [a-z ]*>64 KB' | grep -oE '^[0-9]+' || true)
  [ "$status" != "done" ] && add_flag OPEN
  printf '%s\n' "$friction" | grep -q 'marker parity:' && add_flag PARITY
  [ "$j_marker" = "missing" ] && add_flag NO-MARKER
  printf '%s\n' "$friction" | grep -qE 'non-applied op|op chain incomplete' && add_flag CHAIN
  case "$verif" in ""|"(none recorded)"|"(none)") add_flag NO-VERIFY ;; esac
  [ "${j_residue:-0}" -gt 0 ] && add_flag RESIDUE
  if printf '%s' "$session" | grep -q unrecorded; then
    add_flag NO-SESS
  elif [ "$j_transcript" = "unavailable" ] || [ -z "$j_transcript" ]; then
    add_flag NO-TRANS
  fi
  if [ "${tr_kb:-0}" -ge "$big_trans_kb" ] || [ "${tr_big:-0}" -gt 0 ]; then
    add_flag BIG-TRANS
  fi
  # friction lines the named flags did not claim still surface
  printf '%s\n' "$friction" | grep -vqE 'marker parity:|non-applied op|op chain incomplete|uncommitted residue' \
    && [ -n "$(printf '%s\n' "$friction" | grep .)" ] && add_flag FRICTION
  return 0
}

mode="${1:-scan}"
case "$mode" in scan|poll|watch) ;; *) die "unknown mode: $mode" ;; esac
shift || true

# watch takes its positional args first so the option loop below cannot eat them
pane=""; interval=20
if [ "$mode" = "watch" ]; then
  pane="${1:-}"; interval="${2:-20}"
  [ -n "$pane" ] || die "watch needs a pm pane id"
  shift $(( $# >= 2 ? 2 : $# ))
fi

# --- repo list: discovered + explicit args ----------------------------------
extra_roots=()
limit=0 # 0 = all
while [ $# -gt 0 ]; do
  case "$1" in
    --all) limit=0 ;;
    --limit) shift; limit="${1:-0}" ;;
    --replay) replay=1 ;;
    -*) die "unknown option: $1" ;;
    *) extra_roots+=("$1") ;;
  esac
  shift
done

repos=$( { discover_repos; printf '%s\n' "${extra_roots[@]:-}" | grep . || true; } | sort -u )

# --- watch / poll ------------------------------------------------------------
state_dir_root="${WF4_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
state_file="${WF4_RETRO_SCAN_STATE:-$state_dir_root/.workflow.nosync/retro/.scan-seen}"

new_journals() { # prints "repo|journal_path" for every discovered repo
  local repo
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    journals_of "$repo" | sed "s|^|$repo\||"
  done <<EOF_REPOS
$repos
EOF_REPOS
}

if [ "$mode" = "poll" ] || [ "$mode" = "watch" ]; then
  mkdir -p "$(dirname "$state_file")"
  touch "$state_file"
  current=$(new_journals | sort)
  if [ ! -s "$state_file" ] && [ "${replay:-0}" != 1 ]; then
    printf '%s\n' "$current" > "$state_file"
    n=$(printf '%s\n' "$current" | grep -c . || true)
    echo "poll: seeded $n known journal(s); reporting only new arrivals"
    [ "$mode" = "poll" ] && exit 0
  fi
fi

if [ "$mode" = "poll" ]; then
  printf '%s\n' "$current" | comm -13 "$state_file" - | while IFS='|' read -r repo jf; do
    [ -n "$jf" ] && echo "new ${repo##*/} $jf"
  done
  printf '%s\n' "$current" > "$state_file"
  exit 0
fi

if [ "$mode" = "watch" ]; then
  echo "watch: pane=$pane interval=${interval}s state=$state_file"
  while :; do
    sleep "$interval"
    current=$(new_journals | sort)
    printf '%s\n' "$current" > "$state_file.new"
    comm -13 "$state_file" "$state_file.new" | while IFS='|' read -r repo jf; do
      [ -n "$jf" ] || continue
      echo "new ${repo##*/} $jf"
      "$herdr" --session default agent prompt "$pane" \
        "retro: new journal ${repo##*/} $jf — analyze with the retro skill and report findings" \
        >/dev/null 2>&1 || echo "watch: herdr prompt failed for $jf"
    done
    mv "$state_file.new" "$state_file"
  done
fi

# --- scan --------------------------------------------------------------------
printf '%s\n' "$repos" | while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  name=${repo##*/}
  js=$(journals_of "$repo")
  n=$(printf '%s\n' "$js" | grep -c . || true)
  echo "== $name  journals=$n"
  [ -n "$js" ] || continue
  if [ "$limit" -gt 0 ]; then
    js=$(printf '%s\n' "$js" | tail -"$limit")
  fi
  lines=$(printf '%s\n' "$js" | while IFS= read -r jf; do
    [ -n "$jf" ] || continue
    journal_fields "$jf"
    tr_show=$j_transcript
    [ -n "$tr_show" ] || tr_show=?
    printf '  %-14s %-42s res=%s tr=%s marker=%s %s\n' \
      "$j_tid" "${j_flags:-ok}" "${j_residue:-0}" "$tr_show" "${j_marker:-?}" \
      "$(printf '%.60s' "$j_title")"
  done)
  printf '%s\n' "$lines"
  sig=$(printf '%s\n' "$lines" | awk '{print $2}' | tr ',' '\n' \
    | grep -v '^ok$' | grep . | sort | uniq -c \
    | awk '{printf "%s=%s ", $2, $1}' || true)
  echo "  signals: ${sig:-none}"
done
