#!/bin/sh
# Dump de neggo_app y, si Drive está configurado, copia a esa carpeta.
# Corre solo (domingo 03:00, hora Argentina) y también a mano:
#   docker compose exec db-backup backup-db.sh

set -eu

PG_DUMP=${PG_DUMP:-pg_dump}
PG_RESTORE=${PG_RESTORE:-pg_restore}
RCLONE=${RCLONE:-rclone}

BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP:-8}
PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-neggo}
PGDATABASE=${PGDATABASE:-neggo_app}
DRIVE_SA_FILE=${DRIVE_SA_FILE:-/secrets/drive-sa.json}
DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID:-}

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# Borra los más viejos y deja los últimos KEEP. Los nombres llevan fecha ISO, así el orden alfabético es el cronológico.
prune_names() {
    list=$1
    total=$(wc -l < "$list" | tr -d ' ')
    remove=$((total - KEEP))
    if [ "$remove" -le 0 ]; then
        return 0
    fi
    head -n "$remove" "$list"
}

STAMP=$(date +%Y-%m-%d)
FILE="${BACKUP_DIR}/neggo_app_${STAMP}.dump"
PARTIAL="${BACKUP_DIR}/.neggo_app_${STAMP}.dump.partial"
LIST="${BACKUP_DIR}/.backup-list"
CFG="${BACKUP_DIR}/.rclone.conf"
trap 'rm -f "$PARTIAL" "$LIST"' EXIT

mkdir -p "$BACKUP_DIR"
rm -f "$PARTIAL"

log "Empieza el dump de ${PGDATABASE}"
"$PG_DUMP" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -Fc --no-owner --no-acl -f "$PARTIAL"
"$PG_RESTORE" -l "$PARTIAL" >/dev/null
mv "$PARTIAL" "$FILE"
log "Dump local listo: ${FILE} ($(wc -c < "$FILE" | tr -d ' ') bytes)"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'neggo_app_*.dump' | sort > "$LIST"
prune_names "$LIST" | while read -r old; do
    rm -f "$old"
    log "Borrado local viejo: ${old}"
done

if [ -z "$DRIVE_FOLDER_ID" ] || [ ! -f "$DRIVE_SA_FILE" ]; then
    log "Drive no está configurado. El dump quedó solo en ${BACKUP_DIR}."
    log "Falta DRIVE_FOLDER_ID o el archivo ${DRIVE_SA_FILE}. Ver backup/README.md."
    exit 1
fi

cat > "$CFG" <<EOF
[drive]
type = drive
scope = drive
service_account_file = ${DRIVE_SA_FILE}
root_folder_id = ${DRIVE_FOLDER_ID}
EOF
chmod 600 "$CFG"

log "Subiendo $(basename "$FILE") a Drive"
"$RCLONE" copyto "$FILE" "drive:$(basename "$FILE")" --config "$CFG"

"$RCLONE" lsf drive: --config "$CFG" --files-only --include 'neggo_app_*.dump' | sort > "$LIST"
prune_names "$LIST" | while read -r old; do
    "$RCLONE" deletefile "drive:${old}" --config "$CFG"
    log "Borrado en Drive: ${old}"
done

log "Backup en Drive listo"
