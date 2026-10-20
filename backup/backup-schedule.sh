#!/bin/sh
# Viernes 15:00, hora de TZ (Argentina en el contenedor).
# Si a esa hora la PC está apagada, el turno sigue pendiente hasta que la prenden.
# Se puede forzar el momento en pruebas con BACKUP_NOW (epoch).

backup_plan() {
    TZ=${TZ:-America/Argentina/Buenos_Aires}
    export TZ
    hour=${BACKUP_HOUR:-15}
    wday=${BACKUP_WDAY:-5}
    retry=${BACKUP_RETRY_SECONDS:-3600}
    now=${BACKUP_NOW:-$(date +%s)}
    marker=${MARKER:-${BACKUP_DIR:-/backups}/.last-success}

    dow=$(date -d "@$now" +%u)
    day=$(date -d "@$now" +%Y-%m-%d)
    day_start=$(date -d "$day 00:00:00" +%s)
    if [ "$dow" -le "$wday" ]; then
        this_slot=$(( day_start + (wday - dow) * 86400 + hour * 3600 ))
    else
        this_slot=$(( day_start - (dow - wday) * 86400 + hour * 3600 ))
    fi
    if [ "$now" -lt "$this_slot" ]; then
        slot=$(( this_slot - 7 * 86400 ))
        next=$this_slot
    else
        slot=$this_slot
        next=$(( this_slot + 7 * 86400 ))
    fi

    DUE=no
    REASON=espera
    if [ -n "${DRIVE_FOLDER_ID:-}" ] && [ -f "${DRIVE_SA_FILE:-/secrets/drive-sa.json}" ]; then
        if [ ! -f "$marker" ]; then
            if [ "$now" -ge "$this_slot" ]; then
                DUE=yes
                REASON=primero
            fi
        else
            marker_time=$(date -r "$marker" +%s)
            if [ "$marker_time" -lt "$slot" ]; then
                DUE=yes
                REASON=atrasado
            else
                REASON=hecho
            fi
        fi
    else
        REASON=sin-drive
    fi

    if [ "$DUE" = yes ] || [ "$REASON" = sin-drive ]; then
        WAIT=$retry
    else
        WAIT=$(( next - now ))
        if [ "$WAIT" -lt 60 ]; then
            WAIT=60
        fi
    fi
    SLOT=$slot
    NEXT=$next
}

if [ "${0##*/}" = "backup-schedule.sh" ]; then
    backup_plan
    printf '%s\n' "$WAIT"
fi
