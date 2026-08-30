#!/bin/sh
set -eu

if [ "${1:-}" = "start" ]; then
  if [ "${REGISTER_COMMANDS_ON_START:-true}" = "true" ]; then
    node /app/dist/scripts/register-commands.js
  fi
  exec node /app/dist/src/index.js
fi

exec "$@"
