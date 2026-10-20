#!/bin/sh
# Corre el backup si hace una semana que no llega uno a Drive.
# El servidor local no está prendido de noche: se mira al arrancar y, si sigue
# prendido, cada hora. A mano se usa backup-db.sh, que no espera esa semana.

set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
EVERY=${BACKUP_EVERY_DAYS:-7}
DRIVE_SA_FILE=${DRIVE_SA_FILE:-/secrets/drive-sa.json}
DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID:-}
BACKUP_BIN=${BACKUP_BIN:-/usr/local/bin/backup-db.sh}
MARKER="${BACKUP_DIR}/.last-success"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

if [ -z "$DRIVE_FOLDER_ID" ] || [ ! -f "$DRIVE_SA_FILE" ]; then
    log "Drive no está configurado. No hay backup automático hasta tener la carpeta y el JSON."
    exit 0
fi

if [ ! -f "$MARKER" ]; then
    log "No hay un backup previo en Drive. Se hace ahora."
    exec "$BACKUP_BIN"
fi

now=$(date +%s)
then=$(date -r "$MARKER" +%s)
age=$(( (now - then) / 86400 ))
if [ "$age" -ge "$EVERY" ]; then
    log "El último backup en Drive fue hace ${age} días. Se hace ahora."
    exec "$BACKUP_BIN"
fi

log "El último backup en Drive fue hace ${age} días. El próximo es al cumplir ${EVERY}."
