# API del agente (Grok Bot)

API REST para que Grok Bot haga el seguimiento por WhatsApp de los **clientes nuevos**: los que hicieron su primera compra en los últimos N días (15 por defecto).

- Va bajo `/api/agente`. Especificación completa en `GET /api/agente/openapi.json` y Swagger UI en `GET /api/agente/docs`. Las dos son públicas y no tienen datos.
- **No escribe nada en Odoo.** Lee Odoo y la base local. Solo escribe en `crm_bot_seguimiento`, `crm_bot_interacciones` y `crm_bot_feedback`, y en `crm_events` cuando un cliente pide que no le escriban.
- Código: `backend/routes/agente.js`, `backend/services/agenteService.js`, `agenteNuevos.js` (cálculo puro) y `agenteValidacion.js`. Migración `048_agente_bot.sql`.

## Configuración

En el `.env`:

```
# Generar con: openssl rand -hex 32
AGENTE_API_KEY=...
# Opcional: base del link a la tienda (si no, usa ODOO_URL)
WHATSAPP_SHOP_URL=
```

Sin `AGENTE_API_KEY`, o con menos de 32 caracteres, todos los endpoints de datos responden **503** (`API del agente deshabilitada`). Así nunca queda abierta. Después de cambiar la clave hay que recrear el backend (`docker compose up -d backend`) y recargar nginx.

Cómo la alcanza Grok (red local o Cloudflare Tunnel) está fuera de este cambio.

## Reglas que conviene saber

- **Compra** = ticket del POS de Neggo en `paid`, `done` o `invoiced`, con la misma definición que el CRM. Si varios tickets cobran el mismo pedido de venta (seña y saldo), son **una sola compra**: la fecha es la del primer ticket y el monto, la suma.
- **Cliente nuevo** = la fecha mínima (hora de Argentina) de sus compras, en toda la historia, es `>= hoy - (dias - 1)`. Con `dias=15` y hoy 22/10, entran los que compraron por primera vez del 08/10 en adelante.
- Quedan afuera "Consumidor Final", "RMA" y los tickets sin cliente. Preventas no cuenta.
- `clientes/nuevos` se calcula **en vivo contra Odoo**, con caché de 5 minutos. `?refresh=1` la saltea.
- **Stock:** Neggo no lleva stock en Odoo (archivar = agotado). En `productos`, `stock: true` quiere decir "disponible" (activo y no archivado). Sin el parámetro vienen solo los disponibles. `stock=false` trae los agotados.
- `rubro` del cliente es la categoría en la que más compró. Sirve tal cual para `productos?rubro=` (se ignoran tildes y "de").
- Fechas en hora de Argentina (UTC−3): `YYYY-MM-DD` y datetimes `2026-10-22T10:15:00-03:00`. Un datetime sin offset se toma como hora de Argentina.
- Textos en UTF-8. Si llegan con caracteres rotos (por ejemplo Latin-1), se rechazan con 422 para no guardar tildes rotas.

## Errores

| Código | Cuándo |
|---|---|
| 401 | Falta la API key o es incorrecta |
| 404 | Cliente o ruta inexistente |
| 409 | `enviado` a un cliente que pidió no recibir mensajes |
| 422 | Validación: `details` es `[{ campo, error }]` |
| 502 | Odoo no responde (`No pude leer Odoo`) |
| 503 | `AGENTE_API_KEY` sin configurar |
| 500 | Cualquier otro error |

## Ejemplos curl

```bash
API=http://localhost:3000/api/agente
KEY=tu_api_key

# Clientes nuevos de los últimos 15 días que se pueden contactar
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/nuevos?dias=15&no_contactar=false"

# Los que están en el día 7
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/nuevos?etapa=dia_7&page=1&limit=20"

# Productos con stock de un rubro
curl -s -H "Authorization: Bearer $KEY" "$API/productos?rubro=Librer%C3%ADa&stock=true"

# Actualizar el seguimiento
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"etapa":"dia_7","ultimo_contacto":"2026-10-17T10:00:00-03:00","proxima_accion":"2026-10-25"}' \
  "$API/clientes/123/seguimiento"

# Registrar un mensaje enviado
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"fecha":"2026-10-17T10:00:00-03:00","tipo":"enviado","etapa":"dia_7","mensaje":"Hola José, ¿qué tal te fue con...?","respuesta":null}' \
  "$API/clientes/123/interacciones"

# Historial de mensajes
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/123/interacciones?page=1&limit=50"

# El cliente pidió que no le escriban más
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"no_contactar":true}' "$API/clientes/123"

# Guardar el nombre de la persona con la que se habla
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"contacto":"José Pérez"}' "$API/clientes/123"

# Feedback del agente sobre la API, y leerlo
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tipo":"falta","endpoint":"/productos","mensaje":"Me sirve tener el stock real"}' "$API/feedback"
curl -s -H "Authorization: Bearer $KEY" "$API/feedback"
```

En Windows, `curl` manda los argumentos de `-d` en la codificación de la consola y las tildes llegan rotas (la API responde 422). Para probar textos con tildes, guardá el JSON en un archivo UTF-8 y mandalo con `--data-binary @archivo.json`.

## Cómo lo usa Grok

Flujo diario:

1. Pide `clientes/nuevos?no_contactar=false`.
2. Para cada cliente, decide el mensaje según `fecha_primera_compra` y `seguimiento.etapa`: `pendiente` → día 1, `dia_1` → día 7, `dia_7` → día 15, `dia_15` → `finalizado`.
3. Para las recomendaciones del día 15, pide `productos?rubro=<rubro del cliente>&stock=true`.
4. Después de enviar, hace `POST interacciones` (`tipo: "enviado"`) y `PATCH seguimiento` con la etapa nueva y la `proxima_accion`.
5. Cuando el cliente contesta, hace `POST interacciones` con `tipo: "recibido"`. Si se presenta, guarda su nombre con `PATCH clientes/{id}` (`contacto`).
6. Si el cliente pide que no le escriban, hace `PATCH clientes/{id}` con `no_contactar: true`. Desde ahí, un `enviado` da 409.
7. Si un dato no le alcanza o algo no anda, lo cuenta en `POST feedback`.

## Probar la API con Grok

Para que Grok la evalúe y diga qué cambiaría:

1. Pasale la especificación (`/api/agente/openapi.json`) y una muestra de respuestas reales, con nombres y teléfonos cambiados.
2. Pedile que la recorra como si hiciera el flujo diario y que devuelva una lista de lo que le falta, lo que no se entiende y lo que cambiaría, cada cosa con `tipo` (`falta`, `error`, `mejora`, `comentario`) y `endpoint`.
3. Cuando ya pueda llamar a la API, que mande esa lista a `POST /api/agente/feedback`, y se lee con `GET /api/agente/feedback`.
