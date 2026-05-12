# Neggo App — Plan maestro de implementación

## Visión general

App web interna (PWA) para Neggo Mayorista que centraliza la gestión de productos, proveedores, pedidos, ventas y marketing, integrando datos scrapeados de proveedores con Odoo 19 (multi-empresa: Neggo + Preventas) via JSON-RPC.

Accesible desde cualquier dispositivo en red WiFi local (celu, tablet, PC).

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | React 18 (PWA) · Inline styles · Vite |
| Backend | Express.js (CommonJS) · Node.js 20 |
| Base de datos | PostgreSQL 15 (SQL parametrizado, sin ORM) |
| Integración ERP | Odoo 19 JSON-RPC (neggo.odoo.com, plan Custom) |
| Scraping | Puppeteer (Chrome headless en Docker) |
| OCR facturas | GPT-4o-mini (visión) |
| Infraestructura | Docker Compose en Windows · Nginx reverse proxy |
| Red | IP fija local (ej: 192.168.1.100:80) |

---

## Estructura de carpetas del proyecto

```
neggo-app/
├── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── backend/
│   ├── package.json
│   ├── server.js                    # Entry point Express
│   ├── config/
│   │   ├── database.js              # Pool PostgreSQL
│   │   └── odoo.js                  # Conexión JSON-RPC Odoo
│   ├── middleware/
│   │   ├── auth.js                  # JWT verificación
│   │   └── activityLog.js           # Logger de actividad por request
│   ├── routes/
│   │   ├── auth.js
│   │   ├── suppliers.js
│   │   ├── supplierRules.js
│   │   ├── scraping.js
│   │   ├── products.js
│   │   ├── productMappings.js
│   │   ├── priceAlerts.js
│   │   ├── preventas.js
│   │   ├── orders.js
│   │   ├── catalogs.js
│   │   └── users.js
│   ├── services/
│   │   ├── odooService.js           # Capa de abstracción JSON-RPC
│   │   ├── scrapingService.js       # Orquestador de scrapers
│   │   ├── matchingService.js       # Motor de matching productos
│   │   ├── priceAlertService.js     # Detección de cambios de precio
│   │   ├── rulesEngine.js           # Motor de reglas de negocio
│   │   ├── catalogService.js        # Generador de PDFs
│   │   └── imageService.js          # Generador de imágenes producto
│   ├── scrapers/
│   │   ├── baseScraper.js           # Clase base con lógica común
│   │   ├── cast.js
│   │   ├── mali.js
│   │   ├── elrey.js
│   │   ├── impotekno.js
│   │   ├── neggo-odoo.js            # Scraper del propio shop Odoo
│   │   └── registry.js              # Registro dinámico de scrapers
│   ├── jobs/
│   │   ├── scheduler.js             # Cron jobs (scraping, sync Odoo)
│   │   └── odooSync.js              # Sync periódico de cache
│   └── sql/
│       ├── schema.sql               # DDL completo
│       └── seeds.sql                # Datos iniciales (proveedores, reglas)
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   ├── manifest.json                # PWA manifest
│   ├── sw.js                        # Service Worker
│   └── src/
│       ├── main.jsx                 # Entry point React
│       ├── App.jsx                  # Router + layout principal
│       ├── api/
│       │   └── client.js            # Fetch wrapper con auth
│       ├── context/
│       │   └── AuthContext.jsx
│       ├── components/
│       │   ├── Layout.jsx           # Sidebar + header + content
│       │   ├── ProtectedRoute.jsx
│       │   └── common/              # Table, Modal, Badge, etc.
│       └── pages/
│           ├── Login.jsx
│           ├── Dashboard.jsx
│           ├── suppliers/
│           │   ├── SupplierList.jsx
│           │   ├── SupplierRules.jsx
│           │   └── CategoryRules.jsx
│           ├── products/
│           │   ├── SupplierProducts.jsx
│           │   ├── ProductMappings.jsx
│           │   └── PriceAlerts.jsx
│           ├── preventas/
│           │   ├── PreventasDashboard.jsx
│           │   ├── ClientOrders.jsx
│           │   ├── SupplierOrders.jsx
│           │   └── Catalogs.jsx
│           ├── scraping/
│           │   └── ScrapingPanel.jsx
│           └── admin/
│               ├── Users.jsx
│               └── ActivityLog.jsx
└── volumes/
    ├── pg_data/                     # PostgreSQL data
    └── storage/                     # Fotos, catálogos, etc.
```

---

## Fases de implementación

### Fase 1 — Fundación + Preventas (6-8 semanas)
**Objetivo**: Infraestructura completa + módulo de Preventas operativo.

Incluye:
- Docker Compose (Nginx + Express + PostgreSQL + Chrome headless)
- Auth con JWT + gestión de usuarios + activity tracking
- Servicio Odoo JSON-RPC (conexión, cache, CRUD)
- Motor de reglas de negocio (proveedores, descuentos, markups, categorías)
- Framework de scraping (clase base + migración de scrapers existentes)
- Sistema de matching de productos (auto por referencia + fuzzy por nombre + manual)
- Historial de precios + alertas de cambio con dashboard de revisión
- Módulo Preventas: pedidos de clientes, cruce con compras a proveedores, generación OC en Odoo
- Generador de catálogos PDF por categoría
- PWA shell responsive (sidebar, navegación, login)

### Fase 2 — Ventas + Clientes (3-4 semanas)
- Dashboard de clientes (datos de Odoo: historial compras, ticket promedio, categorías)
- Sistema de recomendaciones basado en patrones
- Seguimiento de estado de clientes
- Alertas de inactividad y oportunidades de upselling

### Fase 3 — Pedidos + Kanban + Ingreso mercadería (4-5 semanas)
- Armado de pedidos con recorridos optimizados por categoría
- Control con cámara (código de barras + foto + cantidad)
- Kanban de estado de pedidos en tiempo real
- Ingreso mercadería: OCR facturas (GPT-4o-mini), triangulación datos, gestión fotos

### Fase 4 — Marketing + Compras (3-4 semanas)
- Generador de imágenes individuales de producto
- Templates de catálogos configurables
- Planificación de publicaciones
- Estimaciones de ventas, comparativa precios, oportunidades de compra

---

## Fase 1 — Especificación detallada

### Base de datos PostgreSQL — Schema

```sql
-- =============================================
-- CORE: Usuarios y actividad
-- =============================================

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'operador',
        -- roles: 'admin', 'operador', 'vendedor'
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE activity_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    module VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INTEGER,
    metadata JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_user ON activity_log(user_id);
CREATE INDEX idx_activity_module ON activity_log(module);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);

-- =============================================
-- PROVEEDORES Y REGLAS DE NEGOCIO
-- =============================================

CREATE TABLE suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    website_url VARCHAR(500),
    scraper_key VARCHAR(50),
        -- clave para el registry de scrapers: 'cast', 'mali', etc.
    price_format VARCHAR(20) DEFAULT 'ar',
        -- 'ar' = 1.000,00 | 'inv' = 1,000.00
    is_published BOOLEAN DEFAULT true,
    default_discount NUMERIC(5,2) DEFAULT 0,
    default_markup NUMERIC(5,2) DEFAULT 0,
    scrape_schedule VARCHAR(50),
        -- cron expression: '0 6 * * *' = todos los días a las 6am
    last_scraped_at TIMESTAMP,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE supplier_category_rules (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    source_category VARCHAR(200) NOT NULL,
        -- categoría tal como viene del scraping
    dest_category VARCHAR(200) NOT NULL,
        -- categoría estandarizada para Neggo/Preventas
    discount_override NUMERIC(5,2),
        -- si es NULL, usa el default del supplier
    markup_override NUMERIC(5,2),
        -- si es NULL, usa el default del supplier
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, source_category)
);

CREATE INDEX idx_cat_rules_supplier ON supplier_category_rules(supplier_id);

-- =============================================
-- PRODUCTOS SCRAPEADOS
-- =============================================

CREATE TABLE supplier_products (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    sku VARCHAR(100),
        -- código del producto en el proveedor
    name VARCHAR(500) NOT NULL,
    raw_price NUMERIC(12,2),
        -- precio tal como viene del scraping (ya parseado a número)
    offer_price NUMERIC(12,2),
    image_url VARCHAR(1000),
    product_url VARCHAR(1000),
    source_category VARCHAR(200),
        -- categoría original del scraping
    barcode VARCHAR(50),
    available BOOLEAN DEFAULT true,
    last_scraped_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, sku)
);

CREATE INDEX idx_sp_supplier ON supplier_products(supplier_id);
CREATE INDEX idx_sp_name ON supplier_products(name);
CREATE INDEX idx_sp_sku ON supplier_products(sku);
CREATE INDEX idx_sp_available ON supplier_products(available);

-- =============================================
-- PRECIOS: HISTORIAL Y ALERTAS
-- =============================================

CREATE TABLE price_history (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    price NUMERIC(12,2) NOT NULL,
    offer_price NUMERIC(12,2),
    available BOOLEAN DEFAULT true,
    scraped_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ph_product ON price_history(supplier_product_id);
CREATE INDEX idx_ph_scraped ON price_history(scraped_at DESC);

CREATE TABLE price_alerts (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL,
        -- 'price_increase', 'price_decrease', 'out_of_stock', 'back_in_stock'
    old_price NUMERIC(12,2),
    new_price NUMERIC(12,2),
    pct_change NUMERIC(6,2),
    linked_odoo_products JSONB DEFAULT '[]',
        -- [{odoo_id, company, name, current_cost, current_price}]
    status VARCHAR(20) DEFAULT 'pending',
        -- 'pending', 'approved', 'dismissed'
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_alerts_status ON price_alerts(status);
CREATE INDEX idx_alerts_created ON price_alerts(created_at DESC);

-- =============================================
-- VÍNCULOS: PRODUCTO PROVEEDOR <-> PRODUCTO ODOO
-- =============================================

CREATE TABLE product_mappings (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
        -- product.product ID en Odoo
    odoo_company VARCHAR(20) NOT NULL,
        -- 'neggo' o 'preventas'
    odoo_internal_ref VARCHAR(100),
        -- referencia interna en Odoo para referencia rápida
    match_type VARCHAR(20) NOT NULL,
        -- 'auto_ref' (por referencia interna), 'auto_fuzzy' (por nombre),
        -- 'manual' (vinculado a mano)
    match_confidence NUMERIC(4,2),
        -- 0.00 a 1.00, relevante para fuzzy matching
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_product_id, odoo_product_id, odoo_company)
);

CREATE INDEX idx_pm_supplier_product ON product_mappings(supplier_product_id);
CREATE INDEX idx_pm_odoo ON product_mappings(odoo_product_id, odoo_company);

-- =============================================
-- CACHE DE ODOO (sync periódico)
-- =============================================

CREATE TABLE odoo_products_cache (
    id SERIAL PRIMARY KEY,
    odoo_id INTEGER NOT NULL,
    company VARCHAR(20) NOT NULL,
    name VARCHAR(500),
    internal_ref VARCHAR(100),
    barcode VARCHAR(50),
    list_price NUMERIC(12,2),
    standard_price NUMERIC(12,2),
    categ_name VARCHAR(200),
    image_url VARCHAR(1000),
    qty_available NUMERIC(12,2),
    active BOOLEAN DEFAULT true,
    synced_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(odoo_id, company)
);

CREATE INDEX idx_opc_ref ON odoo_products_cache(internal_ref);
CREATE INDEX idx_opc_company ON odoo_products_cache(company);
CREATE INDEX idx_opc_name ON odoo_products_cache(name);

-- =============================================
-- PREVENTAS: PEDIDOS Y ÓRDENES
-- =============================================

CREATE TABLE preventa_client_orders (
    id SERIAL PRIMARY KEY,
    client_name VARCHAR(200) NOT NULL,
    client_phone VARCHAR(50),
    odoo_partner_id INTEGER,
        -- res.partner ID en Odoo si existe
    status VARCHAR(30) DEFAULT 'pendiente',
        -- 'pendiente', 'procesando', 'comprado', 'recibido', 'entregado', 'cancelado'
    notes TEXT,
    total_estimated NUMERIC(12,2),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE preventa_client_order_items (
    id SERIAL PRIMARY KEY,
    client_order_id INTEGER REFERENCES preventa_client_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES supplier_products(id),
    product_name VARCHAR(500) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(12,2),
        -- precio de venta al cliente (calculado con reglas)
    unit_cost NUMERIC(12,2),
        -- costo (calculado con reglas)
    image_url VARCHAR(1000),
    notes TEXT
);

CREATE INDEX idx_pcoi_order ON preventa_client_order_items(client_order_id);

CREATE TABLE preventa_supplier_orders (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    status VARCHAR(30) DEFAULT 'borrador',
        -- 'borrador', 'enviado', 'confirmado', 'recibido', 'parcial'
    odoo_purchase_order_id INTEGER,
        -- purchase.order ID creado en Odoo
    total_estimated NUMERIC(12,2),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE preventa_supplier_order_items (
    id SERIAL PRIMARY KEY,
    supplier_order_id INTEGER REFERENCES preventa_supplier_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES supplier_products(id),
    client_order_item_id INTEGER REFERENCES preventa_client_order_items(id),
        -- trazabilidad: de qué pedido de cliente viene
    product_name VARCHAR(500) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_cost NUMERIC(12,2),
    notes TEXT
);

CREATE INDEX idx_psoi_order ON preventa_supplier_order_items(supplier_order_id);

-- =============================================
-- CATÁLOGOS GENERADOS
-- =============================================

CREATE TABLE catalogs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(30) NOT NULL,
        -- 'preventas', 'neggo', 'custom'
    category VARCHAR(200),
    supplier_id INTEGER REFERENCES suppliers(id),
    file_path VARCHAR(500),
    product_count INTEGER,
    generated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SCRAPING: LOG DE EJECUCIONES
-- =============================================

CREATE TABLE scraping_runs (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    status VARCHAR(20) NOT NULL,
        -- 'running', 'completed', 'failed', 'partial'
    products_found INTEGER DEFAULT 0,
    products_new INTEGER DEFAULT 0,
    products_updated INTEGER DEFAULT 0,
    price_changes INTEGER DEFAULT 0,
    errors JSONB DEFAULT '[]',
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP,
    triggered_by INTEGER REFERENCES users(id)
);
```

### Motor de reglas de negocio — Lógica

```javascript
// rulesEngine.js — Calcula costo y precio de venta según empresa y reglas

function calculatePrices(supplierProduct, supplier, categoryRule, company) {
    const rawPrice = supplierProduct.raw_price;

    // Determinar descuento: override de categoría > default de proveedor
    const discount = categoryRule && categoryRule.discount_override !== null
        ? categoryRule.discount_override
        : supplier.default_discount;

    // Determinar markup: override de categoría > default de proveedor
    const markup = categoryRule && categoryRule.markup_override !== null
        ? categoryRule.markup_override
        : supplier.default_markup;

    // Costo: igual para ambas empresas
    const cost = rawPrice * (1 - discount / 100);

    // Precio de venta: fórmula distinta según empresa
    let salePrice;
    if (company === 'neggo') {
        // Neggo: markup sobre COSTO
        salePrice = cost * (1 + markup / 100);
    } else {
        // Preventas: markup sobre PRECIO PROVEEDOR
        salePrice = rawPrice * (1 + markup / 100);
    }

    return {
        raw_price: rawPrice,
        discount_pct: discount,
        markup_pct: markup,
        cost: Math.round(cost * 100) / 100,
        sale_price: Math.ceil(salePrice), // redondeo para arriba
        company
    };
}
```

### Servicio Odoo JSON-RPC — Estructura

```javascript
// odooService.js — Conexión a Odoo 19 via JSON-RPC

const ODOO_URL = 'https://neggo.odoo.com';
const ODOO_DB = 'neggo';  // nombre de la base de datos
const ODOO_API_KEY = process.env.ODOO_API_KEY;
const ODOO_USER_ID = process.env.ODOO_USER_ID;

// Métodos principales:
// - authenticate()
// - searchRead(model, domain, fields, company)
// - create(model, values, company)
// - write(model, ids, values, company)
// - callMethod(model, method, args, company)

// Modelos Odoo que se consumen:
// - product.product (productos)
// - product.template (templates de productos)
// - res.partner (clientes/proveedores)
// - sale.order / sale.order.line (cotizaciones/ventas)
// - purchase.order / purchase.order.line (órdenes de compra)
// - account.move (facturas)
// - stock.quant (stock disponible)

// Multi-empresa: cada llamada incluye el company_id en el context
// para operar en Neggo o Preventas según corresponda.
```

### Scraper base — Patrón

```javascript
// scrapers/baseScraper.js

class BaseScraper {
    constructor(supplier, browser) {
        this.supplier = supplier;
        this.browser = browser; // instancia de Puppeteer
        this.products = [];
        this.errors = [];
    }

    // Métodos que cada scraper debe implementar:
    // - async getCategories() → [{url, name}]
    // - async scrapeCategory(page, category) → [{name, sku, price, image_url, ...}]
    // - parsePrice(priceText) → float

    // Métodos comunes (heredados):
    // - async run() → orquesta el scraping completo
    // - async saveToDB(products) → inserta/actualiza en supplier_products
    // - async detectPriceChanges() → compara con price_history, crea alertas
    // - handlePagination(page) → lógica genérica de paginación
    // - scrollForLazyLoad(page) → scroll para cargar imágenes lazy
}
```

### API endpoints — Fase 1

```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/users
POST   /api/users
PUT    /api/users/:id
GET    /api/activity-log?module=&user=&from=&to=

GET    /api/suppliers
POST   /api/suppliers
PUT    /api/suppliers/:id
GET    /api/suppliers/:id/rules
POST   /api/suppliers/:id/rules
PUT    /api/suppliers/:id/rules/:ruleId
DELETE /api/suppliers/:id/rules/:ruleId
POST   /api/suppliers/:id/rules/import-excel
    (migración desde Maestro Preventas.xlsx)

POST   /api/scraping/:supplierId/run
GET    /api/scraping/runs?supplier=&status=
GET    /api/scraping/runs/:runId

GET    /api/products/supplier?supplier=&category=&search=
GET    /api/products/supplier/:id
GET    /api/products/supplier/:id/price-history
GET    /api/products/supplier/:id/calculate-prices
    (preview de costo/venta según reglas)

GET    /api/products/odoo?company=&search=&category=
POST   /api/products/odoo/sync
    (fuerza sync del cache)

GET    /api/mappings?supplier=&odoo_company=&unmapped=true
POST   /api/mappings
POST   /api/mappings/auto-match
    (ejecuta matching automático)
DELETE /api/mappings/:id

GET    /api/alerts?status=pending&type=&supplier=
PUT    /api/alerts/:id/approve
PUT    /api/alerts/:id/dismiss
GET    /api/alerts/summary

GET    /api/preventas/client-orders?status=&search=
POST   /api/preventas/client-orders
PUT    /api/preventas/client-orders/:id
GET    /api/preventas/client-orders/:id/items

POST   /api/preventas/generate-supplier-orders
    (agrupa items por proveedor → genera órdenes de compra)
GET    /api/preventas/supplier-orders?supplier=&status=
PUT    /api/preventas/supplier-orders/:id
POST   /api/preventas/supplier-orders/:id/send-to-odoo
    (crea purchase.order en Odoo)

POST   /api/catalogs/generate
GET    /api/catalogs?type=&category=
GET    /api/catalogs/:id/download
```

### Docker Compose

```yaml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./frontend/dist:/usr/share/nginx/html:ro
    depends_on:
      - backend
    restart: unless-stopped

  backend:
    build: ./backend
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://neggo:neggo_pass@postgres:5432/neggo_app
      - JWT_SECRET=${JWT_SECRET}
      - ODOO_URL=https://neggo.odoo.com
      - ODOO_DB=neggo
      - ODOO_USER_ID=${ODOO_USER_ID}
      - ODOO_API_KEY=${ODOO_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - ./volumes/storage:/app/storage
    depends_on:
      - postgres
      - chrome
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=neggo
      - POSTGRES_PASSWORD=neggo_pass
      - POSTGRES_DB=neggo_app
    volumes:
      - ./volumes/pg_data:/var/lib/postgresql/data
      - ./backend/sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - ./backend/sql/seeds.sql:/docker-entrypoint-initdb.d/02-seeds.sql
    restart: unless-stopped

  chrome:
    image: browserless/chrome:latest
    environment:
      - MAX_CONCURRENT_SESSIONS=2
      - CONNECTION_TIMEOUT=120000
    restart: unless-stopped
```

### Nginx config

```nginx
server {
    listen 80;
    server_name _;

    # Frontend (PWA)
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }

    # API Backend
    location /api/ {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 50M;
    }

    # Storage (fotos, catálogos)
    location /storage/ {
        alias /usr/share/nginx/html/storage/;
        expires 7d;
    }
}
```

### Páginas frontend — Fase 1

1. **Login** — Usuario + contraseña, JWT
2. **Dashboard** — Resumen: alertas pendientes, último scraping, pedidos activos
3. **Proveedores** — CRUD de proveedores con sus datos de conexión
4. **Reglas por proveedor** — Panel con reglas globales (dto, markup) + tabla de reglas por categoría con mapeo origen→destino
5. **Panel de scraping** — Botón "ejecutar" por proveedor, historial de ejecuciones, estado en tiempo real
6. **Productos de proveedores** — Tabla con filtros (proveedor, categoría, disponibilidad), preview de precio calculado
7. **Vínculos de productos** — Interfaz para ver/crear/eliminar vínculos entre producto scrapeado y producto Odoo, con sugerencias automáticas
8. **Alertas de precios** — Lista de alertas pendientes con acción aprobar/descartar, comparativa entre proveedores
9. **Preventas: Pedidos clientes** — Crear pedido seleccionando productos del catálogo scrapeado, con imágenes
10. **Preventas: Órdenes a proveedores** — Agrupación automática de items por proveedor, envío a Odoo como purchase.order
11. **Preventas: Catálogos** — Generar PDF por categoría/proveedor, listar catálogos generados
12. **Usuarios** — CRUD de usuarios y roles (solo admin)
13. **Log de actividad** — Tabla filtrable con todas las acciones

---

## Orden de implementación dentro de Fase 1

### Sprint 1 (semana 1-2): Infraestructura
- Docker Compose funcional (todos los servicios arrancando)
- PostgreSQL con schema creado
- Express con health check
- Auth (login, JWT, middleware)
- Activity log middleware
- Nginx sirviendo frontend estático
- PWA shell: Login + Layout con sidebar + rutas vacías

### Sprint 2 (semana 3-4): Proveedores + Reglas + Scraping
- CRUD proveedores (backend + frontend)
- CRUD reglas de negocio por proveedor + categoría
- Herramienta de importación desde Maestro Preventas.xlsx
- Framework de scraping (baseScraper + conexión a browserless/chrome)
- Migración de al menos 3 scrapers (Cast, Mali, Impotekno)
- Panel de scraping con ejecución manual y log

### Sprint 3 (semana 5-6): Productos + Matching + Alertas
- Servicio Odoo JSON-RPC operativo
- Sync de productos Odoo → cache PostgreSQL
- Motor de matching (por referencia interna + fuzzy por nombre)
- UI de vínculos de productos
- Detección de cambios de precio + historial
- Dashboard de alertas con revisión manual
- Motor de reglas integrado (cálculo costo/venta en preview)

### Sprint 4 (semana 7-8): Preventas + Catálogos
- Carga de pedidos de clientes con imágenes
- Generación automática de órdenes a proveedores
- Envío de purchase.order a Odoo via JSON-RPC
- Generador de catálogos PDF (migrar lógica de ReportLab a PDFKit en Node)
- Dashboard de Preventas con métricas
- Testing integral + ajustes + deploy en red local
