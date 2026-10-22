#!/bin/sh
set -eu

DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

PLATFORM_FILE="$DIR/platform-$STAMP.dump"
PGPASSWORD="$PLATFORM_DB_PASSWORD" pg_dump \
  --host="$PLATFORM_DB_HOST" --port="${PLATFORM_DB_PORT:-5432}" \
  --username="$PLATFORM_DB_USER" --dbname="$PLATFORM_DB_NAME" \
  --format=custom --compress=6 --no-owner --file="$PLATFORM_FILE.partial"
pg_restore --list "$PLATFORM_FILE.partial" >/dev/null
mv "$PLATFORM_FILE.partial" "$PLATFORM_FILE"
log "platform database -> $PLATFORM_FILE ($(du -h "$PLATFORM_FILE" | cut -f1))"

if [ -n "${USERDB_HOST:-}" ]; then
  USERDB_FILE="$DIR/userdb-$STAMP.sql.gz"
  PGPASSWORD="$USERDB_PASSWORD" pg_dumpall \
    --host="$USERDB_HOST" --port="${USERDB_PORT:-5432}" --username="$USERDB_USER" \
    | gzip -6 > "$USERDB_FILE.partial"
  gzip -t "$USERDB_FILE.partial"
  mv "$USERDB_FILE.partial" "$USERDB_FILE"
  log "project database server -> $USERDB_FILE ($(du -h "$USERDB_FILE" | cut -f1))"
fi

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  ENDPOINT_ARG=""
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && ENDPOINT_ARG="--endpoint-url $BACKUP_S3_ENDPOINT"
  for file in "$DIR"/*-"$STAMP".*; do
    aws $ENDPOINT_ARG s3 cp --only-show-errors "$file" "s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-platform-backups}/$(basename "$file")"
  done
  log "copied to s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-platform-backups}/"
fi

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
find "$DIR" -maxdepth 1 -type f \( -name 'platform-*.dump' -o -name 'userdb-*.sql.gz' \) \
  -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/pruned: /'
find "$DIR" -maxdepth 1 -name '*.partial' -mmin +120 -delete

date -u +%s > "$DIR/.last-success"

if [ -d "${METRICS_TEXTFILE_DIR:-/metrics-textfile}" ]; then
  PROM="${METRICS_TEXTFILE_DIR:-/metrics-textfile}/backup.prom"
  {
    echo '# HELP platform_backup_last_success_timestamp_seconds When the last backup finished.'
    echo '# TYPE platform_backup_last_success_timestamp_seconds gauge'
    echo "platform_backup_last_success_timestamp_seconds $(date -u +%s)"
    echo '# HELP platform_backup_size_bytes Size of the last platform database dump.'
    echo '# TYPE platform_backup_size_bytes gauge'
    echo "platform_backup_size_bytes $(wc -c < "$PLATFORM_FILE" | tr -d ' ')"
  } > "$PROM.tmp"
  mv "$PROM.tmp" "$PROM"
fi
log "done"
