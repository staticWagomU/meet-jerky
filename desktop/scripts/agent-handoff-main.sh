#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 SESSION PROMPT_FILE [OUTPUT_FILE]" >&2
  echo "starts a successor main Codex session in tmux with reasoning=medium" >&2
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

mkdir -p "$(dirname "$OUTPUT_FILE")"
: >"$OUTPUT_FILE"

tmux new-session -d -s "$SESSION" \
  "cd \"$ROOT_DIR\" && PATH=\"$AGENT_PATH\" codex -C \"$ROOT_DIR\" -m \"$CODEX_MODEL\" -c model_reasoning_effort=\"$CODEX_REASONING_MEDIUM\" --dangerously-bypass-approvals-and-sandbox \"\$(cat \"$PROMPT_FILE\")\""
tmux pipe-pane -o -t "$SESSION" "cat >> \"$OUTPUT_FILE\""

echo "started successor main session: $SESSION"
echo "output: $OUTPUT_FILE"
