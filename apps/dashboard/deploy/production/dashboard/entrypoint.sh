#!/usr/bin/env sh
set -eu

# Migration jobs override the image entrypoint, so this is application-start
# validation only. It deliberately performs no migration and no backup.
node /app/scripts/validate-production-runtime.mjs
node /app/dist/release-db.js postflight --json >/dev/null

exec "$@"
