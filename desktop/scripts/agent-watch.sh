#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

require_cmd tmux

PREFIX="${1:-mj-}"

print_agent_paths
echo
echo "== git status =="
git -C "$ROOT_DIR" status --short --branch
echo
echo "== tmux sessions matching '$PREFIX' =="
tmux list-sessions 2>/dev/null | grep "$PREFIX" || true
echo
echo "== recent output files =="
find "$AGENT_OUTPUT_DIR" -maxdepth 1 -type f -name "${PREFIX}*.txt" -print 2>/dev/null | sort | tail -n 20 || true
