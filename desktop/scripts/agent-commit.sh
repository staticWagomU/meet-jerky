#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 COMMIT_MESSAGE [PATH ...]" >&2
  echo "example: $0 'fix(audio): マイク入力を安定化' src-tauri/src/audio.rs AGENT_LOG.md" >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

MESSAGE="$1"
shift

cd "$ROOT_DIR"

echo "== pre-commit status =="
git status --short --branch
echo
echo "== diff stat =="
git diff --stat

if [[ $# -gt 0 ]]; then
  git add -- "$@"
else
  git add -u
fi

if git diff --cached --quiet; then
  echo "nothing staged; aborting commit" >&2
  exit 1
fi

echo
echo "== staged diff stat =="
git diff --cached --stat
git commit -m "$MESSAGE"
