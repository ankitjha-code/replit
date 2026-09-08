#!/bin/sh
# Restores the platform database from a dump made by backup-once.sh.
#
#   docker compose run --rm -e RESTORE_CONFIRM=yes backup \
#     restore-platform.sh /backups/platform-20260101T000000Z.dump
#
# Replaces what is there. Stop the api and worker first, so nothing writes
# while it runs. Refuses without RESTORE_CONFIRM=yes.
set -eu
FILE="${1:?usage: restore-platform.sh <dump file>}"
[ "${RESTORE_CONFIRM:-}" = "yes" ] || { echo "Set RESTORE_CONFIRM=yes to replace the platform database." >&2; exit 2; }
pg_restore --list "$FILE" >/dev/null
PGPASSWORD="$PLATFORM_DB_PASSWORD" pg_restore \
  --host="$PLATFORM_DB_HOST" --port="${PLATFORM_DB_PORT:-5432}" \
  --username="$PLATFORM_DB_USER" --dbname="${RESTORE_DB_NAME:-$PLATFORM_DB_NAME}" \
  --clean --if-exists --no-owner --exit-on-error --single-transaction "$FILE"
echo "restored $FILE into ${RESTORE_DB_NAME:-$PLATFORM_DB_NAME}"
