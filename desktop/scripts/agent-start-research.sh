#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 SESSION PROMPT_FILE [OUTPUT_FILE]" >&2
  echo "starts a read-only research Codex session in tmux with reasoning=low" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

require_cmd tmux
require_cmd codex

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

tmux new-session -d -s "$SESSION" \
  "cd \"$ROOT_DIR\" && PATH=\"$AGENT_PATH\" codex exec -C \"$ROOT_DIR\" -m \"$CODEX_MODEL\" -c model_reasoning_effort=\"$CODEX_REASONING_LOW\" --dangerously-bypass-approvals-and-sandbox -o \"$OUTPUT_FILE\" - < \"$PROMPT_FILE\""

echo "started research session: $SESSION"
echo "output: $OUTPUT_FILE"
