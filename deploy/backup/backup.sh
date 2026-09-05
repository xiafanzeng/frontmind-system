#!/bin/sh
set -eu

: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${BACKUP_INTERVAL_SECONDS:=21600}"
: "${BACKUP_RETENTION_DAYS:=14}"

mkdir -p /backups
while :; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="/backups/${MYSQL_DATABASE}-${stamp}.sql.gz"
  MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --host=mysql --single-transaction --routines --events --triggers --hex-blob --user="$MYSQL_USER" "$MYSQL_DATABASE" | gzip -9 > "$target"
  find /backups -type f -name '*.sql.gz' -mtime "+$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
