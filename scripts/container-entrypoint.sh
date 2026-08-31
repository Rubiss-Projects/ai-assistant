#!/bin/sh
set -eu

workspace_root="${AI_ASSISTANT_WORKSPACE_ROOT:-/data/workspaces}"
mkdir -p "$workspace_root"

if [ "${1:-}" = "start" ]; then
  if [ "${REGISTER_COMMANDS_ON_START:-true}" = "true" ]; then
    node /app/dist/scripts/register-commands.js
  fi
  exec node /app/dist/src/index.js
fi

exec "$@"
