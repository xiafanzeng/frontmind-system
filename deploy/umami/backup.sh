#!/bin/sh
set -eu
umask 077
: "${POSTGRES_DB:?required}"
: "${POSTGRES_USER:?required}"
: "${POSTGRES_PASSWORD:?required}"
: "${BACKUP_INTERVAL_SECONDS:=21600}"
: "${BACKUP_RETENTION_DAYS:=14}"
mkdir -p /backups
while :; do
  target="/backups/umami-$(date -u +%Y%m%dT%H%M%SZ).dump"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h umami-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --file="${target}.tmp"
  pg_restore --list "${target}.tmp" >/dev/null
  mv "${target}.tmp" "$target"
  find /backups -type f -name 'umami-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
