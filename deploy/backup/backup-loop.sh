#!/bin/sh
# Runs a backup now, then every BACKUP_INTERVAL_HOURS. A failed pass is logged
# and retried at the next interval; the container's health check turns
# unhealthy when no pass has succeeded for too long, so it cannot fail quietly.
set -u
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
while true; do
  if ! /usr/local/bin/backup-once.sh; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: FAILED; will retry in ${INTERVAL_HOURS}h" >&2
  fi
  sleep "$((INTERVAL_HOURS * 3600))"
done
