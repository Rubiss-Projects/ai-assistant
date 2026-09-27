#!/bin/sh
set -eu

workspace_root="${AI_ASSISTANT_WORKSPACE_ROOT:-/data/workspaces}"
mkdir -p "$workspace_root"

if [ "${1:-}" = "start" ]; then
  adapter=$(printf '%s' "${AI_ASSISTANT_ADAPTER:-discord}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ "${adapter:-discord}" = "discord" ] && [ "${REGISTER_COMMANDS_ON_START:-true}" = "true" ]; then
    node /app/dist/scripts/register-commands.js
  fi
  exec node /app/dist/src/index.js
fi

exec "$@"
