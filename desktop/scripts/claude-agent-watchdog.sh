#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-agent-common.sh"

usage() {
  echo "usage: $0 [MAIN_SESSION] [PROMPT_FILE] [INTERVAL_SECONDS] [NUDGE_COOLDOWN_SECONDS]" >&2
  echo "restarts the main Claude Code tmux session when missing and nudges it when idle" >&2
}

if [[ $# -gt 4 ]]; then
  usage
  exit 2
fi

require_cmd tmux

MAIN_SESSION="${1:-mjc-main}"
PROMPT_FILE="${2:-$ROOT_DIR/docs/autonomous-main-prompt-claude.md}"
INTERVAL_SECONDS="${3:-180}"
NUDGE_COOLDOWN_SECONDS="${4:-${MJ_WATCHDOG_NUDGE_COOLDOWN_SECONDS:-300}}"
CLEAR_COOLDOWN_SECONDS="${MJ_CLAUDE_WATCHDOG_CLEAR_COOLDOWN_SECONDS:-180}"
WATCHDOG_LOG="${MJ_CLAUDE_WATCHDOG_LOG:-$AGENT_OUTPUT_DIR/claude-watchdog.log}"
NUDGE_MESSAGE="${MJ_CLAUDE_WATCHDOG_NUDGE_MESSAGE:-watchdog継続指示: docs/autonomous-main-prompt-claude.md に従って次の自律改善ループへ進んでください。}"

if [[ ! "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 10 ]]; then
  echo "interval must be an integer >= 10 seconds: $INTERVAL_SECONDS" >&2
  exit 2
fi
if [[ ! "$NUDGE_COOLDOWN_SECONDS" =~ ^[0-9]+$ ]] || [[ "$NUDGE_COOLDOWN_SECONDS" -lt 60 ]]; then
  echo "nudge cooldown must be an integer >= 60 seconds: $NUDGE_COOLDOWN_SECONDS" >&2
  exit 2
fi
if [[ ! "$CLEAR_COOLDOWN_SECONDS" =~ ^[0-9]+$ ]] || [[ "$CLEAR_COOLDOWN_SECONDS" -lt 60 ]]; then
  echo "clear cooldown must be an integer >= 60 seconds: $CLEAR_COOLDOWN_SECONDS" >&2
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

# Claude Code TUI prints "new task? /clear to save NNN.Nk tokens" only when the
# session has hit its context limit and is blocked from accepting further input
# until the user clears or compacts. We treat this as a hard freeze that prompt-
# level instructions cannot recover from, and force /clear externally.
main_session_overflow_warning() {
  local pane_text
  pane_text="$(tmux capture-pane -p -t "$MAIN_SESSION" -S -40 2>/dev/null || true)"
  printf '%s\n' "$pane_text" | grep -Eq 'new task\? /clear to save'
}

# Claude Code TUI shows "esc to interrupt" only while it is generating.
# Treat its absence as "idle and waiting for further input".
main_session_waiting_for_input() {
  local pane_text
  pane_text="$(tmux capture-pane -p -t "$MAIN_SESSION" -S -60 2>/dev/null || true)"

  if printf '%s\n' "$pane_text" | tail -n 30 | grep -Eq 'esc to interrupt'; then
    return 1
  fi

  # Heuristic: an idle Claude Code TUI shows the input box border or `>` prompt
  # in the last few lines. If we cannot find any of those, refuse to nudge to
  # avoid hammering a session that is in an unexpected state (e.g. error).
  printf '%s\n' "$pane_text" | tail -n 15 | grep -Eq '>|│|╰|╯|Try'
}

clear_main_session() {
  log "main session shows context overflow; sending /clear and re-injecting prompt: $MAIN_SESSION"
  # Send the /clear slash command literally, then submit.
  tmux send-keys -t "$MAIN_SESSION" '/clear'
  sleep 0.5
  tmux send-keys -t "$MAIN_SESSION" Enter
  # Give the TUI time to process the clear.
  sleep 4

  # Re-inject the autonomous prompt by pasting the prompt file as a single
  # buffer. /clear wipes the conversation, so the prompt must be re-submitted.
  local buffer="claude-watchdog-clear-$$"
  if tmux load-buffer -b "$buffer" "$PROMPT_FILE" 2>/dev/null; then
    tmux paste-buffer -d -b "$buffer" -t "$MAIN_SESSION"
    sleep 0.5
    tmux send-keys -t "$MAIN_SESSION" Enter
    log "prompt re-injected after /clear: $MAIN_SESSION"
  else
    log "failed to load prompt file for re-injection: $PROMPT_FILE"
  fi
}

nudge_main_session() {
  local pane_text
  pane_text="$(tmux capture-pane -p -t "$MAIN_SESSION" -S -80 2>/dev/null || true)"

  if printf '%s\n' "$pane_text" | grep -q 'watchdog継続指示\|watchdog からの定型継続指示'; then
    tmux send-keys -t "$MAIN_SESSION" Enter
    return
  fi

  # Use load-buffer/paste-buffer for the message body so long strings are not
  # split into per-key events that could trigger Claude Code's paste UI.
  local buffer="claude-watchdog-nudge-$$"
  printf '%s' "$NUDGE_MESSAGE" | tmux load-buffer -b "$buffer" -
  tmux paste-buffer -d -b "$buffer" -t "$MAIN_SESSION"
  tmux send-keys -t "$MAIN_SESSION" Enter
}

LAST_NUDGE_AT=0
LAST_CLEAR_AT=0

log "claude watchdog started: main=$MAIN_SESSION prompt=$PROMPT_FILE interval=${INTERVAL_SECONDS}s nudge_cooldown=${NUDGE_COOLDOWN_SECONDS}s clear_cooldown=${CLEAR_COOLDOWN_SECONDS}s"

while true; do
  if agent_session_exists "$MAIN_SESSION"; then
    log "main session alive: $MAIN_SESSION"
    now="$(date +%s)"
    if main_session_overflow_warning; then
      if (( now - LAST_CLEAR_AT >= CLEAR_COOLDOWN_SECONDS )); then
        clear_main_session
        LAST_CLEAR_AT="$now"
        # Re-injected prompt counts as fresh activity; reset nudge timer.
        LAST_NUDGE_AT="$now"
      else
        log "main session shows context overflow; clear cooldown active: $MAIN_SESSION"
      fi
    elif main_session_waiting_for_input; then
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
    if "$ROOT_DIR/scripts/claude-agent-handoff-main.sh" "$MAIN_SESSION" "$PROMPT_FILE" >>"$WATCHDOG_LOG" 2>&1; then
      log "main session started: $MAIN_SESSION"
      LAST_NUDGE_AT=0
      LAST_CLEAR_AT=0
    else
      log "failed to start main session: $MAIN_SESSION"
    fi
  fi

  sleep "$INTERVAL_SECONDS"
done
