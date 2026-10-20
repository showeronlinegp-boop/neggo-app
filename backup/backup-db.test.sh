#!/bin/sh
# Prueba el dump, la retención y la subida sin Postgres ni Drive.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/backups" "$TMP/secrets" "$TMP/drive"

cat > "$TMP/bin/pg_dump" <<'EOF'
#!/bin/sh
while [ $# -gt 0 ]; do
    if [ "$1" = "-f" ]; then
        printf 'PGDUMP' > "$2"
        exit 0
    fi
    shift
done
echo "pg_dump sin -f" >&2
exit 1
EOF

cat > "$TMP/bin/pg_restore" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$TMP/bin/rclone" <<'EOF'
#!/bin/sh
cmd=$1
shift
src=""
dst=""
while [ $# -gt 0 ]; do
    case "$1" in
        --config|--include) shift 2 ;;
        --files-only) shift ;;
        *)
            if [ -z "$src" ]; then src=$1; else dst=$1; fi
            shift
            ;;
    esac
done
case "$cmd" in
    copyto)
        name=${dst#drive:}
        cp "$src" "$DRIVE_MOCK/$name"
        printf 'copy %s\n' "$name" >> "$DRIVE_MOCK/log"
        ;;
    lsf)
        for f in "$DRIVE_MOCK"/neggo_app_*.dump; do
            [ -f "$f" ] || continue
            basename "$f"
        done
        ;;
    deletefile)
        name=${src#drive:}
        rm -f "$DRIVE_MOCK/$name"
        printf 'delete %s\n' "$name" >> "$DRIVE_MOCK/log"
        ;;
    *)
        echo "rclone desconocido: $cmd" >&2
        exit 1
        ;;
esac
EOF
chmod 755 "$TMP/bin/pg_dump" "$TMP/bin/pg_restore" "$TMP/bin/rclone"
printf '{}\n' > "$TMP/secrets/drive-sa.json"

# Ocho dumps viejos ya en disco y en Drive. El de hoy tiene que quedar y sobrar el más viejo.
i=1
while [ "$i" -le 8 ]; do
    name=$(printf 'neggo_app_2026-01-%02d.dump' "$i")
    printf old > "$TMP/backups/$name"
    printf old > "$TMP/drive/$name"
    i=$((i + 1))
done

PATH="$TMP/bin:$PATH" \
BACKUP_DIR="$TMP/backups" \
BACKUP_KEEP=8 \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID=carpeta-prueba \
DRIVE_MOCK="$TMP/drive" \
    "$ROOT/backup-db.sh" > "$TMP/out"

TODAY=$(date +%Y-%m-%d)
test -s "$TMP/backups/neggo_app_${TODAY}.dump"
test -s "$TMP/drive/neggo_app_${TODAY}.dump"
test ! -f "$TMP/backups/neggo_app_2026-01-01.dump"
test ! -f "$TMP/drive/neggo_app_2026-01-01.dump"
test -f "$TMP/backups/neggo_app_2026-01-02.dump"
grep -q "copy neggo_app_${TODAY}.dump" "$TMP/drive/log"
grep -q "delete neggo_app_2026-01-01.dump" "$TMP/drive/log"

# Sin carpeta de Drive el dump local se hace igual y el comando avisa.
rm -f "$TMP/backups/neggo_app_${TODAY}.dump"
set +e
PATH="$TMP/bin:$PATH" \
BACKUP_DIR="$TMP/backups" \
BACKUP_KEEP=8 \
DRIVE_FOLDER_ID= \
    "$ROOT/backup-db.sh" > "$TMP/nodrive" 2>&1
code=$?
set -e
test "$code" -eq 1
test -s "$TMP/backups/neggo_app_${TODAY}.dump"
grep -q "Drive no está configurado" "$TMP/nodrive"

# Restaurar sin confirmación no toca nada.
set +e
"$ROOT/restore-db.sh" "$TMP/backups/neggo_app_${TODAY}.dump" > "$TMP/restore" 2>&1
code=$?
set -e
test "$code" -eq 1
grep -q "RESTORE_CONFIRM=si" "$TMP/restore"
test -f "$TMP/backups/.last-success"

# Si el dump de hoy ya está, no se vuelve a dumpear: solo se sube.
cat > "$TMP/bin/pg_dump" <<'EOF'
#!/bin/sh
echo "no tenía que dumpear de nuevo" >&2
exit 1
EOF
chmod 755 "$TMP/bin/pg_dump"
PATH="$TMP/bin:$PATH" \
BACKUP_DIR="$TMP/backups" \
BACKUP_KEEP=8 \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID=carpeta-prueba \
DRIVE_MOCK="$TMP/drive" \
    "$ROOT/backup-db.sh" > "$TMP/reuse"
grep -q "Ya hay un dump de hoy" "$TMP/reuse"

# Al prender el servidor: sin marca previa, corre. Con una marca reciente, no.
cat > "$TMP/bin/ran-backup" <<'EOF'
#!/bin/sh
touch "$RAN"
EOF
chmod 755 "$TMP/bin/ran-backup"

rm -f "$TMP/backups/.last-success" "$TMP/ran"
RAN="$TMP/ran" \
BACKUP_DIR="$TMP/backups" \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID=carpeta-prueba \
BACKUP_EVERY_DAYS=7 \
BACKUP_BIN="$TMP/bin/ran-backup" \
    "$ROOT/backup-if-due.sh" > "$TMP/due1"
test -f "$TMP/ran"
grep -q "No hay un backup previo" "$TMP/due1"

rm -f "$TMP/ran"
touch "$TMP/backups/.last-success"
RAN="$TMP/ran" \
BACKUP_DIR="$TMP/backups" \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID=carpeta-prueba \
BACKUP_EVERY_DAYS=7 \
BACKUP_BIN="$TMP/bin/ran-backup" \
    "$ROOT/backup-if-due.sh" > "$TMP/due2"
test ! -f "$TMP/ran"
grep -q "El próximo es al cumplir" "$TMP/due2"

rm -f "$TMP/ran"
touch -d '8 days ago' "$TMP/backups/.last-success"
RAN="$TMP/ran" \
BACKUP_DIR="$TMP/backups" \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID=carpeta-prueba \
BACKUP_EVERY_DAYS=7 \
BACKUP_BIN="$TMP/bin/ran-backup" \
    "$ROOT/backup-if-due.sh" > "$TMP/due3"
test -f "$TMP/ran"
grep -q "Se hace ahora" "$TMP/due3"

rm -f "$TMP/ran" "$TMP/backups/.last-success"
RAN="$TMP/ran" \
BACKUP_DIR="$TMP/backups" \
DRIVE_SA_FILE="$TMP/secrets/drive-sa.json" \
DRIVE_FOLDER_ID= \
BACKUP_EVERY_DAYS=7 \
BACKUP_BIN="$TMP/bin/ran-backup" \
    "$ROOT/backup-if-due.sh" > "$TMP/due4"
test ! -f "$TMP/ran"
grep -q "Drive no está configurado" "$TMP/due4"

echo "backup ok"
