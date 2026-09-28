#!/usr/bin/env bash
# Thin driver for the vendored Workflow Core under .agents/workflow-v4/.
# Skills reach the Core only through this script.
#
# usage:
#   wf4.sh provision <repository-id>   write .workflow/repository.json and create the
#                                      device-local DB under .workflow.nosync/
#   wf4.sh '<request-json>'            run a skill.phase / wish.complete request via
#                                      src/harness/skill_entry.ts (adds --allow-run)
#   wf4.sh cli '<request-json>'        run a raw src/cli/main.ts request (read ops etc.)
#
# root:   $WF4_ROOT, else `git rev-parse --show-toplevel`, else pwd
# device: $WF4_DEVICE_ID, else hostname
# db:     <root>/.workflow.nosync/workflow.sqlite
set -euo pipefail

root="${WF4_ROOT:-}"
if [ -z "$root" ]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi
device="${WF4_DEVICE_ID:-$(hostname)}"
runtime_dir="$root/.agents/workflow-v4"
db="$root/.workflow.nosync/workflow.sqlite"
manifest="$root/.workflow/repository.json"

repository_id() {
  if [ ! -f "$manifest" ]; then
    echo "wf4: $manifest is missing; run 'wf4.sh provision <repository-id>' first" >&2
    exit 1
  fi
  local id
  if command -v python3 >/dev/null 2>&1; then
    id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repository_id"])' "$manifest")
  else
    id=$(sed -n 's/.*"repository_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)
  fi
  if [ -z "$id" ]; then
    echo "wf4: could not read repository_id from $manifest" >&2
    exit 1
  fi
  printf '%s\n' "$id"
}

case "${1:-}" in
  provision)
    repo_id="${2:-}"
    if [ -z "$repo_id" ]; then
      echo "usage: wf4.sh provision <repository-id>" >&2
      exit 2
    fi
    exec deno run --allow-read --allow-write --allow-ffi --allow-env \
      "$runtime_dir/src/cli/main.ts" \
      --repository-id "$repo_id" --device-id "$device" \
      --db "$db" --root "$root" \
      --request '{"kind":"repository.provision"}'
    ;;
  cli)
    request="${2:-}"
    if [ -z "$request" ]; then
      echo "usage: wf4.sh cli '<request-json>'" >&2
      exit 2
    fi
    repo_id=$(repository_id)
    exec deno run --allow-read --allow-write --allow-ffi --allow-env \
      "$runtime_dir/src/cli/main.ts" \
      --repository-id "$repo_id" --device-id "$device" \
      --db "$db" --root "$root" \
      --request "$request"
    ;;
  *)
    request="${1:-}"
    if [ -z "$request" ]; then
      echo "usage: wf4.sh provision <repository-id> | wf4.sh '<request-json>' | wf4.sh cli '<request-json>'" >&2
      exit 2
    fi
    repo_id=$(repository_id)
    exec deno run --allow-read --allow-write --allow-ffi --allow-env --allow-run \
      "$runtime_dir/src/harness/skill_entry.ts" \
      --repository-id "$repo_id" --device-id "$device" \
      --db "$db" --root "$root" \
      --request "$request"
    ;;
esac
