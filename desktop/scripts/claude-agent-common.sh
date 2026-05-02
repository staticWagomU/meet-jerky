#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for Claude Code (claude CLI) tmux harness scripts.
# Mirrors agent-common.sh but targets `claude` instead of `codex`.
# Sessions use the `mjc-` prefix so they coexist with the Codex `mj-` sessions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${MJ_ROOT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT_OUTPUT_DIR="${MJ_AGENT_OUTPUT_DIR:-$ROOT_DIR/logs/agent}"

CLAUDE_MODEL_RESEARCH="${MJ_CLAUDE_MODEL_RESEARCH:-haiku}"
CLAUDE_MODEL_WORKER="${MJ_CLAUDE_MODEL_WORKER:-sonnet}"
CLAUDE_MODEL_MAIN="${MJ_CLAUDE_MODEL_MAIN:-opus}"

# Include $HOME/.local/bin so the `claude` CLI is on PATH inside tmux.
AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$AGENT_OUTPUT_DIR"

require_cmd() {
  if ! PATH="$AGENT_PATH" command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 127
  fi
}

agent_output_path() {
  local session="$1"
  printf '%s/%s.txt' "$AGENT_OUTPUT_DIR" "$session"
}

agent_session_exists() {
  local session="$1"
  tmux has-session -t "$session" >/dev/null 2>&1
}

print_agent_paths() {
  echo "root: $ROOT_DIR"
  echo "output: $AGENT_OUTPUT_DIR"
  echo "models: research=$CLAUDE_MODEL_RESEARCH worker=$CLAUDE_MODEL_WORKER main=$CLAUDE_MODEL_MAIN"
}
