#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/agent-send-input.sh SESSION MESSAGE...
  scripts/agent-send-input.sh SESSION - < message.txt

Paste a prompt into an existing tmux session, press Enter, and show the recent
pane output so the caller can verify the agent started processing it.
USAGE
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

require_cmd tmux

SESSION="$1"
shift

if ! agent_session_exists "$SESSION"; then
  echo "tmux session not found: $SESSION" >&2
  exit 1
fi

if [[ "$1" == "-" ]]; then
  MESSAGE="$(cat)"
else
  MESSAGE="$*"
fi

if [[ -z "${MESSAGE//[[:space:]]/}" ]]; then
  echo "message is empty" >&2
  exit 2
fi

# Use tmux's paste buffer rather than send-keys for the body. Long prompts sent
# as key sequences can land in Codex's paste UI without being submitted.
BUFFER_NAME="agent-send-input-$$"
printf '%s' "$MESSAGE" | tmux load-buffer -b "$BUFFER_NAME" -
tmux paste-buffer -d -b "$BUFFER_NAME" -t "$SESSION"
tmux send-keys -t "$SESSION" Enter

sleep "${MJ_AGENT_SEND_CONFIRM_DELAY_SECONDS:-2}"

echo "== recent pane output: $SESSION =="
tmux capture-pane -pt "$SESSION" -S -30
