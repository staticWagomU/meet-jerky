#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]" >&2
  echo "restarts the main Codex tmux session when it is missing and nudges it if it is idle" >&2
}

if [[ $# -gt 4 ]]; then
  usage
  exit 2
fi

require_cmd tmux

MAIN_SESSION="${1:-mj-main}"
PROMPT_FILE="${2:-$ROOT_DIR/docs/autonomous-main-prompt.md}"
INTERVAL_SECONDS="${3:-600}"
NUDGE_COOLDOWN_SECONDS="${4:-${MJ_WATCHDOG_NUDGE_COOLDOWN_SECONDS:-600}}"
WATCHDOG_LOG="${MJ_WATCHDOG_LOG:-$AGENT_OUTPUT_DIR/watchdog.log}"
NUDGE_MESSAGE="${MJ_WATCHDOG_NUDGE_MESSAGE:-docs/autonomous-main-prompt.md の方針に従い、ユーザーから停止依頼がない限り final answer で停止せず次の自律改善ループへ進んでください。watchdog からの定型継続指示です。判断・実装・差分レビュー・検証・コミットは mj-main が行ってください。}"

if [[ ! "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 10 ]]; then
  echo "interval must be an integer >= 10 seconds: $INTERVAL_SECONDS" >&2
  exit 2
fi
if [[ ! "$NUDGE_COOLDOWN_SECONDS" =~ ^[0-9]+$ ]] || [[ "$NUDGE_COOLDOWN_SECONDS" -lt 60 ]]; then
  echo "nudge cooldown must be an integer >= 60 seconds: $NUDGE_COOLDOWN_SECONDS" >&2
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

main_session_waiting_for_input() {
  local pane_text
  pane_text="$(tmux capture-pane -p -t "$MAIN_SESSION" -S -60 2>/dev/null || true)"

  if printf '%s\n' "$pane_text" | tail -n 30 | grep -Eq '^[[:space:]]*• Working \('; then
    return 1
  fi

  printf '%s\n' "$pane_text" | tail -n 30 | grep -Eq '^[[:space:]]*› '
}

nudge_main_session() {
  tmux send-keys -t "$MAIN_SESSION" C-u "$NUDGE_MESSAGE" C-m
}

LAST_NUDGE_AT=0

log "watchdog started: main=$MAIN_SESSION prompt=$PROMPT_FILE interval=${INTERVAL_SECONDS}s nudge_cooldown=${NUDGE_COOLDOWN_SECONDS}s"

while true; do
  if agent_session_exists "$MAIN_SESSION"; then
    log "main session alive: $MAIN_SESSION"
    now="$(date +%s)"
    if main_session_waiting_for_input; then
      if (( now - LAST_NUDGE_AT >= NUDGE_COOLDOWN_SECONDS )); then
        log "main session appears idle; sending continuation nudge: $MAIN_SESSION"
        nudge_main_session
        LAST_NUDGE_AT="$now"
      else
        log "main session appears idle; nudge cooldown active: $MAIN_SESSION"
      fi
    fi
  else
    log "main session missing; starting: $MAIN_SESSION"
    if "$ROOT_DIR/scripts/agent-handoff-main.sh" "$MAIN_SESSION" "$PROMPT_FILE" >>"$WATCHDOG_LOG" 2>&1; then
      log "main session started: $MAIN_SESSION"
      LAST_NUDGE_AT=0
    else
      log "failed to start main session: $MAIN_SESSION"
    fi
  fi

  sleep "$INTERVAL_SECONDS"
done
