#!/bin/sh
set -eu

# Railway mounts persistent volumes as root. When it starts this image with
# RAILWAY_RUN_UID=0, fix only the known data directory and immediately drop
# privileges. Docker Compose starts as `node` and skips this branch.
if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  exec gosu node "$@"
fi

exec "$@"
