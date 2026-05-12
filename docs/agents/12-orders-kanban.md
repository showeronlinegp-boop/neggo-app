# Agente 12 — Pedidos Neggo: picking grupal + control + Kanban (Fase 3)

## Objetivo
Armado de pedidos con picking grupal por zona de categoría del depósito, control por empleado
diferente con escáner de código de barras (cámara o lector USB), tracking de quién armó/controló,
y Kanban visual de estados.

## Skills a leer
- `docs/skills/odoo-integration/SKILL.md` (sale.order)

## Dependencias
- Fase 1 completa

## Schema nuevo

```sql
CREATE TABLE IF NOT EXISTS neggo_orders (
    id SERIAL PRIMARY KEY,
    odoo_sale_order_id INTEGER NOT NULL,
    odoo_order_name VARCHAR(50),         -- ej: S00042
    partner_name VARCHAR(200),
    partner_id INTEGER,
    status VARCHAR(20) DEFAULT 'nuevo',
        -- nuevo, armando, armado, controlando, controlado, despachado
    assembled_by INTEGER REFERENCES users(id),
    assembled_at TIMESTAMP,
    checked_by INTEGER REFERENCES users(id),
    checked_at TIMESTAMP,
    dispatched_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS neggo_order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES neggo_orders(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
    product_name VARCHAR(500),
    barcode VARCHAR(50),
    image_url VARCHAR(1000),
    quantity_ordered INTEGER NOT NULL,
    quantity_picked INTEGER DEFAULT 0,
    quantity_checked INTEGER DEFAULT 0,
    category VARCHAR(200),               -- para agrupar por zona del depósito
    pick_confirmed BOOLEAN DEFAULT false,
    check_confirmed BOOLEAN DEFAULT false,
    check_notes TEXT                     -- ej: "faltante", "dañado"
);

CREATE TABLE IF NOT EXISTS neggo_picking_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    order_ids JSONB NOT NULL,            -- [1, 2, 3] IDs de neggo_orders
    status VARCHAR(20) DEFAULT 'active',
    zone_sequence JSONB,                 -- ["Librería", "Juguetes", ...] orden de recorrido
    current_zone VARCHAR(200),
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_no_status ON neggo_orders(status);
CREATE INDEX IF NOT EXISTS idx_no_odoo ON neggo_orders(odoo_sale_order_id);
CREATE INDEX IF NOT EXISTS idx_noi_order ON neggo_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_nps_user ON neggo_picking_sessions(user_id);
```

## Tareas

### 1. Sync de pedidos desde Odoo
En `backend/services/pickingService.js`:
- `syncOrdersFromOdoo()` — Lee sale.orders confirmados de Odoo que no existen aún en
  neggo_orders. Para cada uno: crea neggo_order + neggo_order_items con producto,
  barcode, imagen (de odoo_products_cache), categoría.
- Cron: cada 30 minutos + endpoint manual `POST /api/neggo-orders/sync`

### 2. Picking grupal por zona
En `backend/services/pickingService.js`:

- `createPickingSession(orderIds, userId)` — Crear sesión de picking grupal con varios pedidos

- `generateZoneRoute(orderIds)` — Agrupa todos los items de todos los pedidos por categoría
  y genera la secuencia de zonas ordenada por volumen descendente (zona con más items primero):
  ```javascript
  // Retorna: ["Librería", "Juguetes", "Tecnología"]
  // Con detalle por zona: { zona, items: [{product, quantity_total, orders: [{orderId, qty}]}] }
  ```

- `getZoneItems(sessionId, zone)` — Items a recoger en esa zona, con cantidades sumadas
  y desglose por pedido de cliente (para saber a quién va cada cosa)

- `confirmPick(sessionId, itemId, quantity)` — Confirmar recogida de un item

- `finishSession(sessionId)` — Cerrar sesión, marcar pedidos como 'armado'

### 3. Control de pedidos
En `backend/services/checkingService.js`:

- `startChecking(orderId, userId)` — Iniciar control. Validar que `userId !== assembled_by`.
  Si el mismo usuario quiere controlar lo que armó, retornar error.

- `checkItem(orderId, barcode)` — Escanear código de barras:
  1. Buscar item por barcode en los items del pedido
  2. Si coincide → incrementar quantity_checked
  3. Si no pertenece al pedido → error "producto no pertenece a este pedido"
  4. Si quantity_checked > quantity_ordered → warning "cantidad mayor a la pedida"

- `finishChecking(orderId)` — Cerrar control, marcar como 'controlado'

### 4. Rutas
Crear `backend/routes/neggoOrders.js`:

```
GET  /api/neggo-orders                            — lista con filtros (status, fecha, cliente)
GET  /api/neggo-orders/kanban                     — todos los pedidos agrupados por status
POST /api/neggo-orders/sync                       — sync desde Odoo (manual)
POST /api/neggo-orders/picking-session            — crear sesión de picking grupal
GET  /api/neggo-orders/picking-session/:id        — estado de sesión actual
PUT  /api/neggo-orders/picking-session/:id/confirm-pick  — confirmar item
POST /api/neggo-orders/:id/start-check            — iniciar control
POST /api/neggo-orders/:id/scan                   — escanear barcode
POST /api/neggo-orders/:id/finish-check           — finalizar control
PUT  /api/neggo-orders/:id/dispatch               — despachar
```

### 5. Páginas frontend

**`pages/orders/OrdersKanban.jsx`** — ruta `/pedidos/kanban`
- Tablero Kanban: 4 columnas (Nuevo / Armado / Controlado / Despachado)
- PC: drag-and-drop entre columnas
- Mobile: tap en el pedido → menú de cambio de estado
- Card del pedido: nombre cliente, número Odoo, items count, quién armó/controló
- Filtros: fecha, cliente

**`pages/orders/PickingSession.jsx`** — ruta `/pedidos/picking`
- Paso 1: selección de pedidos para armar juntos (checkboxes en lista)
- Paso 2: vista por zona con secuencia generada. Por cada zona:
  - Nombre de la zona (ej: "Librería — 12 items")
  - Lista de items con cantidad total + desglose por pedido de cliente
  - Checkbox por item para confirmar recogida
- Paso 3: resumen final → botón "Finalizar sesión"
- Optimizado para tablet (fuente grande, tap fácil)

**`pages/orders/OrderCheck.jsx`** — ruta `/pedidos/:id/control`
- Vista simplificada: foto del artículo + nombre + código de barras + cantidad pedida
- Input de escaneo de código de barras (compatible con lector USB o cámara)
- Indicador visual: ✅ controlado / ❌ error / ⏳ pendiente
- Alerta inmediata si cantidad no coincide o producto no pertenece al pedido
- Al finalizar: muestra resumen y vuelve al Kanban

### 6. Navegación
Agregar en `Layout.jsx` sección "Pedidos Neggo":
```javascript
{ icon: '📦', label: 'Kanban pedidos', path: '/pedidos/kanban', roles: ['admin', 'operador'] },
{ icon: '🚶', label: 'Armar pedido',   path: '/pedidos/picking', roles: ['admin', 'operador'] },
```

Agregar en `App.jsx`:
```jsx
<Route path="/pedidos/kanban"         element={<OrdersKanban />} />
<Route path="/pedidos/picking"        element={<PickingSession />} />
<Route path="/pedidos/:id/control"    element={<OrderCheck />} />
```

## Criterios de éxito
- [ ] Sync desde Odoo trae sale.orders confirmados correctamente
- [ ] Picking grupal agrupa items de varios pedidos por zona
- [ ] Vista por zona muestra cantidades totales + desglose por pedido
- [ ] Control valida por código de barras (cámara o lector USB)
- [ ] No permite que el mismo usuario arme Y controle el mismo pedido
- [ ] Kanban muestra estados reales con timestamps
- [ ] Se trackea quién armó y quién controló con timestamps
