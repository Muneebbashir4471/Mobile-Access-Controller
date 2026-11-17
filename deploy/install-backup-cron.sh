#!/bin/sh
# Installs (or replaces) a nightly 02:15 UTC cron job that runs backup.sh. Settings you pass
# here are written into the job, for example:
#   ./install-backup-cron.sh
#   BACKUP_BUCKET=s3://my-bucket/mt5 KEEP_DAYS=30 ./install-backup-cron.sh
#   COMPOSE_FILE=docker-compose.lan.yml ENV_FILE=.env.lan ./install-backup-cron.sh
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/backups"
VARS=""
for v in BACKUP_BUCKET KEEP_DAYS COMPOSE_FILE ENV_FILE; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && VARS="$VARS$v=$val "
done
LINE="15 2 * * * cd $DIR && $VARS./backup.sh >> $DIR/backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -vF "cd $DIR && " || true; echo "$LINE" ) | crontab -
echo "Installed: $LINE"
echo "Test it now with: cd $DIR && ${VARS}./backup.sh"
