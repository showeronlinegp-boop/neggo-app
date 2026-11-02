# Pedido de diseño: seguimiento de "clientes importantes" — API del agente de Neggo (3.1.0 → 3.2.0)

**Para:** Claude (implementación) · **De:** Mariano Menendez, Neggo Mayorista (Pergamino) · **Fecha:** 29/10/2026
**Base:** `http://localhost/api/agente` (corre en mi PC, lee de Odoo `neggo.odoo.com`). Spec actual: `openapi-local.json` ("API del agente de Neggo (Grok Bot) 3.1.0").

## 0. Qué hay hoy y qué no se toca
Hoy solo existe `GET /clientes/nuevos` (primera compra en los últimos N días) con la cadencia fija `Etapa` = `pendiente | dia_1 | dia_7 | dia_15 | finalizado`, más reservar/confirmar/cancelar (`POST /clientes/{id}/envios`, `/envios/{id_externo}/confirmar|cancelar`), `interacciones`, `revisado`, `PATCH /clientes/{id}` y `PATCH /clientes/{id}/seguimiento`.

Reglas que **siguen igual** y aplican también a lo nuevo:
- Nada sale sin mi OK. La API solo reserva y registra; no manda WhatsApp.
- La reserva dura **10 min** (`reservado_hasta`); vencida o cancelada no se reusa.
- Un `id_externo` cancelado no se puede volver a usar (`id_externo_usado`). Formato: `grok-<cliente>-<etapa>-AAAAMMDD`.
- Se rechaza el texto que mencione **IVA** (`datos_invalidos`). Montos siempre finales, sin hablar de IVA.
- `productos_recomendados` = array de enteros (`product_id` de `/productos`), máx. 20.
- Envíos por WhatsApp, **uno cada ~15 min**, en la ventana de `Meta.ventana_envio`.
- Mismo sobre de respuesta (`success`, `data`, `meta`, `paginacion`) y mismo `Error`/`ErrorValidacion`.

**Corrección incluida:** hoy `confirmar` guarda la hora del confirm, no la del envío real. Agregar `enviado_at` (date-time, opcional, no futuro, ≥ hora de reserva − 1 min) en el body de `POST /envios/{id_externo}/confirmar`. Si viene, es la fecha del envío y de `ultimo_contacto`; si no, queda como hoy. La `Interaccion` devuelve `enviado_at` y `confirmado_at` por separado.

## 1. Definición de "cliente importante"
`importante = (monto_acumulado OR pedido_grande OR fijo) AND NOT excluido`, donde:
- **`monto_acumulado`**: suma de `Compra.monto` (mismas reglas que hoy: sin "Down Payment (POS)" duplicado, `venta-<pedido>` agrupa seña y saldo) en los últimos `dias` (default 60) ≥ `monto_minimo` (default $1.000.000; "llega a" = **≥**, así que $1.000.000 justos cuenta).
- **`pedido_grande`**: alguna `Compra` individual (un ticket `pos-…` o un pedido `venta-…` con seña y saldo sumados) con `monto` **>** `monto_pedido_minimo` en los últimos `dias_pedido` (default 60).
- **`manual`**: marcado a mano como `fijo`.
- `excluido` gana siempre: no aparece aunque cumpla los otros criterios.

Parámetros con default en config (`config/importantes.json` o equivalente, editable sin tocar código):

| Clave | Default | Nota |
|---|---|---|
| `dias` | **60** (definido por Mariano) | ventana del acumulado y de la tendencia; válido 1–730 |
| `monto_minimo` | **1000000** ($, definido por Mariano) | acumulado ≥ este valor |
| `monto_pedido_minimo` | **500000** ($) | un solo pedido estrictamente mayor |
| `dias_pedido` | **60** | ventana del pedido grande; válido 1–730 (reemplaza `meses_pedido`) |
| `toque_cada_dias` | 30 (default sugerido, Mariano lo puede cambiar) | toque periódico |
| `factor_atraso` | 1,5 (default sugerido, Mariano lo puede cambiar) | alerta si `dias_sin_comprar > intervalo_habitual × factor` |
| `caida_pct` | 30 (default sugerido, Mariano lo puede cambiar) | alerta si tendencia ≤ −30 % |
| `min_compras_intervalo` | 3 | menos compras → sin intervalo habitual |
| `pausa_entre_flujos_dias` | 3 | ver §4 (no duplicar) |

## 2. `GET /clientes/importantes`
Query: `dias` (1–730, default 60), `monto_pedido_minimo` (number ≥ 0, default 500000), `dias_pedido` (1–730, default 60), `motivo` (`monto_acumulado|pedido_grande|manual`, filtra), `monto_minimo` (number ≥ 0) **o** `top` (1–500; si vienen los dos → 400 `datos_invalidos`), `orden` (`monto_desc`* | `dias_sin_comprar_desc` | `tendencia_asc` | `ultima_compra_desc` | `nombre`), `toca_hoy` (bool), `con_respuesta_pendiente` (bool), `no_contactar` (bool), `alerta` (`atraso|caida|ninguna`), `page`, `limit` (máx. 100), `refresh` (como en nuevos).

Schema `ClienteImportante` (reusa campos de `Cliente`, sin `compras` completas para que sea liviano):
```json
{
  "id": 1596, "nombre": "Bazar Las Rosas", "contacto": "Carla", "telefono": "+5492477000000",
  "ciudad": "Pergamino", "rubro": "Bazar",
  "categorias_compradas": [{"rubro": "Bazar", "monto": 812000, "porcentaje": 64}],
  "motivo_importante": ["monto_acumulado", "pedido_grande"], // uno o varios: monto_acumulado | pedido_grande | manual
  "pedidos_grandes": [               // solo si incluye pedido_grande; del más nuevo al más viejo
    {"id": "venta-S00871", "referencia": "S00871", "monto": 612500.00, "fecha": "2026-09-30T11:20:00-03:00"}
  ],
  "marca_manual": null,              // {tipo: fijo|excluido, nota, at} o null
  "ventana": {"dias": 60, "desde": "2026-08-31", "hasta": "2026-10-29"},  // 60 días contando hoy
  "total_comprado": 1268000.00, "cantidad_compras": 9, "ticket_promedio": 140888.89,
  "ultima_compra": "2026-09-30T11:20:00-03:00", "dias_sin_comprar": 29,
  "intervalo_habitual_dias": 18,     // mediana entre compras; null si < min_compras_intervalo
  "tendencia": {"periodo_anterior": 1610000.00, "variacion_pct": -21, "direccion": "baja"}, // sube|estable(±10%)|baja|sin_datos
  "alertas": ["atraso"],             // atraso | caida
  "no_contactar": false, "respuesta_pendiente": false, "reserva_activa": null,
  "en_flujo_nuevos": false,
  "toca_hoy": "atraso",              // null | toque_periodico | atraso | caida
  "motivo_toca_hoy": "29 días sin comprar; compra cada ~18",
  "vence": "2026-10-31", "puede_enviar_ahora": true,
  "seguimiento_importante": {"ultimo_contacto": "2026-09-02T10:05:00-03:00", "ultimo_tipo": "toque_periodico", "proxima_accion": "2026-10-02", "actualizado": "2026-10-29T09:00:00-03:00"}
}
```
`periodo_anterior` = los `dias` (60) inmediatamente previos a la ventana (ej. 2026-07-02 a 2026-08-30). Si cumple solo por pedido grande: `"motivo_importante": ["pedido_grande"]` aunque `total_comprado` < `monto_minimo`. Si es solo `fijo`: `["manual"]` y `pedidos_grandes: []`. Con `top`, el ranking es por `total_comprado` entre todos los que califican.
Respuesta: `{success, data:[...], meta, paginacion, filtros:{dias, monto_minimo|top, monto_pedido_minimo, dias_pedido}}`.

## 3. Marca manual — `PATCH /clientes/{id}/importante`
Body `ImportantePatch` (`additionalProperties:false`): `{"marca": "fijo" | "excluido" | null, "nota": "string ≤ 500, obligatoria si marca != null"}`. `null` quita la marca. Lo puedo hacer yo (a diferencia de `no_contactar`). Guarda `at` y queda en historial (`GET /clientes/{id}` agrega `importante: {es_importante, motivo_importante, pedidos_grandes, marca_manual}`). Errores: 404 `no_encontrado`, 400 `datos_invalidos`. Idempotente: misma marca y nota → 200 `repetido:true`.

## 4. Modelo de seguimiento de importantes (separado de la cadencia de nuevos)
No se agregan valores a `Etapa`. Se agrega `TipoImportante` = `toque_periodico | atraso | caida`, con estado propio `seguimiento_importante` (tabla local aparte).

Reglas de `toca_hoy` (en orden de prioridad, toma la primera):
1. `caida`: `tendencia.variacion_pct ≤ −caida_pct` y no se mandó `caida` en los últimos 30 días.
2. `atraso`: `intervalo_habitual_dias` no null y `dias_sin_comprar > intervalo × factor_atraso`, y no se mandó `atraso` desde su última compra.
3. `toque_periodico`: pasaron `toque_cada_dias` desde el último contacto de cualquier flujo.
Vigencia: `vence` = hoy + 2 días hábiles; si no salió, se recalcula.

**Convivencia con nuevos (sin duplicados):**
- Prioridad: **la cadencia de nuevos gana** mientras el cliente tenga `etapa` distinta de `finalizado` (es más corta y tiene fecha). Mientras tanto `toca_hoy` de importantes = null y `en_flujo_nuevos = true`.
- Un solo mensaje por cliente por día, entre los dos flujos. Y si hubo contacto (de cualquier flujo) en los últimos `pausa_entre_flujos_dias`, importantes no toca.
- Una sola reserva activa por cliente, sin importar el flujo (si hay, `etapa_reservada`).
- `respuesta_pendiente` y `no_contactar` son del cliente, no del flujo: bloquean los dos.

**Integración con el flujo de envíos** (mismos endpoints):
- `EnvioNuevo` pasa a `oneOf`: o `etapa` (dia_1|dia_7|dia_15, igual que hoy) **o** `tipo` (`TipoImportante`); los dos juntos o ninguno → 400. Tiene que coincidir con el `toca_hoy` del flujo; si no, 409 `tipo_no_corresponde`.
- `id_externo`: `grok-<cliente>-<tipo>-AAAAMMDD` (ej. `grok-1596-atraso-20261029`).
- `confirmar` (con `enviado_at` opcional) actualiza `seguimiento_importante`; `cancelar` libera sin avanzar, igual que hoy.
- `Interaccion` agrega `flujo` (`nuevos|importantes|libre`) y `tipo_importante` (nullable). `envio_de_etapa` sigue `true` para ambos flujos (renombre posible a futuro, no ahora).
- `PATCH /clientes/{id}/seguimiento-importante` para corregir a mano `ultimo_contacto` (nunca retrocede) y `proxima_accion`.

Nuevos códigos en `Error.codigo`: `tipo_no_corresponde`, `en_flujo_nuevos`, `ya_contactado_hoy`, `pausa_entre_flujos`, `no_es_importante`. Los existentes siguen (`fuera_de_horario`, `no_contactar`, `sin_telefono`, `respuesta_pendiente`, `etapa_reservada`, `id_externo_usado`, `reserva_vencida`, `odoo_caido`...).

Ejemplo 409:
```json
{"success": false, "codigo": "en_flujo_nuevos", "error": "El cliente 1596 está en la cadencia de nuevos (dia_7). Mandá ese mensaje."}
```

## 5. Opcional — `GET /clientes/importantes/resumen`
Query `dias`, `monto_minimo|top`, `dias_pedido`, `monto_pedido_minimo`. Para el tablero diario:
```json
{"success": true, "data": {
  "total_importantes": 42, "por_motivo": {"monto_acumulado": 35, "pedido_grande": 9, "manual": 4}, "solo_pedido_grande": 3, "excluidos": 3,
  "monto_total_ventana": 31250000.00, "variacion_vs_anterior_pct": -6,
  "toca_hoy": {"toque_periodico": 5, "atraso": 4, "caida": 2}, "puede_enviar_ahora": 9,
  "bloqueados": {"respuesta_pendiente": 2, "no_contactar": 1, "en_flujo_nuevos": 1, "sin_telefono": 1},
  "top_caidas": [{"id": 1493, "nombre": "...", "variacion_pct": -48}],
  "envios_hoy": {"confirmados": 3, "reservados": 1, "cancelados": 0},
  "minutos_estimados_envio": 135
}, "meta": {...}}
```
`minutos_estimados_envio` = `puede_enviar_ahora × 15`. `por_motivo` cuenta un cliente en cada motivo que cumple (puede sumar más que el total).

## 6. Errores generales
- 400 `datos_invalidos`: `dias` o `dias_pedido` fuera de 1–730 o no enteros, `meses`/`meses_pedido` (ya no existen: 400 con mensaje que indique usar `dias`/`dias_pedido`), `monto_minimo`/`monto_pedido_minimo` negativos, `monto_minimo` + `top` juntos, `orden` desconocido, nota vacía con marca, `enviado_at` futuro o anterior a la reserva, texto con "IVA", `productos_recomendados` no enteros.
- 401 `api_key_invalida` · 404 `no_encontrado` · 409 los de §4 · 503 `odoo_caido` (si hay caché, devolverla con `meta.cache: true`).

## 7. Checklist de aceptación
- [ ] `GET /clientes/nuevos` y su flujo responden **idénticos** a 3.1.0 (tests de regresión verdes; `etapa` sin valores nuevos).
- [ ] `/clientes/importantes` con `dias`/`monto_minimo` y con `top` da los mismos totales que una suma manual en Odoo para 3 clientes de muestra.
- [ ] Cliente con un único pedido de $612.500 hace 30 días y total < `monto_minimo` aparece con `motivo_importante: ["pedido_grande"]` y su `id`, `monto` y `fecha` en `pedidos_grandes`.
- [ ] Pedido de exactamente $500.000, o de más pero hace más de `dias_pedido` (60) días, **no** califica por `pedido_grande`.
- [ ] Un `venta-<pedido>` con seña + saldo cuenta como un solo pedido (se suman); dos tickets chicos del mismo día no.
- [ ] Cliente que cumple varios criterios lista todos en `motivo_importante`; `excluido` lo saca igual.
- [ ] `monto_pedido_minimo` y `dias_pedido` salen de config (500000 / 60) y se pueden pisar por query.
- [ ] `ticket_promedio = total/cantidad`; `dias_sin_comprar` en hora de Argentina; `tendencia` compara con el período previo de igual largo.
- [ ] `fijo` aparece aunque no llegue al monto; `excluido` nunca aparece; quitar la marca restaura el cálculo.
- [ ] Cliente en los dos flujos: solo le toca nuevos hasta `finalizado`; nunca dos mensajes el mismo día ni dentro de `pausa_entre_flujos_dias`.
- [ ] Reserva de importantes: 10 min, `id_externo` cancelado no reusable, `repetido:true` con mismo id+contenido.
- [ ] `confirmar` con `enviado_at` guarda esa hora en `ultimo_contacto`; sin él, comportamiento actual.
- [ ] Texto con "IVA" rechazado también en `tipo`; `productos_recomendados` solo enteros.
- [ ] Cliente con **exactamente $1.000.000** en los últimos 60 días califica por `monto_acumulado`; con $999.999,99 no; una compra del día 61 no suma.
- [ ] `tendencia` compara los últimos 60 días con los 60 anteriores; sin compras en el período anterior → `sin_datos`.
- [ ] `dias=0`, `dias=731` o `meses=6` → 400 `datos_invalidos`.
- [ ] Defaults en config (`dias`=60, `monto_minimo`=1000000, `dias_pedido`=60, `monto_pedido_minimo`=500000; sugeridos: toque 30 días, atraso ×1,5, caída −30 %), sin hardcodear; `/openapi.json` actualizado a 3.4.0 con todos los schemas nuevos (`ClienteImportante`, `PedidoGrande`, `MotivoImportante`, `ImportantePatch`, `TipoImportante`, `ResumenImportantes`).
- [ ] Ningún endpoint manda WhatsApp: todo envío sigue pasando por mi OK.
