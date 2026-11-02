Respuesta de Claude — nota 114 (clientes importantes: diseño de endpoints)

Leí las 4 partes y lo acordado (primero solo GET /clientes/importantes). Revisé la API viva (3.3.0) y medí en Odoo, solo lectura, cuántos clientes calificarían hoy. Abajo van: (A) lo que encontré, (B) ajustes para que encaje con la 3.3.0, (C) la spec final de la fase 1, (D) qué queda para la fase 2, (E) preguntas para Mariano y (F) si lo puedo implementar.

== A. Lo que encontré (medición del 30/10/2026, Neggo, últimos 60 días) ==
- 155 clientes compraron en los últimos 60 días. 115 llegan a $100.000 o más (74 %).
- 16 tuvieron un pedido de más de $500.000, y los 16 ya entran por monto acumulado.
- 0 clientes entran SOLO por pedido grande. No es casualidad: con las dos ventanas en 60 días, un pedido de más de $500.000 ya hace que el acumulado pase los $100.000. Mientras dias_pedido <= dias y monto_pedido_minimo >= monto_minimo, "pedido_grande" no suma clientes: solo agrega la etiqueta y el detalle en pedidos_grandes. El caso del checklist ("un pedido de $612.500 y total < monto_minimo") no puede pasar con esos parámetros. Solo pasa si se acorta "dias", se alarga "dias_pedido" o se cambian los montos por query.
- De los 115, 36 no compraron en los 60 días anteriores, así que su tendencia daría "sin_datos".
- Con $100.000 en 60 días entran 3 de cada 4 clientes activos. Si la idea es una lista corta, conviene un umbral más alto o usar top (ver preguntas).

== B. Ajustes para que encaje con la 3.3.0 (lo que hoy ya existe manda) ==
1. Versión: la 3.2.0 ya pasó y la viva es la 3.3.0. La fase 1 sale como 3.4.0 y la fase 2 como 3.5.0.
2. Errores de validación: la API responde 422 datos_invalidos con details (ErrorValidacion), no 400. Lo nuevo hace lo mismo.
3. Odoo caído: es 502 odoo_caido, no 503 (el 503 ya es "deshabilitada"). Hoy no se devuelve una caché vieja cuando Odoo falla, así que propongo no prometer "meta.cache: true" en la fase 1.
4. Sobre de respuesta: la clave real es "pagination" (schema Paginacion), no "paginacion". Los filtros aplicados van dentro de "meta.filtros" para no agregar una clave nueva arriba.
5. Filtro "qué toca hoy": en /clientes/nuevos se llama para_hoy (bool) y el campo es toca_hoy. En importantes se repite igual: el filtro se llama para_hoy (fase 2).
6. Qué es una compra: lo mismo que en nuevos. Son tickets del POS de Neggo en estado paid, done o invoiced. Los tickets que cobran el mismo pedido (seña y saldo) se suman como una sola compra venta-<id>. No entran Preventas, los pedidos que nunca pasaron por el POS, RMA ni Consumidor final. El "Down Payment" no se duplica porque se suma el amount_total de los tickets, como hoy.
7. Clientes duplicados: el CRM de la app une los clientes duplicados (nota 72), pero la API del agente trabaja por partner de Odoo y no los une. Un cliente partido en dos partners puede quedar abajo del umbral. Ver la pregunta 3.
8. Caché: igual que nuevos. La parte de Odoo se guarda 5 minutos por combinación de parámetros y refresh=1 la recalcula.
9. "meses" y "meses_pedido" no existen en la 3.3.0. Igual, si vienen, devuelven 422 con un mensaje que dice que se usen dias y dias_pedido, como pediste.
10. id_externo: el pattern actual (^[A-Za-z0-9._:-]{1,100}$) ya acepta grok-1596-atraso-20261029.

== C. Spec final — fase 1 (3.4.0): GET /clientes/importantes ==
Solo lectura, no escribe nada (ni en Odoo ni en la base) y no manda nada.

Config (backend/config/importantes.json, editable sin tocar código; si falta una clave se usa el default):
  dias 60 (1-730) · monto_minimo 1000000 · monto_pedido_minimo 500000 · dias_pedido 60 (1-730)
  Las de la fase 2 (toque_cada_dias 30, factor_atraso 1.5, caida_pct 30, min_compras_intervalo 3, pausa_entre_flujos_dias 3) ya pueden estar en el archivo, pero la fase 1 no las usa.

Regla:
  importante = (monto_acumulado OR pedido_grande OR manual) AND NOT excluido
  - monto_acumulado: suma de Compra.monto en la ventana de "dias" (hoy cuenta como día 1, hora de Argentina) >= monto_minimo. $1.000.000 justos califican; $999.999,99 no; una compra del día 61 no suma.
  - pedido_grande: alguna Compra (pos-<id>, o venta-<id> con seña y saldo sumados) con monto > monto_pedido_minimo en la ventana de dias_pedido. Exactamente $500.000 no califica.
  - manual / excluido: ver la pregunta 1. Si la fase 1 sale sin marcas, marca_manual es siempre null y el motivo "manual" no aparece.
  - Con top=N, el filtro de monto_minimo no se aplica. Se calcula la regla con los otros criterios y se devuelven los N de mayor total_comprado. Ver la pregunta 4.

Query:
  dias (int 1-730, default de config) · monto_minimo (number >= 0) · top (int 1-500; no se combina con monto_minimo: los dos juntos dan 422)
  monto_pedido_minimo (number >= 0) · dias_pedido (int 1-730)
  motivo (monto_acumulado | pedido_grande | manual): deja solo los que cumplen ese motivo
  no_contactar (false | true | todos; default todos; en nuevos es false, pero acá la lista es para analizar y no solo para mandar mensajes)
  con_respuesta_pendiente (bool) · orden (monto_desc* | dias_sin_comprar_desc | tendencia_asc | ultima_compra_desc | nombre)
  page, limit (máx. 100, default 50) · refresh (1 | true)
  Devuelve 422 si: dias o dias_pedido no son enteros o están fuera de 1-730; un monto es negativo o no es número; vienen monto_minimo y top juntos; el orden o el motivo no existen; vienen meses o meses_pedido.

Respuesta 200:
  { success: true, data: ClienteImportante[], pagination: {page, limit, total, pages},
    meta: { ...Meta (hoy, ahora, ventana_envio, ventana_abierta, abre_a),
            filtros: { dias, monto_minimo | top, monto_pedido_minimo, dias_pedido },
            ventana: { desde, hasta }, ventana_anterior: { desde, hasta } } }

Schema ClienteImportante (liviano: sin compras ni productos; para el detalle está GET /clientes/{id}):
  id, nombre, contacto, telefono, ciudad, rubro: igual que Cliente
  categorias_compradas: CategoriaComprada[], de las compras de la ventana
  motivo_importante: MotivoImportante[] (uno o varios, en orden fijo: monto_acumulado, pedido_grande, manual)
  pedidos_grandes: PedidoGrande[] { id: "venta-123"|"pos-456", referencia, monto, fecha }, del más nuevo al más viejo; [] si no tiene
  marca_manual: { tipo: fijo|excluido, nota, at } | null
  total_comprado, cantidad_compras, ticket_promedio (= total/cantidad, 2 decimales; null si no tiene compras), todo dentro de la ventana
  ultima_compra (date-time, toda la historia) · dias_sin_comprar (hora de Argentina)
  intervalo_habitual_dias: mediana de días entre compras de los últimos 365 días; null si tiene menos de min_compras_intervalo compras. Ver la pregunta 5.
  tendencia: { periodo_anterior, variacion_pct (entero), direccion: sube | estable (±10 %) | baja | sin_datos (sin compras en el período anterior) }
  no_contactar, respuesta_pendiente, reserva_activa: igual que en nuevos
  en_flujo_nuevos: true si su primera compra cae en la ventana de nuevos (21 días) y la etapa no es finalizado

Ejemplo:
  { "id": 1596, "nombre": "Bazar Las Rosas", "contacto": "Carla", "telefono": "+5492477000000", "ciudad": "Pergamino", "rubro": "Bazar",
    "categorias_compradas": [{"rubro": "Bazar", "monto": 812000, "porcentaje": 64}],
    "motivo_importante": ["monto_acumulado", "pedido_grande"],
    "pedidos_grandes": [{"id": "venta-871", "referencia": "S00871", "monto": 612500.00, "fecha": "2026-09-30T11:20:00-03:00"}],
    "marca_manual": null, "total_comprado": 1268000.00, "cantidad_compras": 9, "ticket_promedio": 140888.89,
    "ultima_compra": "2026-09-30T11:20:00-03:00", "dias_sin_comprar": 30, "intervalo_habitual_dias": 18,
    "tendencia": {"periodo_anterior": 1610000.00, "variacion_pct": -21, "direccion": "baja"},
    "no_contactar": false, "respuesta_pendiente": false, "reserva_activa": null, "en_flujo_nuevos": false }
  (El id de una venta agrupada es venta-<id del pedido en Odoo>, como en Compra; el nombre S00871 va en referencia.)

Otros cambios de la fase 1:
  - GET /clientes/{id} suma "importante": { es_importante, motivo_importante, pedidos_grandes, marca_manual }, calculado con los defaults de config.
  - Error.codigo no cambia en la fase 1.
  - Schemas nuevos en /openapi.json: ClienteImportante, PedidoGrande, MotivoImportante, Tendencia, MarcaManual.
  - Tests: los bordes del checklist (100.000 justos, 99.999,99, día 61, pedido de 500.000 justos, seña + saldo = 1 pedido, dos tickets del mismo día = 2 compras, varios motivos, excluido gana) como lógica pura, igual que agenteNuevos.test.js. Más una regresión que confirme que /clientes/nuevos responde igual que antes.

== D. Fase 2 (3.5.0), como está en las partes 3-5, con estos ajustes ==
- toca_hoy, motivo_toca_hoy, vence, puede_enviar_ahora y seguimiento_importante entran recién acá; en la fase 1 no se devuelven, para no mostrar datos sin la lógica que los respalda.
- EnvioNuevo con etapa O tipo: en lugar de oneOf, conviene dejar los dos campos opcionales y validar en el servidor que venga uno solo (422). Algunos clientes de OpenAPI manejan mal oneOf con additionalProperties:false.
- Si no corresponde, conviene reusar etapa_no_corresponde en vez de crear tipo_no_corresponde: el bot ya lo maneja. Los nuevos serían en_flujo_nuevos, ya_contactado_hoy, pausa_entre_flujos y no_es_importante.
- Hace falta otro índice único: el actual (cliente, etapa) no sirve para "una sola reserva activa por cliente sin importar el flujo" ni para "atraso una vez por compra". Eso es una migración nueva (el número lo pide el coordinador).
- enviado_at en confirmar: va bien en la fase 2. Valida que no sea futuro (con 1 minuto de tolerancia) ni anterior a la reserva menos 1 minuto. Se guarda en fecha y en ultimo_contacto, y confirmado_at queda aparte (columna nueva).
- Resumen (/clientes/importantes/resumen): sale al final; "minutos_estimados_envio = puede_enviar_ahora × 15" está bien.

== E. Preguntas para Mariano ==
1. Marca manual: ¿la fase 1 sale sin marcas (fijo/excluido después) o sumo ya el PATCH /clientes/{id