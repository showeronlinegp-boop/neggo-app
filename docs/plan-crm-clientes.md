# Plan — Módulo de seguimiento de clientes (CRM)

Fecha: 2026-10-21. Estado: **fase 1 implementada** (rama `objetivos/crm-clientes`, ver sección 10). Reemplaza al alcance del Agente 10
(`docs/agents/10-sales-clients.md`) y toma como referencia visual el mockup "Funnel de clientes
Neggo" (propuesta v2 de la nota #91: Clientes · Campañas · Resultados · Agente).

Objetivo: una pantalla donde ver lo importante de cada cliente, la tendencia de sus compras,
quiénes se están enfriando, y registrar el seguimiento comercial (etapa, próxima acción,
responsable, historial).

---

## 1. Lo que hay hoy (relevado contra Odoo y la base el 2026-10-21)

### Odoo

| Dato | Neggo (id 1) | Precompras (id 50) |
|---|---|---|
| `sale.order` confirmadas | 2520 | 272 |
| `sale.order` en draft/sent (cotizaciones abiertas) | 441 | 91 |
| `pos.order` (desde 2026-01-15) | 2225, todas con cliente | 0 |
| Facturas de cliente publicadas | 2942 | 95 |

- Primera OV: 2025-09-25. Hay ~13 meses de historia.
- **365 clientes con al menos una compra** (OV + POS). 500 partners con `customer_rank > 0`, 376 con teléfono.
- Recencia (última compra): 124 en 0-30 días · 42 en 31-60 · 40 en 61-90 · 56 en 91-180 · 103 hace más de 180.
- Frecuencia: 57 compraron 1 vez · 113 entre 2 y 3 · 89 entre 4 y 10 · 106 más de 10.
- Intervalo típico entre compras (clientes con 4+ compras): p25 = 5 días, mediana = 11, p75 = 26.
  **Un umbral fijo de 30 días no sirve**: para la mitad de los clientes frecuentes, 30 días sin comprar ya es casi 3 veces lo normal.
- Ciudades: 267 sin ciudad cargada, 137 de Pergamino (con variaciones de mayúsculas), después Rojas, Arrecifes y Junín.
- Vendedor en las OV: todas tienen a "Mariano Menendez". Odoo no tiene datos de quién atiende a cada cliente.
- **CRM de Odoo instalado**: 20 `crm.lead` de 2025-09, etapas New / Qualified / Proposition / Won / Frio / Churn. Está abandonado.
- Etiquetas de partner (`category_id`): Historico (445), Agus (17), Churn (13), Cliente (13), Farmacias (13), Tecnología (12),
  Libreria (8), Polirrubros (8), Juguetería (7), Cliente a Recuperar (3). Mezclan rubro, estado y responsable.
- Algunos nombres traen el estado escrito adentro ("Yamii Gonzlez Estado: Cliente NLD-11", "Sandra Di Santi Estado: Cliente SLD").
- Partners que no son clientes reales y ensucian rankings: "Consumidor Final" (100 tickets POS) y "Shower" (#925, primero en facturación).

### App

- Tablas vacías del Agente 10: `client_notes`, `client_reminders` y `client_metrics_cache` (0 filas).
- `product_sales_weekly` y `jobs/salesWeeklySync.js` ya leen ventas por producto. Sirve de patrón para el sync.
- `odooService`: `getCustomers`, `getCustomerById`, `getSaleOrders`, `getSaleOrdersWithLines`, `attachDonePickingCounts`.
- Usuarios en la app: solo `admin`. El mockup asigna tareas a "Juli", así que hacen falta usuarios vendedores.
- Las OV que se cobraron en el POS aparecen dos veces, como OV (`pos_order_count > 0`) y como `pos.order` (ver memoria `odoo-pos-derivados`).
  **Las métricas tienen que deduplicar**: si la OV tiene `pos_order_count > 0`, se cuenta solo el ticket POS (o solo la OV, pero no las dos).

---

## 2. Alcance propuesto

### Qué entra

1. **Ficha de cliente 360**: datos de contacto, rubro, ciudad, lista de precios, cotización o pedido abierto, métricas, tendencia e historial.
2. **Métricas calculadas** por cliente y empresa: facturación, ticket promedio, cantidad de compras, intervalo habitual, última compra, tendencia de 90 días contra los 90 anteriores, categorías y productos top.
3. **Salud del cliente** (automática): Activo · En desfasaje · Enfriándose · Perdido · Nuevo. Se calcula contra **su propio ritmo**, no contra un umbral fijo.
4. **Funnel comercial** (manual, como el mockup): etapa Frío / Templado / Caliente, próxima acción con fecha y responsable, historial de contactos.
5. **Mi día**: tareas de seguimiento vencidas y del día, por usuario.
6. **Listados**: Clientes (filtros por ciudad, rubro, responsable, salud y etapa, y "solo con cotización o pedido abierto"), Enfriándose y Resultados (ganados en el mes, descartados, reactivados).

### Qué queda fuera de esta etapa

- Las pestañas **Campañas** y **Agente** del mockup (envíos masivos por WhatsApp o un agente IA). Se apoyan en este módulo, pero van después.
- Recomendaciones de productos con IA. En la fase 3 entra la versión simple: "compraba X y dejó de comprarlo".
- Escribir en Odoo, salvo lo que se decida en la pregunta D3.

---

## 3. Definiciones de negocio (borrador, a validar)

**Compra** = ticket del punto de venta (`pos.order` pagado) de Neggo. Las OV no cuentan como compra (D2).
Las cotizaciones abiertas (draft/sent) de Neggo y Preventas no son compras: son señal de interés y se muestran aparte.

**Intervalo habitual** = mediana de días entre compras (en días distintos) de los últimos 12 meses.
Con menos de 3 compras se usa 15 días (D5).

**Salud** (con `d` = días desde la última compra e `i` = intervalo habitual):

| Estado | Regla |
|---|---|
| Nuevo | Primera compra hace ≤ 30 días |
| Activo | `d ≤ 1,5 × i` |
| En desfasaje | `1,5 × i < d ≤ 2,5 × i` |
| Enfriándose | `2,5 × i < d` y `d ≤ 120` |
| Perdido | `d > 120` (o lo que se decida) |

**Tendencia** = facturación de los últimos 90 días contra los 90 anteriores.
Más de +20 % sube, menos de -20 % baja, en el medio se mantiene estable.
También avisa si el ticket promedio cae aunque la frecuencia se mantenga.

**Prioridad para llamar** (orden del listado "Enfriándose") = facturación de los últimos 12 meses × qué tan pasado está de su intervalo.
Arriba aparecen los clientes grandes que se están yendo, no los más viejos.

**Funnel (manual)**: Frío → Templado → Caliente → Ganado, y Descartado como salida.
"Ganado" se marca solo cuando entra una compra después de pasar a Caliente.
Se cuenta en "Ganados este mes" si fue su primera compra, y como "Reactivado" si ya había comprado antes.

---

## 4. Modelo de datos (migraciones nuevas; pedir el número al coordinador)

Se reusan `client_notes` y `client_reminders`, que están vacías, y se amplía `client_metrics_cache`.
Se evalúa reemplazarlas por tablas nuevas si conviene. Propuesta:

```sql
-- Métricas por cliente/empresa (recalculadas por el sync)
ALTER TABLE client_metrics_cache
  ADD COLUMN partner_name VARCHAR(300),
  ADD COLUMN phone VARCHAR(50),
  ADD COLUMN city VARCHAR(120),
  ADD COLUMN first_purchase_date DATE,
  ADD COLUMN median_interval_days NUMERIC(8,2),
  ADD COLUMN revenue_90d NUMERIC(14,2),
  ADD COLUMN revenue_prev_90d NUMERIC(14,2),
  ADD COLUMN revenue_12m NUMERIC(14,2),
  ADD COLUMN health VARCHAR(20),          -- nuevo|activo|desfasaje|enfriandose|perdido
  ADD COLUMN trend VARCHAR(10),           -- sube|estable|baja
  ADD COLUMN monthly_revenue JSONB DEFAULT '[]',   -- últimos 12 meses, para el sparkline
  ADD COLUMN top_products JSONB DEFAULT '[]',
  ADD COLUMN open_quotation JSONB;        -- { name, amount, date } o null

-- Seguimiento comercial (1 fila por cliente)
CREATE TABLE client_followups (
  id SERIAL PRIMARY KEY,
  odoo_partner_id INTEGER NOT NULL,
  stage VARCHAR(20) NOT NULL DEFAULT 'frio',   -- frio|templado|caliente|ganado|descartado
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  segment VARCHAR(40),                         -- revendedor, polirrubro, farmacia… (ver D6)
  discard_reason VARCHAR(200),
  stage_changed_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (odoo_partner_id)
);

-- Historial: cambios de etapa, llamadas, notas (reemplaza o absorbe a client_notes)
CREATE TABLE client_events (
  id SERIAL PRIMARY KEY,
  odoo_partner_id INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL,                  -- nota|llamada|whatsapp|visita|lista|etapa|compra
  text TEXT,
  meta JSONB DEFAULT '{}',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- La próxima acción usa client_reminders sumándole: action_type, assigned_user_id
```

Índices: `(odoo_partner_id)` en las tres tablas, `(health)`, `(stage)`, `(owner_user_id)`,
`client_reminders(assigned_user_id, completed, due_date)` y `client_events(odoo_partner_id, created_at DESC)`.

---

## 5. Backend

- `services/clientMetricsService.js`: lee OV confirmadas y `pos.order` paginados (`readAllPages`), deduplica, calcula y hace upsert en `client_metrics_cache`.
  Lógica pura separada (`clientHealth.js`) con tests: intervalo, salud, tendencia y prioridad.
- `jobs/clientMetricsSync.js`: corrida nocturna con el scheduler, más un botón "Actualizar" para admin.
  Volumen chico (~5000 órdenes), así que alcanza con una corrida completa. Si crece, se pasa a incremental por `write_date`.
- `services/clientFollowupService.js`: cambio de etapa (con registro en `client_events`), próxima acción y marcado automático de "ganado" cuando entra una compra.
- `routes/clients.js`:
  ```
  GET  /api/clients?search=&city=&owner=&health=&stage=&open=1&page=
  GET  /api/clients/summary            — contadores (por salud, por etapa, ganados del mes)
  GET  /api/clients/:partnerId         — ficha: métricas + seguimiento + cotización abierta
  GET  /api/clients/:partnerId/orders  — compras (Odoo, en vivo, paginado)
  GET  /api/clients/:partnerId/events
  POST /api/clients/:partnerId/events  — nota / llamada hecha
  PUT  /api/clients/:partnerId/followup — etapa, responsable, segmento
  POST /api/clients/:partnerId/next-action
  PUT  /api/clients/actions/:id/done   — al tildar, pide la próxima
  GET  /api/clients/my-day             — tareas del usuario logueado
  POST /api/clients/sync-metrics       — admin
  ```

## 6. Frontend (seguir `docs/design/DESIGN_SYSTEM.md` y tokens)

- Sección nueva **Ventas** en el Layout: Clientes · Mi día · Resultados.
- `pages/clientes/ClientList.jsx`: buscador, filtros del mockup, chips de salud, columna de tendencia con sparkline y etapa.
- `pages/clientes/ClientCard.jsx` (panel o ruta `/clientes/:id`): la tarjeta del mockup (cotización abierta, etapa, próxima acción con fecha y responsable, historial) más un bloque de métricas (facturación 12 meses, ticket, cada cuántos días compra, última compra, top productos).
- `pages/clientes/MiDia.jsx`: tareas vencidas, de hoy y de mañana. Al tildar una, pide la próxima acción.
- `pages/clientes/Resultados.jsx`: ganados, reactivados y descartados por mes, más el movimiento entre estados de salud.

## 7. Fases

| Fase | Contenido | Sirve sola para |
|---|---|---|
| 1 | Sync de métricas + lógica de salud con tests + listado y ficha de solo lectura | Ver quién se enfría, sin cargar nada |
| 2 | Funnel: etapa, próxima acción, historial, Mi día, usuarios vendedores | Hacer el seguimiento |
| 3 | Resultados + "dejó de comprar X" + aviso en el Dashboard | Medir y priorizar |
| 4 (después) | Campañas por WhatsApp (Evolution) sobre segmentos, Agente | Escalar el contacto |

---

## 8. Decisiones

### Tomadas (2026-10-21)

- **D1 Empresas.** Facturación y métricas: **solo Neggo**. Seguimiento de pedidos y cotizaciones abiertas: **Neggo y Preventas**, en la misma ficha.
- **D2 Qué cuenta como compra.** **Solo el ticket del punto de venta (`pos.order`)**, porque todo se cobra por ahí. Las OV no suman como compra, así que no hace falta deduplicar.
- **D3 Dónde vive el seguimiento.** **Solo en la app.** No se escribe nada en `crm.lead` ni en las etiquetas de Odoo.
- **D4 Exclusiones.** "Shower" **cuenta como cliente**. **RMA se excluye.** "Consumidor Final" **suma solo en la facturación total** de Neggo: no aparece en listados, rankings, salud ni funnel.
- **D5 Umbrales.** Quedan 1,5× y 2,5× del intervalo propio y "Perdido" a los 120 días. Para clientes con 1 o 2 compras, el intervalo es **15 días**.
- **D6 Rubro.** **El rubro es la categoría de producto en la que más compró** en los últimos 12 meses. No se usan las etiquetas ni el nombre.
- **D7 Ciudad.** **Se deja como está** (muchos clientes sin ciudad; el filtro sirve para los que la tienen).
- **D8 Responsables y usuarios.** **Todos son responsables de todo** por ahora. Los usuarios de los vendedores **se dejan para más adelante**. La próxima acción igual guarda quién la creó.
- **D9 Etapas.** **Frío, Templado y Caliente alcanzan.**
- **D10 Arranque del funnel.** **Entran todos los clientes.**
- **D11 Leads sin compras.** **Sí, pero solo si tienen mail o celular.** El usuario va a pasar una lista de contactos de Neggo desde Drive (no todos son clientes) para cargarlos.
- **D12 Tipos de acción.** **El accionable podría ser por mail** (por ejemplo, "Mandar lista" por correo). Falta definir con qué cuenta se manda y qué se manda.
- **D13 Qué ves primero.** **Se ve después.**
- **D14 Avisos.** **No hacen falta** avisos fuera de la app.
- **D15 Métricas en la ficha.** **Solo facturación**, sin margen. (Respuesta: "No solo lo facturado"; se lee como "No, solo lo facturado". Confirmar.)
- **D16 Frecuencia del sync.** **Una vez por día:** se calcula al arrancar el servidor y, si quedó prendido, otra vez a las 24 h. El botón "Actualizar" sigue estando.
- **D17 Piso del intervalo: 7 días.** **Aprobado.**
- **D18 Señas y saldos.** **Se deja así:** un pedido pagado en 2 tickets cuenta como 2 compras.
- **D19 Cotizaciones.** **Solo las de los últimos 60 días**, y **solo como excusa para hablarle al cliente**: no suman al estado ni a la prioridad.
- **D20 Estado en el nombre.** **Los nombres quedan como están.**

### Pendientes

- **D12** con qué cuenta de correo y qué contenido tiene el accionable por mail.
- **D13** pantalla de entrada del CRM.
- **D15** confirmar que es "solo facturación".
- Lista de contactos de Drive (D11): el usuario la pasa.

## 9. Riesgos

- Los partners duplicados en Odoo (el mismo cliente con 2 fichas) parten la historia y lo hacen parecer frío. Hace falta un listado de "posibles duplicados" por teléfono.
- Contar dos veces OV y POS infla la facturación. Hay que cubrirlo con un test.
- Sin usuarios por vendedor, la fase 2 la usan todos con su usuario actual; el historial guarda quién hizo cada acción.

---

## 10. Fase 1: qué quedó hecho

- `backend/services/clientHealth.js`: intervalo habitual, estado, tendencia, prioridad y métricas. Lógica pura, con tests en `clientHealth.test.js`.
- `backend/services/clientMetricsService.js`: lee de Odoo los tickets del POS de Neggo, sus líneas de producto de los últimos 12 meses y las cotizaciones abiertas de Neggo y Preventas. Lo guarda en `client_metrics_cache` (migración `042_clientes_crm.sql`, que también aplica `ensureSchema` al arrancar). Los tests de armado de filas están en `clientMetrics.test.js`. Con los datos de hoy, el sync completo tarda ~7 s.
- `backend/routes/clientes.js`: `GET /api/clientes`, `GET /api/clientes/resumen`, `GET /api/clientes/:id` y `POST /api/clientes/sync`, para los roles admin y vendedor.
- Cuándo se actualiza: al arrancar el servidor (D16) y, si al abrir el listado los datos tienen más de 24 horas, el backend lanza el sync en segundo plano. También se puede pedir con el botón "Actualizar". No corre en el scraper-worker, así que no hace falta reconstruirlo.
- Frontend: menú **Ventas → Clientes** (`/clientes`).
  - Contadores por estado, que también funcionan como filtro.
  - Facturación de 90 días contra los 90 anteriores.
  - Búsqueda por nombre o teléfono, filtros por ciudad y "solo con cotización abierta", y orden por prioridad, facturación, compra más reciente o nombre.
  - Ficha en un panel lateral: métricas, compras por mes, cotizaciones abiertas, lo que más compra y últimos tickets (en vivo de Odoo), con un botón para escribirle por WhatsApp.

Primer sync con datos reales (2026-10-21): 433 clientes. 87 activos, 30 nuevos, 25 en desfasaje, 71 enfriándose, 90 perdidos y 130 sin compras (solo tienen cotizaciones).

### Ajustes después de las decisiones (2026-10-21)

- Cotizaciones: solo las abiertas de los últimos 60 días (D19). En la ficha aparecen como "Motivo para hablarle".
- Rubro por cliente (D6), migración `043_clientes_rubro.sql`. Las categorías duplicadas de Odoo se unifican ("Tecnologia" = "Tecnología", "Accesorios de Moda" = "Accesorios Moda", "Bazar6920253361236" = "Bazar"). Servicios, gastos y las categorías genéricas (Goods, Food) no son rubro. Hay filtro por rubro en el listado.
- Tickets que cobran un pedido de venta (anticipo o saldo): no traen productos, así que se toman las líneas del pedido de venta, una sola vez por pedido. Antes, unos 160 clientes quedaban sin "Lo que más compra".
- Sync al arrancar el servidor y cada 24 h (D16). Con los datos de hoy tarda ~15 s: 353 clientes, 299 con rubro.
