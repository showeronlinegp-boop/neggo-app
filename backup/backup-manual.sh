#!/bin/sh
# Backup pedido desde la app (Admin → "Hacer backup ahora").
# El backend deja BACKUP_DIR/.manual-request. Esto lo toma, corre backup-db.sh
# y deja el resultado en .manual-status (JSON) para que la app lo muestre.
# Sin pedido no hace nada. Lo llama entrypoint.sh cada pocos segundos.

set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_BIN=${BACKUP_BIN:-/usr/local/bin/backup-db.sh}
LOG=${BACKUP_LOG:-${BACKUP_DIR}/backup.log}
REQUEST="${BACKUP_DIR}/.manual-request"
CLAIMED="${BACKUP_DIR}/.manual-running"
STATUS="${BACKUP_DIR}/.manual-status"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

# estado inicio fin mensaje. Se escribe aparte y se mueve, así la app nunca lee un JSON a medias.
write_status() {
    printf '{"estado":"%s","inicio":%s,"fin":%s,"mensaje":"%s"}\n' "$1" "$2" "$3" "$4" > "${STATUS}.tmp"
    mv "${STATUS}.tmp" "$STATUS"
}

# Si quedó uno tomado, el servicio se cortó en el medio de ese backup
if [ -f "$CLAIMED" ]; then
    rm -f "$CLAIMED"
    write_status error null "$(date +%s)" "El backup se cortó porque se reinició el servicio. Volvé a pedirlo."
    log "⚠️ El backup pedido desde la app se cortó (reinicio del servicio)"
fi

[ -f "$REQUEST" ] || exit 0

# mv es atómico: mientras corre, la app ve .manual-running y no deja pedir otro
mv "$REQUEST" "$CLAIMED"
inicio=$(date +%s)
write_status corriendo "$inicio" null ""
log "Backup pedido desde la app"

if "$BACKUP_BIN" >> "$LOG" 2>&1; then
    write_status ok "$inicio" "$(date +%s)" "Backup en Drive listo"
else
    # Última línea del log sin la fecha, sin comillas ni barras que rompan el JSON
    msg=$(tail -n 1 "$LOG" | cut -c21- | tr -d '"\\' | cut -c1-200)
    write_status error "$inicio" "$(date +%s)" "${msg:-El backup falló. Mirá backup.log}"
fi

rm -f "$CLAIMED"
