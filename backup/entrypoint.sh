#!/bin/sh
# Deja el cron semanal en primer plano. El dump corre domingo a las 03:00, hora Argentina.
set -eu

CRON=${BACKUP_CRON:-0 3 * * 0}
TZ=${TZ:-America/Argentina/Buenos_Aires}

mkdir -p /backups /etc/crontabs
cat > /etc/crontabs/root <<EOF
TZ=${TZ}
${CRON} /usr/local/bin/backup-db.sh >> /backups/backup.log 2>&1
EOF

chmod 600 /etc/crontabs/root
echo "Backup semanal activo: ${CRON} (${TZ}). Log en /backups/backup.log"
exec crond -f -l 8
