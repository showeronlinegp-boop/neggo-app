# Plan — CRM sobre WhatsApp, parte 1: posibles clientes (leads)

Propuesta general (visual): https://claude.ai/artifact/JynebjmtgX3er4KVouQntj

Se construye por partes: primero los posibles clientes (`crm_leads`), después los clientes de Odoo.
Esta parte cruza cada posible cliente con sus conversaciones de WhatsApp, le da una etapa con un
objetivo claro y muestra qué conversaciones están abiertas.

## 1. Lo que hay hoy (medido en la base real el 2026-11-22)

### Posibles clientes
- 4.826 sin vínculo con Odoo. Por estado de la agenda: 4.285 NRI, 284 lead, 128 sin estado,
  31 churn, 18 recuperar, 14 cliente. Por fuente: `google_contacts`, 47 `agente_manual`, 27 `manual`.
- **Hay tres etapas que no se hablan entre sí**:
  - `crm_leads.source_status`: el estado de la agenda vieja (NRI, lead, churn…). No cambia más.
  - `crm_followups.stage` (Frío/Templado/Caliente/Ganado/Descartado): casi sin uso en leads (3 descartados).
  - `crm_bot_lead_seguimiento.etapa` (pendiente/presentación/recordatorio/cierre/finalizado) + `resultado`:
    la cadencia de Grok. 70 leads con fila, 71 mensajes enviados y 2 recibidos (4 al 19/11).

### WhatsApp del negocio (memoria de Evolution, esquema `evolution_negocio`)
- 4.190 posibles clientes están en la agenda del teléfono del negocio (`Contact` con número).
- Pero **solo 18 tienen un chat cruzable por número**: casi todos los chats privados vienen como `@lid`
  (984 chats) y no traen el teléfono.
- Desde el 14/11 WhatsApp manda el teléfono junto al @lid (`key.remoteJidAlt`); Evolution además
  guarda el mapa en disco (`instances/<id>/lid-mapping-*.json`, 111 pares). Cubre 105 chats: 18 son
  posibles clientes y 46 ya son clientes de Odoo.
- Los 879 chats anteriores al 14/11 no tienen el número en ningún lado.
- Los mensajes de Grok no salen por el número del negocio (de 15 enviados el 19/11, 14 no están en la
  memoria): **la conversación con Grok solo se conoce por lo que Grok informa** a la API (`crm_bot_lead_mensajes`).

## 2. Etapas del posible cliente y objetivo de cada una

Una sola etapa por lead (`crm_lead_estado`), que se calcula sola con señales de WhatsApp, Grok y Odoo.
Cada etapa tiene **un objetivo**; cumplirlo es lo que la hace avanzar. Las personas pueden mover a mano
(con motivo) y la regla no pisa un cambio manual por 7 días.

| Etapa | Objetivo para pasar | Señal de salida (automática) | Quién trabaja | Tope |
|---|---|---|---|---|
| **Sin contactar** | Primer contacto | Mensaje nuestro (persona o Grok) | Grok (cadencia, 15/día) o persona | — |
| **Contactado** | Que responda | Mensaje recibido del lead | Grok: presentación → recordatorio → cierre | 3 mensajes / 15 días → *Sin respuesta* |
| **Conversando** | Calificarlo: es comercio, está en zona, rubro, interés | Datos mínimos cargados (rubro + ciudad en zona) o respuesta "interesado" | Persona (Grok se pausa) | 7 días sin avance → acción en Mi día |
| **Interesado** | Mandarle precios: lista, catálogo o cotización | Cotización en Odoo para su número (crea el contacto) | Persona | 7 días → Mi día |
| **Cotizado** | Primer pedido | Venta confirmada en Odoo | Persona | 10 días → Mi día |
| **Ganado** | — pasa a Clientes (bot de clientes nuevos, día 1/7/15) | — | — | — |

Salidas laterales:
- **Sin respuesta**: terminó la cadencia sin contestar. Vuelve a *Sin contactar* a los 90 días (una vez).
- **Descartado** (con motivo): no es comercio, fuera de zona, no le interesa, número equivocado.
- **No contactar** (Churn): pidió que no le escriban o bloqueó. Terminal: nadie le escribe.

Mapeo con lo existente: `source_status = churn` → No contactar; resultado de Grok `no_contactar` →
No contactar, `no_interesado` → Descartado, `interesado` → Interesado, `sin_respuesta` → Sin respuesta,
`ya_en_odoo` → Ganado o Cotizado según Odoo. `crm_followups.stage` queda como "temperatura" manual.

## 3. Conversación abierta

Por cada lead con chat, un estado de la conversación:

- **Espera respuesta nuestra**: el último mensaje es del lead y no es un cierre ("gracias", "ok", sticker, emoji).
- **Esperando al lead**: el último es nuestro.
- **Cerrada**: sin mensajes en 7 días, o cierre explícito.
- **Sin chat**.

Las abiertas que esperan respuesta van a una bandeja ordenada por tiempo esperando. Con reglas solamente
en esta parte; la IA (intención y resumen) queda para después de decidir la clave de Anthropic.

## 4. Partes a construir

Cada parte se puede desplegar sola.

**L1 — Cruce leads ↔ chats** (migración 065)
- Tabla `crm_lead_chats` (lead_id, chat_jid, canal `negocio|grok`, cómo se cruzó `numero|lid_alt|lid_map|manual`,
  confianza, created_at). Única por (canal, chat_jid).
- Job cada 5 min, solo lectura sobre `evolution_negocio`: chats `@s.whatsapp.net`, `remoteJidAlt`, y el mapa
  `lid-mapping` (volumen de Evolution montado **solo lectura** en el backend). `phone_key` = últimos 10 dígitos
  (mismo criterio que `crmContacts.phoneKey`).
- Chat nuevo de un número que no es cliente ni lead → lead nuevo con `source = 'whatsapp'`.
- Vínculo manual desde la ficha para los chats viejos sin número.

**L2 — Estado de la conversación**
- Tabla `crm_lead_conversacion` (lead_id, canal, último mensaje, quién, cuándo, cantidad, estado). Se guarda la copia
  antes de la depuración semanal de 7 días.
- Grok: lo que informa a la API (`crm_bot_lead_mensajes`) cuenta como canal `grok`.

**L3 — Etapas con objetivos**
- Tabla `crm_lead_estado` (lead_id PK, etapa, etapa_desde, motivo, manual_hasta) + historial en `crm_events` (kind `etapa`).
- Lógica pura en `services/leadEtapas.js` (señales → etapa) con tests; el job la corre después de L1/L2 y después del sync de Odoo.
- Carga inicial desde `source_status` y la cadencia de Grok con el mapeo de la sección 2.

**L4 — Pantallas** (Ventas → Posibles clientes)
- Embudo por etapa con contadores y "trabados" (pasaron el tope).
- Bandeja "Esperan respuesta".
- Ficha: conversación, etapa con su objetivo y checklist (rubro, ciudad, interés), vínculo manual de chat.

**L5 — Convivencia con Grok**
- La API de leads expone etapa y conversación. Grok solo trabaja *Sin contactar* y *Contactado*; si el lead escribe al
  negocio, se pausa su cadencia.

Después: clientes (mismo cruce con `res.partner`, ciclo Activo → En riesgo → Inactivo), grupo y duplicados.

## 5. Decisiones (respuestas de Mariano, 2026-11-22)

1. **Sí**: el backend lee la memoria del negocio en solo lectura y nunca manda nada. **La depuración semanal de 7 días
   se mantiene**: la app guarda solo quién es cada chat y las fechas, no el texto.
2. **Solo hacia adelante + vínculo manual**, sin consulta masiva. Si el contenido del chat ayuda a cruzar con Odoo, se usa
   (hoy: cotizaciones nombradas). Más adelante, un botón **Averiguar** que consulte a WhatsApp de a un número.
   Hallazgo técnico: WhatsApp solo responde número → @lid (no al revés), y Evolution 2.3.7 no expone esa consulta: el botón
   necesita un parche nuevo en la imagen de Evolution del negocio y reiniciar ese contenedor.
3. **No** alcanza con rubro + ciudad para "calificado": falta definir el criterio (pendiente).
4. Grok: alcanza con lo que ya informa a la API (`crm_bot_lead_mensajes`), que se suma como canal `grok`.
5. Topes de cada etapa: pendiente.

## Estado

- **L1 hecha** (rama `objetivos/crm-whatsapp-leads`, migración 065): cruce cada 15 min, alta de posibles clientes nuevos
  con `source = 'whatsapp'` (Grok no les escribe: 409 `escribio_al_negocio`, API 3.10.0), bloque "WhatsApp del negocio"
  en la ficha con vínculo y desvínculo a mano. Simulación en la base real (22/11, 8 días): 148 chats privados, 106 con
  número → 45 ya clientes por cotización, 31 clientes/proveedores de Odoo por teléfono, 15 posibles clientes existentes,
  1 posible cliente que pasa a cliente por cotizaciones, 13 posibles clientes nuevos.

## 6. Riesgos

- Si la instancia del negocio se traba (como del 14 al 16/11), las conversaciones parecen cerradas: L1 incluye un aviso
  cuando no entra ningún mensaje en 3 horas en horario comercial.
- La depuración semanal borra mensajes de más de 7 días: L2 tiene que correr antes (lunes 8:00).
- Las etapas automáticas pueden pisar lo que hizo una persona: por eso `manual_hasta`.
