#!/bin/sh
# Restaura un dump sobre neggo_app. Reemplaza los datos actuales.
# Antes hay que parar backend, scraper-worker y evolution, que usan la base.
#
#   docker compose stop backend scraper-worker evolution
#   docker compose exec db-backup restore-db.sh /backups/neggo_app_2026-10-20.dump
#   docker compose start backend scraper-worker evolution

set -eu

if [ "${RESTORE_CONFIRM:-}" != "si" ]; then
    echo "Esto reemplaza los datos de ${PGDATABASE:-neggo_app}."
    echo "Para seguir: RESTORE_CONFIRM=si $0 <archivo.dump>"
    exit 1
fi

DUMP=${1:-}
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
    echo "Pasá la ruta de un dump que exista. Ejemplo: /backups/neggo_app_2026-10-20.dump"
    exit 1
fi

PG_RESTORE=${PG_RESTORE:-pg_restore}
PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-neggo}
PGDATABASE=${PGDATABASE:-neggo_app}

echo "Restaurando ${DUMP} en ${PGDATABASE}@${PGHOST}"
"$PG_RESTORE" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --clean --if-exists --no-owner --no-acl "$DUMP"
echo "Restauración terminada"
