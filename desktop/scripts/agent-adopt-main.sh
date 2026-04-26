#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-common.sh"

usage() {
  echo "usage: $0 SUCCESSOR_SESSION [MAIN_SESSION]" >&2
  echo "renames a successor main session to the canonical main session name" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

require_cmd tmux

SUCCESSOR_SESSION="$1"
MAIN_SESSION="${2:-mj-main}"

valid_session_name() {
  [[ "$1" =~ ^[A-Za-z0-9_.:-]+$ ]]
}

if ! valid_session_name "$SUCCESSOR_SESSION"; then
  echo "invalid successor session name: $SUCCESSOR_SESSION" >&2
  exit 2
fi
if ! valid_session_name "$MAIN_SESSION"; then
  echo "invalid main session name: $MAIN_SESSION" >&2
  exit 2
fi

if [[ "$SUCCESSOR_SESSION" == "$MAIN_SESSION" ]]; then
  if agent_session_exists "$MAIN_SESSION"; then
    echo "main session already canonical: $MAIN_SESSION"
    exit 0
  fi
  echo "main session does not exist: $MAIN_SESSION" >&2
  exit 1
fi

if ! agent_session_exists "$SUCCESSOR_SESSION"; then
  echo "successor session does not exist: $SUCCESSOR_SESSION" >&2
  exit 1
fi

if agent_session_exists "$MAIN_SESSION"; then
  RETIRED_SESSION="${MAIN_SESSION}-retired-$(date +%Y%m%d%H%M%S)"
  if agent_session_exists "$RETIRED_SESSION"; then
    echo "temporary retired session already exists: $RETIRED_SESSION" >&2
    exit 1
  fi

  tmux rename-session -t "$MAIN_SESSION" "$RETIRED_SESSION"
  tmux rename-session -t "$SUCCESSOR_SESSION" "$MAIN_SESSION"
  tmux kill-session -t "$RETIRED_SESSION"
else
  tmux rename-session -t "$SUCCESSOR_SESSION" "$MAIN_SESSION"
fi

echo "adopted successor main session: $SUCCESSOR_SESSION -> $MAIN_SESSION"
