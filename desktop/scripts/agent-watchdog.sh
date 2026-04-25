#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS]" >&2
  echo "restarts the main Codex tmux session when it is missing" >&2
}

if [[ $# -gt 3 ]]; then
  usage
  exit 2
fi

require_cmd tmux

MAIN_SESSION="${1:-mj-main}"
PROMPT_FILE="${2:-$ROOT_DIR/docs/autonomous-main-prompt.md}"
INTERVAL_SECONDS="${3:-600}"
WATCHDOG_LOG="${MJ_WATCHDOG_LOG:-$AGENT_OUTPUT_DIR/watchdog.log}"

if [[ ! "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 10 ]]; then
  echo "interval must be an integer >= 10 seconds: $INTERVAL_SECONDS" >&2
  exit 2
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi
if [[ "$PROMPT_FILE" != /* ]]; then
  PROMPT_FILE="$PWD/$PROMPT_FILE"
fi

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$WATCHDOG_LOG"
}

log "watchdog started: main=$MAIN_SESSION prompt=$PROMPT_FILE interval=${INTERVAL_SECONDS}s"

while true; do
  if agent_session_exists "$MAIN_SESSION"; then
    log "main session alive: $MAIN_SESSION"
  else
    log "main session missing; starting: $MAIN_SESSION"
    if "$ROOT_DIR/scripts/agent-handoff-main.sh" "$MAIN_SESSION" "$PROMPT_FILE" >>"$WATCHDOG_LOG" 2>&1; then
      log "main session started: $MAIN_SESSION"
    else
      log "failed to start main session: $MAIN_SESSION"
    fi
  fi

  sleep "$INTERVAL_SECONDS"
done
