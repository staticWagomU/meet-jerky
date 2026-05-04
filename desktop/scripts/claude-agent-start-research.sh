#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-agent-common.sh"

usage() {
  echo "usage: $0 SESSION PROMPT_FILE [OUTPUT_FILE]" >&2
  echo "starts a read-only research Claude Code session in tmux (model=$CLAUDE_MODEL_RESEARCH, print mode)" >&2
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

# Print mode: claude reads the prompt from stdin and writes the answer to stdout,
# then exits. Tee both stdout/stderr to the output file for later inspection.
# stdin redirect avoids the tmux argv limit when prompts grow past ~4KB.
# PATH is also rebuilt inside the inner shell (escaped \$PATH) because the
# outer shell's $PATH can be 16KB+ and would blow the tmux command-string limit
# if AGENT_PATH was expanded at this layer.
tmux new-session -d -s "$SESSION" \
  "cd \"$ROOT_DIR\" && cat \"$PROMPT_FILE\" | PATH=\"\$HOME/.local/bin:/opt/homebrew/bin:\$HOME/.cargo/bin:\$PATH\" claude --model \"$CLAUDE_MODEL_RESEARCH\" --dangerously-skip-permissions -p 2>&1 | tee \"$OUTPUT_FILE\""

echo "started research session: $SESSION"
echo "model: $CLAUDE_MODEL_RESEARCH"
echo "output: $OUTPUT_FILE"
