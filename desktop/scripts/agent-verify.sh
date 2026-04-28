#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

cd "$ROOT_DIR"

echo "== git diff check =="
if [[ $# -gt 0 ]]; then
  git diff --check -- "$@"
else
  git diff --check
fi

echo
echo "== frontend build =="
PATH="$AGENT_PATH" npm run build

echo
echo "== rust format =="
PATH="$AGENT_PATH" cargo fmt --manifest-path src-tauri/Cargo.toml --check

echo
echo "== rust tests =="
if PATH="$AGENT_PATH" command -v cmake >/dev/null 2>&1; then
  PATH="$AGENT_PATH" cargo test --manifest-path src-tauri/Cargo.toml
else
  echo "skipped cargo test: cmake not found; whisper-rs-sys cannot build in this environment"
fi
