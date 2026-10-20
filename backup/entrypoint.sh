#!/bin/sh
# Viernes 15:00, hora Argentina. Si la PC está apagada, el backup queda para cuando la prenden.
set -eu

mkdir -p /backups
echo "Backup automático: viernes a las 15, hora Argentina. Si ese día está apagada, se hace al volver a prenderla. Log en /backups/backup.log"

while true; do
    /usr/local/bin/backup-if-due.sh 2>&1 | tee -a /backups/backup.log || true
    wait_s=$(/usr/local/bin/backup-schedule.sh)
    echo "Próxima mirada en ${wait_s} segundos" | tee -a /backups/backup.log
    sleep "$wait_s"
done
