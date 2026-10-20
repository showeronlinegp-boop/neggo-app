#!/bin/sh
# El servidor no queda prendido de madrugada. Al arrancar, y cada hora mientras
# esté prendido, se hace el backup si pasó una semana desde el último que llegó a Drive.
set -eu

CHECK=${BACKUP_CHECK_SECONDS:-3600}
EVERY=${BACKUP_EVERY_DAYS:-7}

mkdir -p /backups
echo "Backup al prender el servidor si pasaron ${EVERY} días desde el último en Drive. Se vuelve a mirar cada ${CHECK} segundos. Log en /backups/backup.log"

while true; do
    /usr/local/bin/backup-if-due.sh 2>&1 | tee -a /backups/backup.log || true
    sleep "$CHECK"
done
