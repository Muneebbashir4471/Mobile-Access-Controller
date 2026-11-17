#!/bin/sh
# Database backup. Keeps the last $KEEP_DAYS days of dumps in deploy/backups and, if
# BACKUP_BUCKET is set (s3://bucket/path; needs the aws CLI with write access), copies each one
# to S3 as well.
#   ./backup.sh                                                    # production stack
#   COMPOSE_FILE=docker-compose.lan.yml ENV_FILE=.env.lan ./backup.sh
# Run it nightly with ./install-backup-cron.sh. Restore steps: docs/runbook.md.
set -eu
cd "$(dirname "$0")"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p backups
OUT="backups/mt5-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$OUT.part"' EXIT
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db pg_dump -U mt5 -Fc mt5 > "$OUT.part"
[ -s "$OUT.part" ] || { echo "backup: pg_dump produced nothing" >&2; exit 1; }
mv "$OUT.part" "$OUT"
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"

if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws s3 cp --only-show-errors "$OUT" "$BACKUP_BUCKET/$(basename "$OUT")"
  echo "backup: copied to $BACKUP_BUCKET"
fi
find backups -name 'mt5-*.dump' -mtime +"$KEEP_DAYS" -delete
