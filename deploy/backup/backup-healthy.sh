#!/bin/sh
LAST="$(cat "${BACKUP_DIR:-/backups}/.last-success" 2>/dev/null || echo 0)"
AGE=$(( $(date -u +%s) - LAST ))
[ "$AGE" -lt $(( ${BACKUP_INTERVAL_HOURS:-24} * 2 * 3600 )) ]
