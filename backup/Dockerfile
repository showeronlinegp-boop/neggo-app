FROM postgres:15-alpine

RUN apk add --no-cache rclone tzdata

COPY backup-db.sh backup-if-due.sh restore-db.sh /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/backup-db.sh /usr/local/bin/backup-if-due.sh /usr/local/bin/restore-db.sh /usr/local/bin/entrypoint.sh

ENV TZ=America/Argentina/Buenos_Aires \
    BACKUP_DIR=/backups \
    BACKUP_KEEP=8 \
    BACKUP_EVERY_DAYS=7 \
    PGHOST=postgres \
    PGUSER=neggo \
    PGDATABASE=neggo_app

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
