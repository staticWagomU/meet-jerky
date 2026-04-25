#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 [WATCHDOG_SESSION] [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS]" >&2
  echo "starts agent-watchdog.sh in a tmux session" >&2
}

if [[ $# -gt 4 ]]; then
  usage
  exit 2
fi

require_cmd tmux

WATCHDOG_SESSION="${1:-mj-watchdog}"
MAIN_SESSION="${2:-mj-main}"
PROMPT_FILE="${3:-$ROOT_DIR/docs/autonomous-main-prompt.md}"
INTERVAL_SECONDS="${4:-600}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi
if [[ "$PROMPT_FILE" != /* ]]; then
  PROMPT_FILE="$PWD/$PROMPT_FILE"
fi

if agent_session_exists "$WATCHDOG_SESSION"; then
  echo "watchdog tmux session already exists: $WATCHDOG_SESSION" >&2
  exit 1
fi

tmux new-session -d -s "$WATCHDOG_SESSION" \
  "cd \"$ROOT_DIR\" && PATH=\"$AGENT_PATH\" \"$ROOT_DIR/scripts/agent-watchdog.sh\" \"$MAIN_SESSION\" \"$PROMPT_FILE\" \"$INTERVAL_SECONDS\""

echo "started watchdog session: $WATCHDOG_SESSION"
echo "main session: $MAIN_SESSION"
echo "prompt: $PROMPT_FILE"
echo "interval: ${INTERVAL_SECONDS}s"
echo "log: $AGENT_OUTPUT_DIR/watchdog.log"
