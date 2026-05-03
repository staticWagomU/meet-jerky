#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

cd "$ROOT_DIR"

# Determine which files to inspect for verification scope.
# - When explicit args are passed, treat them as authoritative (workers usually
#   pass their own changed paths).
# - Otherwise fall back to `git diff --name-only HEAD` to cover staged + unstaged
#   changes.
if [[ $# -gt 0 ]]; then
  changed_files=("$@")
else
  mapfile -t changed_files < <(git diff --name-only HEAD 2>/dev/null || true)
fi

has_rust=false
has_frontend=false
has_any=false
for f in "${changed_files[@]:-}"; do
  [[ -z "$f" ]] && continue
  has_any=true
  case "$f" in
    src-tauri/*.rs|src-tauri/**/*.rs|src-tauri/Cargo.toml|src-tauri/Cargo.lock)
      has_rust=true
      ;;
    src/*|index.html|package.json|package-lock.json|vite.config.*|tsconfig*|*.css|*.tsx|*.ts|*.jsx|*.mjs)
      has_frontend=true
      ;;
    *.md|AGENT_LOG.md|docs/*|README*|LICENSE*)
      # Doc-only paths skip both build and rust steps.
      ;;
    *)
      # Conservative default: assume frontend impact for unknown paths.
      has_frontend=true
      ;;
  esac
done

# When no files are detected at all (rare; e.g., empty arg list and clean tree)
# fall back to the full pipeline so we never silently skip everything.
if ! $has_any; then
  has_frontend=true
  has_rust=true
fi

echo "== git diff check =="
if [[ $# -gt 0 ]]; then
  git diff --check -- "$@"
else
  git diff --check
fi

echo
if $has_frontend; then
  echo "== frontend build =="
  PATH="$AGENT_PATH" npm run build
else
  echo "== frontend build (skipped: no frontend changes) =="
fi

echo
if $has_rust; then
  echo "== rust format =="
  PATH="$AGENT_PATH" cargo fmt --manifest-path src-tauri/Cargo.toml --check

  echo
  echo "== rust tests =="
  if PATH="$AGENT_PATH" command -v cmake >/dev/null 2>&1; then
    PATH="$AGENT_PATH" cargo test --manifest-path src-tauri/Cargo.toml
  else
    echo "skipped cargo test: cmake not found; whisper-rs-sys cannot build in this environment"
  fi
else
  echo "== rust format+tests (skipped: no rust changes) =="
fi
