#!/bin/sh
# Viernes 15:00, hora Argentina. Si la PC está apagada, el backup queda para cuando la prenden.
# Mientras espera, cada BACKUP_TICK_SECONDS atiende el botón "Hacer backup ahora" de la app
# y deja en .estado lo que la app muestra (servicio vivo, Drive configurado, próximo backup).
set -eu

. /usr/local/bin/backup-schedule.sh

BACKUP_DIR=${BACKUP_DIR:-/backups}
TICK=${BACKUP_TICK_SECONDS:-10}

mkdir -p "$BACKUP_DIR"
echo "Backup automático: viernes a las 15, hora Argentina. Si ese día está apagada, se hace al volver a prenderla. Log en ${BACKUP_DIR}/backup.log"

write_estado() {
    backup_plan
    if [ "$REASON" = sin-drive ]; then drive=false; else drive=true; fi
    printf '{"visto":%s,"drive_configurado":%s,"proximo":%s}\n' "$(date +%s)" "$drive" "$NEXT" > "${BACKUP_DIR}/.estado.tmp"
    mv "${BACKUP_DIR}/.estado.tmp" "${BACKUP_DIR}/.estado"
}

while true; do
    /usr/local/bin/backup-if-due.sh 2>&1 | tee -a "${BACKUP_DIR}/backup.log" || true
    backup_plan
    wait_s=$WAIT
    echo "Próxima mirada en ${wait_s} segundos" | tee -a "${BACKUP_DIR}/backup.log"
    while [ "$wait_s" -gt 0 ]; do
        write_estado || true
        /usr/local/bin/backup-manual.sh || true
        sleep "$TICK"
        wait_s=$((wait_s - TICK))
    done
done
