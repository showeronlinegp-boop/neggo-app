# Backup semanal de la base en Drive

El servicio `db-backup` hace un `pg_dump` de `neggo_app` (incluye el schema de Evolution) y lo copia a una carpeta de Google Drive los viernes a las 15, hora de Argentina. Si ese viernes la PC está apagada, el backup se hace la primera vez que la vuelven a prender. En el disco y en Drive quedan las últimas 8 copias.

El dump tiene precios, pedidos, usuarios y las claves de scraping que estén en la base. La carpeta de Drive tiene que ser de alguien de la empresa, no un link público.

## Una sola vez

1. En Google Drive, creá una carpeta (por ejemplo `Neggo backups`). El id es lo que queda en la URL después de `/folders/`.
2. En Google Cloud, creá un service account con la API de Drive habilitada y descargá el JSON.
3. Compartí la carpeta con el email del service account, como editor. Sin eso, Drive rechaza la subida: el service account no tiene cuota propia.
4. Guardá el JSON en `secrets/drive-sa.json` (esa carpeta no se commitea).
5. En `.env`:

```
DRIVE_FOLDER_ID=el_id_de_la_carpeta
```

6. Levantá el servicio. El viernes a las 15 hace el backup. Si la PC está prendida antes, espera esa hora. Si ese viernes estaba apagada, lo hace al encenderla.

```
docker compose up -d db-backup
```

Para forzarlo ahora, sin esperar al viernes: en la app, **Admin → Backup de la base → Hacer backup ahora** (solo admin). El servicio lo toma en unos 10 segundos y la tarjeta muestra el resultado. También desde la terminal:

```
docker compose exec db-backup backup-db.sh
```

El botón no ejecuta nada en el backend: deja un pedido en `volumes/backups/.manual-request`, que `db-backup` toma y responde en `.manual-status`. Por eso el backend monta esa carpeta.

Si Drive responde, el archivo `neggo_app_AAAA-MM-DD.dump` aparece en la carpeta. El log queda en `volumes/backups/backup.log`.

## Restaurar

Pará lo que usa la base, restaurá y volvé a prenderlo. Esto reemplaza los datos actuales.

```
docker compose stop backend scraper-worker evolution
docker compose exec -e RESTORE_CONFIRM=si db-backup restore-db.sh /backups/neggo_app_AAAA-MM-DD.dump
docker compose start backend scraper-worker evolution
```

Para traer una copia que solo está en Drive:

```
docker compose exec db-backup rclone copyto drive:neggo_app_AAAA-MM-DD.dump /backups/neggo_app_AAAA-MM-DD.dump --config /backups/.rclone.conf
```

Ese config existe mientras corre un backup. Si no está, repetí `backup-db.sh` o armá el remoto con el mismo JSON y el mismo id de carpeta.
