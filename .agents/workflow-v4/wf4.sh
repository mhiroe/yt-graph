#!/usr/bin/env bash
# Thin driver for the vendored Workflow Core under .agents/workflow-v4/.
# Skills reach the Core only through this script.
#
# usage:
#   wf4.sh provision <repository-id>   write .workflow/repository.json and create the
#                                      device-local DB under .workflow.nosync/
#   wf4.sh revision <component_id>     print the component's CURRENT state_revision —
#                                      a fresh read through `cli` read ops. done runs
#                                      this right before task.complete so a stale
#                                      handoff revision does not surface as conflict
#   wf4.sh '<request-json>'            run a skill.phase / wish.complete /
#                                      wish.transition request via
#                                      src/harness/skill_entry.ts (adds --allow-run).
#                                      doit requests without a `session` get the
#                                      calling herdr pane injected best-effort so
#                                      session.attach is recorded for retro
#                                      transcript resolution.
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

# One request through src/cli/main.ts. stdout carries the single JSON response
# line; diagnostics stay on stderr; the exit code is the CLI's.
run_cli() {
  local repo_id
  repo_id=$(repository_id)
  # --allow-run: iteration.repair の first-commit reconstruction が git log を
  # spawn する (port 未注入環境では従来どおり fail closed)。
  # Replace this shell with Core so bounded callers can terminate the whole
  # request without leaving a grandchild process behind. In command
  # substitutions/pipelines the function already runs in a subshell.
  exec deno run --allow-read --allow-write --allow-ffi --allow-env --allow-run \
    "$runtime_dir/src/cli/main.ts" \
    --repository-id "$repo_id" --device-id "$device" \
    --db "$db" --root "$root" \
    --request "$1"
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
    run_cli "$request"
    ;;
  revision)
    component_id="${2:-}"
    if [ -z "$component_id" ]; then
      echo "usage: wf4.sh revision <component_id>" >&2
      exit 2
    fi
    command -v python3 >/dev/null 2>&1 || {
      echo "wf4 revision: python3 is required" >&2
      exit 1
    }
    # The current state_revision is the newest applied operation's resulting
    # revision: operation.list (newest first, target-side) -> get_receipt ->
    # state_revision. Creation ops (component.register / task.create_planned)
    # record the new component as the RESULT, not the target, so a component
    # with no applied op targeting it is still at revision 0.
    op_id=$(run_cli \
      "{\"kind\":\"operation.list\",\"component_id\":\"$component_id\",\"limit\":500}" \
      | python3 -c '
import json, sys
resp = json.load(sys.stdin)
if not resp.get("ok"):
    sys.stderr.write("wf4 revision: operation.list failed: %s\n" % (resp.get("error") or resp))
    sys.exit(1)
for op in (resp.get("result") or {}).get("operations") or []:
    if op.get("disposition") == "applied":
        sys.stdout.write(op["operation_id"] + "\n")
        break
') || exit 1
    if [ -z "$op_id" ]; then
      echo 0
      exit 0
    fi
    run_cli "{\"kind\":\"operation.get_receipt\",\"operation_id\":\"$op_id\"}" \
      | python3 -c '
import json, sys
resp = json.load(sys.stdin)
if not resp.get("ok"):
    sys.stderr.write("wf4 revision: operation.get_receipt failed: %s\n" % (resp.get("error") or resp))
    sys.exit(1)
rev = (resp.get("result") or {}).get("state_revision")
if rev is None:
    sys.stderr.write("wf4 revision: applied receipt carries no state_revision\n")
    sys.exit(1)
sys.stdout.write("%s\n" % rev)
' || exit 1
    ;;
  *)
    request="${1:-}"
    if [ -z "$request" ]; then
      echo "usage: wf4.sh provision <repository-id> | wf4.sh revision <component_id> | wf4.sh '<request-json>' | wf4.sh cli '<request-json>'" >&2
      exit 2
    fi
    # Best-effort session attach: a doit/done request without an explicit
    # `session` gets the calling herdr pane injected so the runtime appends
    # the `session.attach` activity (the retrospective's transcript link).
    # done covers tasks whose doit attach was skipped — e.g. a start_doing
    # resubmit after minting the ^t- anchor halts the original doit plan
    # before its attach command. A caller-supplied `session` is never
    # overridden; outside herdr (or on any resolution failure) the request
    # passes through unchanged.
    if command -v python3 >/dev/null 2>&1; then
      herdr_bin=""
      if command -v herdr >/dev/null 2>&1; then
        herdr_bin="herdr"
      elif [ -n "${HERDR_BIN_PATH:-}" ] && [ -x "$HERDR_BIN_PATH" ]; then
        herdr_bin="$HERDR_BIN_PATH"
      elif [ -x "$HOME/.local/bin/herdr" ]; then
        herdr_bin="$HOME/.local/bin/herdr"
      fi
      if [ -n "$herdr_bin" ]; then
        pane_json=$("$herdr_bin" pane current 2>/dev/null || true)
        if [ -n "$pane_json" ]; then
          request=$(printf '%s' "$pane_json" | WF4_REQUEST="$request" python3 -c '
import json, os, sys
req_raw = os.environ["WF4_REQUEST"]
try:
    req = json.loads(req_raw)
    pane = json.load(sys.stdin)
except Exception:
    sys.stdout.write(req_raw)
    sys.exit(0)
if req.get("kind") == "skill.phase" and req.get("phase") in ("doit", "done"):
    sess = req.get("session")
    if sess is None:
        sess = {}
    if isinstance(sess, dict):
        p = (pane.get("result") or {}).get("pane") or {}
        sid = (p.get("agent_session") or {}).get("value")
        if isinstance(p.get("pane_id"), str):
            sess.setdefault("pane", p["pane_id"])
        if isinstance(p.get("agent"), str):
            sess.setdefault("agent", p["agent"])
        if isinstance(sid, str) and sid:
            sess.setdefault("session_id", sid)
        if sess:
            req["session"] = sess
sys.stdout.write(json.dumps(req))
' 2>/dev/null || printf '%s' "$request")
        fi
      fi
    fi
    repo_id=$(repository_id)
    exec deno run --allow-read --allow-write --allow-ffi --allow-env --allow-run \
      "$runtime_dir/src/harness/skill_entry.ts" \
      --repository-id "$repo_id" --device-id "$device" \
      --db "$db" --root "$root" \
      --request "$request"
    ;;
esac
