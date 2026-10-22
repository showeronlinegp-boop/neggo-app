# API del agente (Grok Bot)

API REST para que Grok Bot haga el seguimiento por WhatsApp de los **clientes nuevos** de Neggo: un mensaje el día 1, el día 7 y el día 15 después de la primera compra.

- Va bajo `/api/agente`. Especificación completa en `GET /api/agente/openapi.json` y Swagger UI en `GET /api/agente/docs`. Las dos son públicas y no tienen datos.
- **No escribe nada en Odoo.** Lee Odoo y la base local. Solo escribe en `crm_bot_seguimiento`, `crm_bot_interacciones` y `crm_bot_feedback`, y en `crm_events` cuando un cliente pide que no le escriban.
- Código: `backend/routes/agente.js`, `backend/services/agenteService.js`, `agenteNuevos.js` (cálculo y cadencia, lógica pura) y `agenteValidacion.js`. Migraciones `048_agente_bot.sql` y `049_agente_envios.sql`.

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

## La cadencia la calcula la API

- **Día N** = fecha de la primera compra + N, en hora de Argentina. Si el cliente vuelve a comprar, la cadencia sigue igual.
- Cada mensaje se puede mandar en un rango de días:

  | Mensaje | Días |
  |---|---|
  | `dia_1` | 1 a 6 |
  | `dia_7` | 7 a 14 |
  | `dia_15` | 15 a 20 |

  El margen cubre fines de semana y feriados. Si el cliente entra tarde (por ejemplo, el día 9), le toca el mensaje de ese rango y los anteriores se saltean.
- Cada cliente trae `toca_hoy` (`dia_1`, `dia_7`, `dia_15` o `null`), `dias_desde_compra` y `puede_enviar_ahora`. Este último vale `true` si le toca algo, tiene teléfono válido y estamos en horario.
- `seguimiento.etapa` es la **última etapa enviada**: `pendiente` (todavía nada) → `dia_1` → `dia_7` → `dia_15`. `finalizado` quiere decir que la cadencia está cerrada (no contactar, o la cerró el equipo).
- **Horario de envío:** lunes a viernes de 9 a 18, hora de Argentina. Fuera de ese horario, `POST envios` devuelve 409.
- La ventana de `clientes/nuevos` es de **21 días** por defecto, para que el día 15 no se pierda.

## Envíos sin duplicados

`POST /clientes/{id}/envios` con `{ etapa, mensaje, id_externo }` hace todo en una transacción:

1. Chequea el horario, que el cliente no haya pedido no recibir mensajes y que la etapa sea la que le toca hoy.
2. Guarda el mensaje.
3. Avanza la etapa, actualiza el último contacto y calcula la próxima acción.

- Si se reintenta con el mismo `id_externo`, devuelve lo ya guardado con 200 y `repetido: true`, y no lo duplica.
- Cada etapa se registra una sola vez por cliente (lo garantiza un índice único).

`POST /clientes/{id}/interacciones` queda para la conversación: las respuestas del cliente (`recibido`) y lo que Grok contesta fuera de la cadencia. Acepta `id_externo` opcional para no duplicar.

## No contactar

- `PATCH /clientes/{id}` con `no_contactar: true` pone la etapa en `finalizado`, borra la próxima acción y deja una nota en la ficha del cliente en el CRM.
- Desde ahí, todo envío da 409 y la etapa no se puede reabrir.
- **El agente no lo puede desmarcar** (409). Lo hace el equipo.
- Las respuestas de WhatsApp las recibe Grok en su propio WhatsApp. Detectar un "no me escriban más" es tarea de Grok, que en ese caso lo marca.
- Antes de cada mensaje, Grok vuelve a pedir `GET /clientes/{id}`, que está en vivo y sin caché.

## Otras reglas

- **Compra** = ticket del POS de Neggo en `paid`, `done` o `invoiced`, con la misma definición que el CRM. Si varios tickets cobran el mismo pedido de venta (seña y saldo), son **una sola compra**. Cada compra trae `vendedor` y `formas_pago`.
- Quedan afuera "Consumidor Final", "RMA" y los tickets sin cliente. Preventas no cuenta.
- **Rubro:** es el del **módulo comercial** (Clientes): la categoría en la que más compró en los últimos 12 meses. Si el cliente todavía no está en el cálculo diario (compró por primera vez hoy), se calcula con la misma regla. `categorias_compradas` muestra el reparto por rubro con porcentajes.
- **Precios:** son el precio final, con IVA incluido.
- **Productos:** se ordenan por los más vendidos de los últimos 90 días. `excluir_compras_de={cliente}` saca lo que el cliente ya compró y `solo_publicados=true` deja los que tienen link e imagen. Vienen `product_id`, que es el mismo id que los productos de las compras, y `template_id`, que es el de la URL y la imagen. Los nombres llegan sin el código interno `[BB88150]`.
- **Stock:** Neggo no lleva stock en Odoo (archivar = agotado). `stock: true` quiere decir "disponible".
- `clientes/nuevos` lee las compras en vivo de Odoo con una caché de 5 minutos (`?refresh=1` la saltea). La etapa, `no_contactar` y `toca_hoy` se leen siempre al momento. Por defecto no vienen los que pidieron no recibir mensajes (`no_contactar=todos` trae a todos). Con `para_hoy=true` vienen solo los que tienen un mensaje para hoy. El orden es estable: fecha de primera compra desc y después id.
- Fechas en hora de Argentina (UTC−3): `YYYY-MM-DD` y datetimes `2026-10-22T10:15:00-03:00`. `ultimo_contacto` nunca retrocede.
- Textos en UTF-8. Si llegan con caracteres rotos, se rechazan con 422.
- `telefono: null` quiere decir que el número de Odoo no es un celular válido: no se le escribe. `contacto: null` quiere decir que no se sabe el nombre de la persona: se saluda sin nombre.

## Errores

| Código | Cuándo |
|---|---|
| 401 | Falta la API key o es incorrecta |
| 404 | Cliente o ruta inexistente |
| 409 | No contactar, fuera de horario, la etapa no es la que toca, ya se envió o un cambio de etapa no permitido |
| 422 | Validación: `details` es `[{ campo, error }]` |
| 502 | Odoo no responde (`No pude leer Odoo`) |
| 503 | `AGENTE_API_KEY` sin configurar |
| 500 | Cualquier otro error |

## Ejemplos curl

```bash
API=http://localhost:3000/api/agente
KEY=tu_api_key

# A quién le toca un mensaje hoy
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/nuevos?para_hoy=true"

# Ficha en vivo, justo antes de mandar
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/123"

# Registrar el mensaje del día 7 (reintentar con el mismo id_externo no duplica)
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"etapa":"dia_7","mensaje":"¡Hola José! ¿Cómo te fue con...?","id_externo":"grok-123-dia_7"}' \
  "$API/clientes/123/envios"

# Respuesta del cliente
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tipo":"recibido","mensaje":"Bien, gracias","id_externo":"wa-3EB0C1"}' \
  "$API/clientes/123/interacciones"

# Productos más vendidos del rubro, sin lo que ya compró, publicados
curl -s -H "Authorization: Bearer $KEY" "$API/productos?rubro=Librer%C3%ADa&excluir_compras_de=123&solo_publicados=true"

# El cliente pidió que no le escriban más
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"no_contactar":true}' "$API/clientes/123"

# Guardar el nombre de la persona con la que se habla
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"contacto":"José Pérez"}' "$API/clientes/123"

# Cerrar la cadencia a mano
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"etapa":"finalizado"}' "$API/clientes/123/seguimiento"

# Feedback del agente sobre la API, y leerlo
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tipo":"falta","endpoint":"/productos","mensaje":"Me sirve el precio por bulto"}' "$API/feedback"
curl -s -H "Authorization: Bearer $KEY" "$API/feedback"
```

En Windows, `curl` manda los argumentos de `-d` en la codificación de la consola y las tildes llegan rotas (la API responde 422). Para probar textos con tildes, guardá el JSON en un archivo UTF-8 y mandalo con `--data-binary @archivo.json`.

## Cómo lo usa Grok

Flujo diario, de lunes a viernes de 9 a 18:

1. Pide `clientes/nuevos?para_hoy=true`.
2. Para cada cliente con `puede_enviar_ahora: true`:
   1. Pide `GET clientes/{id}` para confirmar `toca_hoy` y `no_contactar` al momento.
   2. Arma el mensaje con las compras, el `rubro` y `categorias_compradas`. Para el día 15 pide `productos?rubro=<rubro>&excluir_compras_de=<id>&solo_publicados=true`.
   3. Manda el WhatsApp.
   4. Hace `POST clientes/{id}/envios` con `etapa = toca_hoy` y un `id_externo` propio. Si falla, reintenta con el mismo `id_externo`.
3. Cuando el cliente contesta, hace `POST interacciones` con `tipo: "recibido"`. Si se presenta, guarda su nombre con `PATCH clientes/{id}` (`contacto`).
4. Si el cliente pide que no le escriban, hace `PATCH clientes/{id}` con `no_contactar: true`.
5. Si un dato no le alcanza o algo no anda, lo cuenta en `POST feedback`.
