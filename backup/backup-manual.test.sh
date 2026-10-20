#!/bin/sh
# Prueba el pedido manual desde la app sin Postgres ni Drive: toma el pedido,
# deja el estado en JSON y se recupera si el servicio se cortó en el medio.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/backups" "$TMP/bin"
export BACKUP_DIR="$TMP/backups"

cat > "$TMP/bin/ok" <<'EOF'
#!/bin/sh
[ -f "$BACKUP_DIR/.manual-running" ] || { echo "el pedido no quedó tomado mientras corre"; exit 1; }
echo "2026-10-20 10:00:00 Backup en Drive listo"
EOF
cat > "$TMP/bin/falla" <<'EOF'
#!/bin/sh
echo '2026-10-20 10:00:00 Falta DRIVE_FOLDER_ID o el archivo "/secrets/drive-sa.json". Ver backup/README.md.'
exit 1
EOF
chmod 755 "$TMP/bin/ok" "$TMP/bin/falla"

fail() {
    echo "❌ $*"
    exit 1
}

estado() {
    sed -n 's/.*"estado":"\([a-z]*\)".*/\1/p' "$BACKUP_DIR/.manual-status"
}

# Sin pedido no hace nada
BACKUP_BIN="$TMP/bin/ok" sh "$ROOT/backup-manual.sh"
[ ! -f "$BACKUP_DIR/.manual-status" ] || fail "sin pedido no tiene que escribir estado"

# Pedido que sale bien
echo '{}' > "$BACKUP_DIR/.manual-request"
BACKUP_BIN="$TMP/bin/ok" sh "$ROOT/backup-manual.sh"
[ "$(estado)" = ok ] || fail "esperaba ok, quedó $(estado)"
[ ! -f "$BACKUP_DIR/.manual-request" ] || fail "el pedido tiene que consumirse"
[ ! -f "$BACKUP_DIR/.manual-running" ] || fail "no tiene que quedar tomado"
grep -q '"fin":[0-9]' "$BACKUP_DIR/.manual-status" || fail "falta la hora de fin"
grep -q 'Backup pedido desde la app' "$BACKUP_DIR/backup.log" || fail "falta el log del pedido"

# Pedido que falla: el mensaje es la última línea del log, sin comillas
echo '{}' > "$BACKUP_DIR/.manual-request"
BACKUP_BIN="$TMP/bin/falla" sh "$ROOT/backup-manual.sh"
[ "$(estado)" = error ] || fail "esperaba error, quedó $(estado)"
grep -q '"mensaje":"Falta DRIVE_FOLDER_ID o el archivo /secrets/drive-sa.json. Ver backup/README.md."' "$BACKUP_DIR/.manual-status" \
    || fail "mensaje de error mal armado: $(cat "$BACKUP_DIR/.manual-status")"

# Se cortó en el medio: queda error y se puede volver a pedir
touch "$BACKUP_DIR/.manual-running"
BACKUP_BIN="$TMP/bin/ok" sh "$ROOT/backup-manual.sh"
[ "$(estado)" = error ] || fail "un corte tiene que quedar como error"
grep -q 'se reinició el servicio' "$BACKUP_DIR/.manual-status" || fail "falta el motivo del corte"
[ ! -f "$BACKUP_DIR/.manual-running" ] || fail "el corte no se limpió"

echo "✅ backup-manual: todos los casos pasan"
