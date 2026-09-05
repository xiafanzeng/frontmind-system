#!/bin/sh
set -eu
umask 077

: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${BACKUP_INTERVAL_SECONDS:=21600}"
: "${BACKUP_RETENTION_DAYS:=14}"

mkdir -p /backups
raw=
compressed=
trap 'rm -f "$raw" "$compressed"' EXIT HUP INT TERM
while :; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="/backups/${MYSQL_DATABASE}-${stamp}.sql.gz"
  raw="${target}.sql.tmp"
  compressed="${target}.tmp"
  # POSIX sh has no pipefail: publish only after both commands succeed.
  # The application user does not need PROCESS to dump this database.
  MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --host=mysql --single-transaction --no-tablespaces --routines --events --triggers --hex-blob --user="$MYSQL_USER" "$MYSQL_DATABASE" > "$raw"
  gzip -9 -c "$raw" > "$compressed"
  gzip -t "$compressed"
  mv "$compressed" "$target"
  rm -f "$raw"
  raw=
  compressed=
  find /backups -type f -name '*.sql.gz' -mtime "+$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
