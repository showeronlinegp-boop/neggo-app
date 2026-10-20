#!/bin/sh
# Backup automático: viernes a las 15, hora Argentina.
# Si ese viernes la PC está apagada, se hace la primera vez que vuelve a prender.
# A mano, en cualquier momento: backup-db.sh

set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
DRIVE_SA_FILE=${DRIVE_SA_FILE:-/secrets/drive-sa.json}
DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID:-}
BACKUP_BIN=${BACKUP_BIN:-/usr/local/bin/backup-db.sh}
MARKER="${BACKUP_DIR}/.last-success"

here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/backup-schedule.sh"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

backup_plan
cuando=$(date -d "@$SLOT" '+%d/%m %H:%M')

if [ "$REASON" = sin-drive ]; then
    log "Drive no está configurado. No hay backup automático hasta tener la carpeta y el JSON."
    exit 0
fi

if [ "$DUE" = yes ] && [ "$REASON" = primero ]; then
    log "Es el viernes a las 15. Todavía no hay un backup en Drive. Se hace ahora."
    exec "$BACKUP_BIN"
fi

if [ "$DUE" = yes ]; then
    log "No se hizo el backup del viernes ${cuando}. Se hace ahora."
    exec "$BACKUP_BIN"
fi

if [ "$REASON" = hecho ]; then
    log "El backup de este viernes ya está en Drive. El próximo es el viernes a las 15."
    exit 0
fi

log "Todavía no es viernes a las 15. El próximo backup es a esa hora."
