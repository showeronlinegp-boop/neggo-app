# Agente 14 — Compras inteligentes: estimaciones + competencia + oportunidades (Fase 4)

## Objetivo
Estimaciones de venta con estacionalidad, scraping de competidores, comparativa de precios
proveedor vs competencia, alertas de stock bajo, y detección de oportunidades de compra.

## Skills a leer
- `docs/skills/scraper-patterns/SKILL.md` (para scrapers de competidores)
- `docs/skills/odoo-integration/SKILL.md` (stock, ventas históricas)

## Dependencias
- Fases 1-3 completas (incluyendo Agentes 10-13)

## Schema nuevo

```sql
CREATE TABLE IF NOT EXISTS competitors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    website_url VARCHAR(500),
    scraper_key VARCHAR(50),
    login_user VARCHAR(200),
    login_password VARCHAR(200),
    active BOOLEAN DEFAULT true,
    last_scraped_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competitor_products (
    id SERIAL PRIMARY KEY,
    competitor_id INTEGER REFERENCES competitors(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    sku VARCHAR(100),
    price NUMERIC(12,2),
    image_url VARCHAR(1000),
    product_url VARCHAR(1000),
    category VARCHAR(200),
    available BOOLEAN DEFAULT true,
    last_scraped_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(competitor_id, sku)
);

CREATE TABLE IF NOT EXISTS competitor_product_mappings (
    id SERIAL PRIMARY KEY,
    competitor_product_id INTEGER REFERENCES competitor_products(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
    match_type VARCHAR(20) NOT NULL,
    match_confidence NUMERIC(4,2),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_alerts (
    id SERIAL PRIMARY KEY,
    odoo_product_id INTEGER NOT NULL,
    product_name VARCHAR(500),
    current_qty NUMERIC(12,2),
    min_qty NUMERIC(12,2),
    avg_daily_sales NUMERIC(8,2),
    days_of_stock INTEGER,               -- días estimados de stock restante
    status VARCHAR(20) DEFAULT 'active', -- active, resolved, dismissed
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_suggestions (
    id SERIAL PRIMARY KEY,
    odoo_product_id INTEGER NOT NULL,
    product_name VARCHAR(500),
    suggestion_type VARCHAR(30) NOT NULL,
        -- 'low_stock', 'price_opportunity', 'seasonal', 'reorder'
    reason TEXT NOT NULL,
    best_supplier_id INTEGER REFERENCES suppliers(id),
    best_price NUMERIC(12,2),
    competitor_prices JSONB DEFAULT '[]',
    priority VARCHAR(10) DEFAULT 'medium', -- low, medium, high, urgent
    status VARCHAR(20) DEFAULT 'pending',  -- pending, acted, dismissed
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_seasonality (
    id SERIAL PRIMARY KEY,
    category VARCHAR(200) NOT NULL,
    month INTEGER NOT NULL,              -- 1-12
    avg_sales NUMERIC(12,2),
    trend VARCHAR(20),                   -- 'peak', 'high', 'normal', 'low'
    calculated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(category, month)
);

CREATE INDEX IF NOT EXISTS idx_cp_competitor ON competitor_products(competitor_id);
CREATE INDEX IF NOT EXISTS idx_sa_status ON stock_alerts(status);
CREATE INDEX IF NOT EXISTS idx_ps_type ON purchase_suggestions(suggestion_type);
CREATE INDEX IF NOT EXISTS idx_ps_priority ON purchase_suggestions(priority);
CREATE INDEX IF NOT EXISTS idx_ps_status ON purchase_suggestions(status);
```

## Tareas

### 1. Scrapers de competidores
- Reutilizar `BaseScraper` del Agente 05 — el framework ya existe
- CRUD de competidores similar a proveedores (tabla `competitors`)
- Los scrapers de competidores van en `backend/scrapers/competitors/`
- Matching de productos del competidor con odoo_products_cache (misma lógica que matchingService)
- Schedule: semanal o bajo demanda

### 2. Servicio de estimaciones de venta
Crear `backend/services/salesForecastService.js`:

- `calculateSeasonality()` — Analiza sale.orders de Odoo por categoría/mes de los últimos
  2 años. Detecta picos y valles. Cachea en `sales_seasonality`.
  - peak: mes con ventas > 150% del promedio anual
  - high: 110-150%
  - normal: 70-110%
  - low: < 70%

- `forecastDemand(productId, days)` — Proyección:
  - Velocidad de venta diaria promedio (últimos 30 días en Odoo)
  - Ajuste por estacionalidad del mes actual (multiplicador de sales_seasonality)
  - Retorna: `{ units_estimated, daily_velocity, seasonality_multiplier }`

### 3. Servicio de comparativa de precios
Crear `backend/services/priceComparisonService.js`:

- `compareSupplierPrices(odooProductId)` — Mismo producto en múltiples proveedores:
  - Precio raw de cada supplier_product vinculado + precio calculado con reglas Neggo
  - Tendencia: comparar con price_history de los últimos 30 días (subiendo/bajando/estable)
  - Mejor precio actual

- `compareWithCompetitors(odooProductId)` — Precio propio vs competidores:
  - Precio de venta Neggo vs precio de competidor (de competitor_products)
  - Margen de diferencia en % y pesos

### 4. Servicio de oportunidades y stock
Crear `backend/services/purchaseIntelligenceService.js`:

- `detectLowStock()` — Lee stock de Odoo (qty_available), calcula días restantes:
  - `days = qty_available / avg_daily_sales`
  - < 7 días → urgente. < 15 → alta. < 30 → media.
  - Inserta en `stock_alerts`

- `detectPriceOpportunities()` — Bajadas en proveedores:
  - Cruzar price_history: productos con precio más bajo que hace 30 días
  - Si además tienen alta demanda (avg_daily_sales alto) → oportunidad de compra
  - Inserta en `purchase_suggestions` con type='price_opportunity'

- `detectSeasonalOpportunities()` — Si el mes próximo es `peak` para una categoría,
  sugerir stockear antes. type='seasonal'

- `generatePurchaseSuggestions()` — Consolida todos los tipos en purchase_suggestions
- Cron: diario (ej: 6am, antes del scraping)

### 5. Rutas
Crear `backend/routes/competitors.js` y `backend/routes/purchases.js`:

```
-- Competidores
GET  /api/competitors
POST /api/competitors
PUT  /api/competitors/:id
POST /api/competitors/:id/scrape

-- Inteligencia de compras
GET  /api/purchases/compare/:productId           — comparativa proveedores
GET  /api/purchases/compare-competitors/:productId
GET  /api/purchases/stock-alerts                 — filtros: status, priority
PUT  /api/purchases/stock-alerts/:id/dismiss
GET  /api/purchases/suggestions                  — filtros: type, priority, status
PUT  /api/purchases/suggestions/:id/act
PUT  /api/purchases/suggestions/:id/dismiss
GET  /api/purchases/seasonality?category=
GET  /api/purchases/forecast/:productId
POST /api/purchases/calculate-seasonality        — forzar cálculo (admin)
```

### 6. Páginas frontend

**`pages/purchasing/PriceComparison.jsx`** — ruta `/compras/comparativa`
- Input: buscar producto Odoo
- Tabla con todos los proveedores que tienen ese producto vinculado
- Columnas: proveedor, precio raw, descuento, costo, precio venta, tendencia (↑↓→)
- Segunda sección: comparativa con competidores (precio nuestro vs precio de ellos)

**`pages/purchasing/StockAlerts.jsx`** — ruta `/compras/stock`
- Lista de alertas con indicador visual de urgencia (colores)
- Columnas: producto, stock actual, ventas/día, días restantes estimados, prioridad
- Botón "Desestimar" por alerta

**`pages/purchasing/PurchaseSuggestions.jsx`** — ruta `/compras/sugerencias`
- Lista filtrable por tipo (stock bajo, oportunidad precio, estacional, reposición)
- Columnas: producto, tipo, razón, proveedor sugerido, precio, prioridad
- Botones: "Actuar" (abre comparativa) / "Desestimar"

**`pages/purchasing/Seasonality.jsx`** — ruta `/compras/estacionalidad`
- Selector de categoría
- Tabla mensual con tendencia visual (colores: peak=rojo, high=naranja, normal=blanco, low=gris)
- Indicador del mes actual en el calendario

**`pages/purchasing/Competitors.jsx`** — ruta `/compras/competidores`
- CRUD de competidores con botón "Scrapear"
- Historial de precios del competidor por producto

### 7. Navegación
Agregar en `Layout.jsx` sección "Compras":
```javascript
{ icon: '📊', label: 'Comparativa',   path: '/compras/comparativa',  roles: ['admin'] },
{ icon: '⚠️', label: 'Stock bajo',    path: '/compras/stock',         roles: ['admin'] },
{ icon: '💡', label: 'Sugerencias',   path: '/compras/sugerencias',   roles: ['admin'] },
{ icon: '📈', label: 'Estacionalidad',path: '/compras/estacionalidad',roles: ['admin'] },
{ icon: '🏪', label: 'Competidores',  path: '/compras/competidores',  roles: ['admin'] },
```

## Criterios de éxito
- [ ] Scrapers de competidores funcionan con el mismo framework de BaseScraper
- [ ] Comparativa muestra todos los proveedores de un producto con precios calculados
- [ ] Comparativa incluye precios de competidores cuando están disponibles
- [ ] Alertas de stock bajo calculan días restantes con velocidad de venta real
- [ ] Estacionalidad detecta picos por categoría/mes con datos históricos de Odoo
- [ ] Sugerencias de compra combinan stock bajo + oportunidad de precio + temporada
- [ ] Forecast de demanda ajustado por estacionalidad
