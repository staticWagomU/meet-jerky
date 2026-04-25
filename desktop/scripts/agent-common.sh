#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${MJ_ROOT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT_OUTPUT_DIR="${MJ_AGENT_OUTPUT_DIR:-$ROOT_DIR/logs/agent}"
CODEX_MODEL="${MJ_CODEX_MODEL:-gpt-5.5}"
CODEX_REASONING_LOW="${MJ_CODEX_REASONING_LOW:-low}"
CODEX_REASONING_MEDIUM="${MJ_CODEX_REASONING_MEDIUM:-medium}"
AGENT_PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

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
}
