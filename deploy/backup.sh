#!/bin/sh
# Nightly: crontab -e →  15 2 * * * /opt/mt5/deploy/backup.sh
set -eu
BUCKET="${BACKUP_BUCKET:?set BACKUP_BUCKET, e.g. s3://my-bucket/mt5}"
cd "$(dirname "$0")"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U mt5 -Fc mt5 | aws s3 cp - "$BUCKET/mt5-$STAMP.dump"
