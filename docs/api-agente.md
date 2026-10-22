# API del agente (Grok Bot)

API REST para que Grok Bot haga el seguimiento por WhatsApp de los **clientes nuevos** de Neggo: un mensaje el día 1, el día 7 y el día 15 después de la primera compra.

- Va bajo `/api/agente`. Especificación completa en `GET /api/agente/openapi.json` y Swagger UI en `GET /api/agente/docs`. Las dos son públicas y no tienen datos.
- **No escribe nada en Odoo.** Lee Odoo y la base local. Solo escribe en `crm_bot_seguimiento`, `crm_bot_interacciones` y `crm_bot_feedback`, y en `crm_events` cuando un cliente pide que no le escriban.
- Código: `backend/routes/agente.js`, `backend/services/agenteService.js`, `agenteNuevos.js` (cálculo y cadencia, lógica pura) y `agenteValidacion.js`. Migraciones `048_agente_bot.sql`, `049_agente_envios.sql` y `050_agente_reservas.sql`.

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
- Cada cliente trae `toca_hoy` (`dia_1`, `dia_7`, `dia_15` o `null`), `vence` (el último día para mandarlo), `dias_desde_compra`, `respuesta_pendiente` y `puede_enviar_ahora`. Este último vale `true` si le toca algo, tiene teléfono válido, no hay una respuesta sin atender y estamos en horario.
- `seguimiento.etapa` es la **última etapa enviada**: `pendiente` (todavía nada) → `dia_1` → `dia_7` → `dia_15`. `finalizado` quiere decir que la cadencia está cerrada (no contactar, o la cerró el equipo).
- **Horario de envío:** lunes a viernes de 9 a 18, hora de Argentina. No se tienen en cuenta los feriados (decisión del equipo). Fuera de ese horario, la reserva devuelve 409 `fuera_de_horario`, y `meta.abre_a` dice cuándo vuelve a abrir.
- La ventana de `clientes/nuevos` es de **21 días** por defecto, para que el día 15 no se pierda.

## Envío en dos pasos

Así un mensaje no sale sin poder registrarse:

1. **Reservar:** `POST /clientes/{id}/envios` con `{ etapa, mensaje, id_externo, productos_recomendados }`.
   - Valida todo con la hora del servidor: horario, no contactar, teléfono, respuesta pendiente, que la etapa sea la que toca y que no se haya enviado ni esté reservada.
   - Bloquea la etapa durante 10 minutos (`reservado_hasta`).
2. **Mandar el WhatsApp.** El bot de envío puede consultar `GET /envios/{id_externo}`:
   - `reservado`: lo puede mandar.
   - `enviado`: ya salió, no lo tiene que repetir.
   - `cancelado` o `vencido`: no lo tiene que mandar.
3. **Confirmar** con `POST /envios/{id_externo}/confirmar`. Guarda la hora del servidor, avanza la etapa y calcula la próxima acción. Se confirma aunque la reserva haya vencido o el cliente haya pedido no contactar en el medio: el mensaje salió y tiene que quedar registrado. Si el WhatsApp no salió, `POST /envios/{id_externo}/cancelar` libera la etapa.

Todos los pasos se pueden reintentar con el mismo `id_externo` y el mismo contenido: devuelven lo ya hecho con `repetido: true` y no duplican nada. Un índice único impide tener dos reservas o envíos activos de la misma etapa.

- Si se repite el `id_externo` con otro mensaje, otra etapa u otros productos, la API responde 409 `id_externo_distinto`.
- Una reserva cancelada (409 `reserva_cancelada`) o vencida (409 `reserva_vencida`) no se reusa: hay que reservar con un `id_externo` nuevo.
- Si el cliente pide no contactar mientras tiene una reserva activa, la reserva pasa a `cancelado` con `motivo_cancelacion: no_contactar` y el bot no la manda. Si ya la había mandado, se puede confirmar igual.
- La ficha muestra `reserva_activa`, y mientras exista, `puede_enviar_ahora` es false.
- Confirmar y cancelar responden 200; `repetido` dice si ya estaba hecho.
- `AGENTE_RESERVA_SEGUNDOS` acorta el tiempo de la reserva para pruebas (por defecto, 600).

`POST /clientes/{id}/interacciones` queda para la conversación: las respuestas del cliente (`recibido`) y lo que Grok contesta fuera de la cadencia. Acepta `id_externo` opcional para no duplicar.

**Respuesta pendiente:** si el cliente contestó después del último mensaje enviado, no se puede reservar el siguiente (409 `respuesta_pendiente`). Grok primero contesta, o marca la respuesta como revisada con `POST /clientes/{id}/revisado`. El filtro `clientes/nuevos?con_respuesta_pendiente=true` trae a los que contestaron.

## No contactar

- `PATCH /clientes/{id}` con `no_contactar: true` pone la etapa en `finalizado`, borra la próxima acción y deja una nota en la ficha del cliente en el CRM.
- Desde ahí, todo envío da 409 y la etapa no se puede reabrir.
- **El agente no lo puede desmarcar** (409). Lo hace el equipo.
- Las respuestas de WhatsApp las recibe Grok en su propio WhatsApp. Detectar un "no me escriban más" es tarea de Grok, que en ese caso lo marca.
- Antes de cada mensaje, Grok vuelve a pedir `GET /clientes/{id}`, que está en vivo y sin caché.

## Otras reglas

- **Compra** = ticket del POS de Neggo en `paid`, `done` o `invoiced`, con la misma definición que el CRM. Si varios tickets cobran el mismo pedido de venta (seña y saldo), son **una sola compra**. Cada compra trae `vendedor` y `formas_pago`. El `monto` es lo que se cobró en el ticket: incluye señas y envíos, que no aparecen en `productos` (ahí solo van los productos físicos).
- Quedan afuera "Consumidor Final", "RMA" y los tickets sin cliente. Preventas no cuenta.
- **Rubro:** es el del **módulo comercial** (Clientes): la categoría en la que más compró en los últimos 12 meses. Si el cliente todavía no está en el cálculo diario (compró por primera vez hoy), se calcula con la misma regla. `categorias_compradas` muestra el reparto por rubro con porcentajes.
- **Precios:** son el precio final, con IVA incluido.
- **Productos:** se ordenan por facturación de los últimos 90 días (`orden=vendidos` ordena por unidades). `rubro` acepta hasta 5 rubros separados por coma; uno que no existe da 422 con la lista de los válidos. `precio_min` filtra por precio. `excluir_compras_de={cliente}` saca lo que el cliente ya compró y `solo_publicados=true` deja los que tienen link e imagen. Cada producto trae `precio_actualizado`, que es cuándo se leyó el precio de Odoo. En Odoo no hay presentación mayorista (bulto, cantidad mínima): si existe, está en el nombre. Vienen `product_id`, que es el mismo id que los productos de las compras, y `template_id`, que es el de la URL y la imagen. Los nombres llegan sin el código interno `[BB88150]`.
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
| 409 | La operación no corresponde (ver `codigo`) |
| 422 | Validación: `details` es `[{ campo, error }]` |
| 502 | Odoo no responde (`No pude leer Odoo`) |
| 503 | `AGENTE_API_KEY` sin configurar |
| 500 | Cualquier otro error |

Todos los errores traen `codigo`, que es estable:

- **En los 409:** `fuera_de_horario`, `no_contactar`, `sin_telefono`, `respuesta_pendiente`, `etapa_no_corresponde`, `ya_enviado`, `etapa_reservada`, `reserva_cancelada`, `reserva_vencida`, `transicion_invalida`, `id_externo_usado`, `id_externo_distinto`.
- **El resto:** `api_key_invalida`, `no_encontrado`, `datos_invalidos`, `odoo_caido`, `deshabilitada`, `error_interno`.

## Ejemplos curl

```bash
API=http://localhost:3000/api/agente
KEY=tu_api_key

# A quién le toca un mensaje hoy
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/nuevos?para_hoy=true"

# Ficha en vivo, justo antes de mandar
curl -s -H "Authorization: Bearer $KEY" "$API/clientes/123"

# 1) Reservar el mensaje del día 7 (reintentar con el mismo id_externo no duplica)
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"etapa":"dia_7","mensaje":"¡Hola José! ¿Cómo te fue con...?","id_externo":"grok-123-dia_7","productos_recomendados":[33882]}' \
  "$API/clientes/123/envios"

# 2) El bot de WhatsApp chequea antes de mandar
curl -s -H "Authorization: Bearer $KEY" "$API/envios/grok-123-dia_7"

# 3) Salió: confirmar. Si no salió: cancelar
curl -s -X POST -H "Authorization: Bearer $KEY" "$API/envios/grok-123-dia_7/confirmar"
curl -s -X POST -H "Authorization: Bearer $KEY" "$API/envios/grok-123-dia_7/cancelar"

# El cliente contestó y no hace falta responder: marcar revisado
curl -s -X POST -H "Authorization: Bearer $KEY" "$API/clientes/123/revisado"

# Respuesta del cliente
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tipo":"recibido","mensaje":"Bien, gracias","id_externo":"wa-3EB0C1"}' \
  "$API/clientes/123/interacciones"

# Productos que más facturan de sus 2 rubros principales, sin lo que ya compró, publicados
curl -s -H "Authorization: Bearer $KEY" "$API/productos?rubro=Tecnolog%C3%ADa,Bazar&excluir_compras_de=123&solo_publicados=true&precio_min=3000"

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

1. Pide `clientes/nuevos?para_hoy=true` y ordena por `vence`, para atender primero a los que se les termina el rango.
2. Atiende a los que tienen `respuesta_pendiente`: contesta (`POST interacciones`, `enviado`) o marca `POST clientes/{id}/revisado`.
3. Para cada cliente con `puede_enviar_ahora: true`:
   1. `GET clientes/{id}` para confirmar al momento.
   2. Arma el mensaje con las compras, el `rubro` y `categorias_compradas`. Para el día 15 pide `productos?rubro=<sus 2 o 3 rubros>&excluir_compras_de=<id>&solo_publicados=true`.
   3. Reserva con `POST clientes/{id}/envios` (`etapa = toca_hoy`, `id_externo` propio, `productos_recomendados`).
   4. Manda el WhatsApp, solo si la reserva dio 201 o 200.
   5. Confirma con `POST envios/{id_externo}/confirmar`. Si no salió, cancela.
4. Cuando el cliente contesta, hace `POST interacciones` con `tipo: "recibido"`. Si se presenta, guarda su nombre con `PATCH clientes/{id}` (`contacto`).
5. Si el cliente pide que no le escriban, hace `PATCH clientes/{id}` con `no_contactar: true`.
6. Si un dato no le alcanza o algo no anda, lo cuenta en `POST feedback`.
