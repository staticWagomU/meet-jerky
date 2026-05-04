#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-agent-common.sh"

usage() {
  echo "usage: $0 SESSION PROMPT_FILE [OUTPUT_FILE]" >&2
  echo "starts a worker Claude Code session in tmux (model=$CLAUDE_MODEL_WORKER, print mode)" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

require_cmd tmux
require_cmd claude

SESSION="$1"
PROMPT_FILE="$2"
OUTPUT_FILE="${3:-$(agent_output_path "$SESSION")}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi
if [[ "$PROMPT_FILE" != /* ]]; then
  PROMPT_FILE="$PWD/$PROMPT_FILE"
fi

if agent_session_exists "$SESSION"; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
: >"$OUTPUT_FILE"

# stdin redirect: large prompts (4KB+) trip tmux argv limits when expanded via
# `-p "$(cat ...)"`. Pipe the prompt instead — claude -p reads it from stdin.
tmux new-session -d -s "$SESSION" \
  "cd \"$ROOT_DIR\" && cat \"$PROMPT_FILE\" | PATH=\"$AGENT_PATH\" claude --model \"$CLAUDE_MODEL_WORKER\" --dangerously-skip-permissions -p 2>&1 | tee \"$OUTPUT_FILE\""

echo "started worker session: $SESSION"
echo "model: $CLAUDE_MODEL_WORKER"
echo "output: $OUTPUT_FILE"
