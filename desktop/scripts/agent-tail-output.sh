#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 SESSION [LINES]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

require_cmd tmux

SESSION="$1"
LINES="${2:-160}"
OUTPUT_FILE="$(agent_output_path "$SESSION")"

if [[ -f "$OUTPUT_FILE" ]]; then
  echo "== output: $OUTPUT_FILE =="
  tail -n "$LINES" "$OUTPUT_FILE"
else
  echo "output not found yet: $OUTPUT_FILE"
fi

if agent_session_exists "$SESSION"; then
  echo
  echo "== tmux pane: $SESSION =="
  tmux capture-pane -pt "$SESSION" -S "-$LINES"
else
  echo
  echo "tmux session is not running: $SESSION"
fi
