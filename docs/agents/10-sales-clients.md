# Agente 10 — Ventas: Dashboard de clientes + Recomendaciones + Seguimiento (Fase 2)

## Objetivo
Dashboard de clientes con vista VIP vs resto, recomendaciones de compra basadas en historial
de Odoo, notas internas con recordatorios, y alertas de inactividad.

## Skills a leer
- `docs/skills/odoo-integration/SKILL.md` (lectura de sale.order, res.partner)
- `docs/skills/project-context/SKILL.md` (sección clientes)

## Dependencias
- Agentes 01-09 completados (Fase 1 completa)

## Schema nuevo

```sql
CREATE TABLE IF NOT EXISTS client_notes (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER NOT NULL,
    company VARCHAR(20) NOT NULL DEFAULT 'neggo',
    note TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_reminders (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER NOT NULL,
    company VARCHAR(20) NOT NULL DEFAULT 'neggo',
    reminder_text VARCHAR(500) NOT NULL,
    due_date DATE NOT NULL,
    completed BOOLEAN DEFAULT false,
    completed_at TIMESTAMP,
    completed_by INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_metrics_cache (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER NOT NULL,
    company VARCHAR(20) NOT NULL,
    total_revenue NUMERIC(14,2),
    avg_ticket NUMERIC(12,2),
    purchase_count INTEGER,
    last_purchase_date DATE,
    favorite_categories JSONB DEFAULT '[]',
    classification VARCHAR(20),
        -- 'vip', 'frequent', 'sporadic', 'inactive'
    days_since_last_purchase INTEGER,
    synced_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(odoo_partner_id, company)
);

CREATE INDEX IF NOT EXISTS idx_cm_company ON client_metrics_cache(company);
CREATE INDEX IF NOT EXISTS idx_cm_classification ON client_metrics_cache(classification);
CREATE INDEX IF NOT EXISTS idx_cr_due ON client_reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_cr_completed ON client_reminders(completed);
```

## Tareas

### 1. Servicio de métricas de clientes
Crear `backend/services/clientMetricsService.js`:

- `syncClientMetrics(company)` — Lee sale.orders de Odoo, calcula métricas, cachea en
  client_metrics_cache. Incluye: total_revenue, avg_ticket, purchase_count,
  last_purchase_date, categorías favoritas (agrupadas de los items de ventas)

- `classifyClient(metrics)` — Clasificación automática:
  - **VIP**: top 20% por facturación total
  - **Frecuente**: compra al menos 1 vez cada 15 días (avg_days_between_purchases ≤ 15)
  - **Esporádico**: compra pero con más de 15 días de intervalo
  - **Inactivo**: 30+ días sin comprar (days_since_last_purchase ≥ 30)

- `getRecommendations(partnerId, company)` — Basado en historial de Odoo:
  - Productos que compró antes y no compra hace 30+ días
  - Productos en su categoría favorita que ahora tienen precio más bajo (cruzar con price_history)
  - Categorías favoritas del cliente con productos nuevos (scrapeados recientemente)

- `getInactiveClients(company)` — Clientes con 30+ días sin comprar, ordenados por
  días de inactividad descendente

### 2. Rutas
Crear `backend/routes/clients.js`:

```
GET  /api/clients?company=neggo&classification=vip&search=
GET  /api/clients/:partnerId?company=neggo         — detalle: métricas + historial Odoo
GET  /api/clients/:partnerId/recommendations        — recomendaciones
GET  /api/clients/:partnerId/notes
POST /api/clients/:partnerId/notes                  — { note, company }
GET  /api/clients/:partnerId/reminders
POST /api/clients/:partnerId/reminders              — { reminder_text, due_date, company }
PUT  /api/clients/reminders/:id/complete
GET  /api/clients/inactive?company=neggo
GET  /api/clients/reminders/due                     — recordatorios de hoy y vencidos (dashboard)
POST /api/clients/sync-metrics                      — forzar sync (admin)
```

### 3. Sync automático
En `backend/jobs/scheduler.js`:
- Cron diario (ej: 7am) para `syncClientMetrics('neggo')`
- Calcular clasificaciones automáticamente después del sync

### 4. Páginas frontend

**`pages/clients/ClientDashboard.jsx`**
- Vista VIP: cards grandes con métricas detalladas (facturación, ticket promedio, frecuencia,
  categorías favoritas, tendencia). Top 10 por defecto, expandible.
- Vista resto: tabla paginada con filtros (clasificación, búsqueda por nombre)
- Indicador de recordatorios del día (notificación en header)

**`pages/clients/ClientDetail.jsx`** — ruta `/clientes/:partnerId`
- Header con nombre, clasificación (badge), días desde última compra
- Tabs: Métricas | Historial | Recomendaciones | Notas | Recordatorios
- Métricas: cards con total facturado, ticket promedio, frecuencia, categorías
- Historial: tabla de compras de Odoo (últimas 20 por defecto)
- Recomendaciones: lista de productos sugeridos con razón
- Notas: textarea para agregar + lista con fecha/autor
- Recordatorios: formulario de nueva fecha + lista de pendientes y completados

**`pages/clients/InactiveClients.jsx`** — ruta `/clientes/inactivos`
- Lista de clientes con 30+ días sin comprar
- Columnas: nombre, última compra, días inactivo, ticket promedio
- Botón rápido "Agregar recordatorio" por fila

### 5. Navegación
Agregar en `Layout.jsx` sección "Ventas":
```javascript
{ icon: '👥', label: 'Clientes', path: '/clientes', roles: ['admin', 'vendedor'] },
{ icon: '⚠️', label: 'Inactivos', path: '/clientes/inactivos', roles: ['admin', 'vendedor'] },
```

Agregar en `App.jsx`:
```jsx
<Route path="/clientes"           element={<ClientDashboard />} />
<Route path="/clientes/inactivos" element={<InactiveClients />} />
<Route path="/clientes/:id"       element={<ClientDetail />} />
```

## Criterios de éxito
- [ ] Clasificación VIP/frecuente/esporádico/inactivo funciona con datos reales de Odoo
- [ ] Vista VIP muestra top clientes con métricas detalladas
- [ ] Recomendaciones basadas en historial real de Odoo
- [ ] Notas + recordatorios con fechas funcionan
- [ ] Alerta de inactividad a 30 días
- [ ] Recordatorios del día aparecen en dashboard general
- [ ] Cron diario actualiza métricas automáticamente
