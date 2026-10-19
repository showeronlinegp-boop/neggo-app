-- =============================================
-- Neggo App — Schema completo
-- =============================================

-- =============================================
-- CORE: Usuarios y actividad
-- =============================================

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'operador',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
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

CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_module ON activity_log(module);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);

-- =============================================
-- PROVEEDORES Y REGLAS DE NEGOCIO
-- =============================================

CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    website_url VARCHAR(500),
    scraper_key VARCHAR(50),
    price_format VARCHAR(20) DEFAULT 'ar',
    default_discount NUMERIC(5,2) DEFAULT 0,
    markup_neggo NUMERIC(5,2) DEFAULT 0,
    markup_preventas NUMERIC(5,2) DEFAULT 0,
    scrape_config JSONB DEFAULT '{}',
    last_scraped_at TIMESTAMP,
    active BOOLEAN DEFAULT true,
    scrape_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_category_rules (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    source_category VARCHAR(200) NOT NULL,
        -- categoría tal como viene del scraping
    dest_category_neggo VARCHAR(200),
        -- categoría destino en empresa Neggo (null = no aplica a Neggo)
    dest_category_preventas VARCHAR(200),
        -- categoría destino en empresa Preventas (null = no aplica a Preventas)
    ignored BOOLEAN DEFAULT false,
        -- true = se descarta completamente, no genera productos ni alertas
    discount_override NUMERIC(5,2),
    markup_neggo_override NUMERIC(5,2),
    markup_preventas_override NUMERIC(5,2),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, source_category)
);

CREATE INDEX IF NOT EXISTS idx_cat_rules_supplier ON supplier_category_rules(supplier_id);

-- =============================================
-- PRODUCTOS SCRAPEADOS
-- =============================================

CREATE TABLE IF NOT EXISTS supplier_products (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    sku VARCHAR(100),
    name VARCHAR(500) NOT NULL,
    raw_price NUMERIC(12,2),
    offer_price NUMERIC(12,2),
    image_url VARCHAR(1000),
    product_url VARCHAR(1000),
    source_category VARCHAR(200),
    barcode VARCHAR(50),
    available BOOLEAN DEFAULT true,
    last_scraped_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    name_key VARCHAR(500),
    UNIQUE(supplier_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sp_name ON supplier_products(name);
CREATE INDEX IF NOT EXISTS idx_sp_sku ON supplier_products(sku);
CREATE INDEX IF NOT EXISTS idx_sp_available ON supplier_products(available);
CREATE INDEX IF NOT EXISTS idx_sp_name_key ON supplier_products(name_key);

-- =============================================
-- PRECIOS: HISTORIAL Y ALERTAS
-- =============================================

CREATE TABLE IF NOT EXISTS price_history (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    price NUMERIC(12,2) NOT NULL,
    offer_price NUMERIC(12,2),
    available BOOLEAN DEFAULT true,
    scraped_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ph_product ON price_history(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_ph_scraped ON price_history(scraped_at DESC);

CREATE TABLE IF NOT EXISTS price_alerts (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL,
        -- 'price_increase', 'price_decrease', 'out_of_stock', 'back_in_stock'
    old_price NUMERIC(12,2),
    new_price NUMERIC(12,2),
    pct_change NUMERIC(6,2),
    linked_odoo_products JSONB DEFAULT '[]',
    company VARCHAR(20),
        -- 'neggo' = requiere aprobación manual
        -- 'preventas' = se aplicó automáticamente (status=auto_applied)
    status VARCHAR(20) DEFAULT 'pending',
        -- 'pending' (Neggo, esperando revisión)
        -- 'approved' (Neggo, aplicado por admin)
        -- 'dismissed' (Neggo, descartado)
        -- 'auto_applied' (Preventas, aplicado automáticamente)
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON price_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_product ON price_alerts(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_alerts_company ON price_alerts(company);

-- =============================================
-- VÍNCULOS: PRODUCTO PROVEEDOR <-> PRODUCTO ODOO
-- =============================================

CREATE TABLE IF NOT EXISTS product_mappings (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
    odoo_company VARCHAR(20) NOT NULL,
    odoo_internal_ref VARCHAR(100),
    match_type VARCHAR(20) NOT NULL,
    match_confidence NUMERIC(4,2),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_product_id, odoo_product_id, odoo_company)
);

CREATE INDEX IF NOT EXISTS idx_pm_supplier_product ON product_mappings(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_pm_odoo ON product_mappings(odoo_product_id, odoo_company);

-- =============================================
-- CACHE DE ODOO (sync periódico)
-- =============================================

CREATE TABLE IF NOT EXISTS odoo_products_cache (
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
    locally_archived BOOLEAN DEFAULT false NOT NULL,
    synced_at TIMESTAMP DEFAULT NOW(),
    external_id VARCHAR(200),
    ext_id_clean VARCHAR(200),
    description_purchase TEXT,
    vendor_name VARCHAR(200),
    template_id INTEGER,
    has_image BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(odoo_id, company)
);

CREATE INDEX IF NOT EXISTS idx_opc_ref ON odoo_products_cache(internal_ref);
CREATE INDEX IF NOT EXISTS idx_opc_company ON odoo_products_cache(company);
CREATE INDEX IF NOT EXISTS idx_opc_name ON odoo_products_cache(name);
CREATE INDEX IF NOT EXISTS idx_opc_external_id  ON odoo_products_cache(external_id)  WHERE external_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opc_ext_id_clean ON odoo_products_cache(ext_id_clean) WHERE ext_id_clean IS NOT NULL;

-- =============================================
-- PREVENTAS: PEDIDOS Y ÓRDENES
-- =============================================

CREATE TABLE IF NOT EXISTS preventa_client_orders (
    id SERIAL PRIMARY KEY,
    client_name           VARCHAR(200) NOT NULL,
    client_phone          VARCHAR(50),
    odoo_partner_id       INTEGER,
    odoo_sale_order_id    INTEGER,
    odoo_sale_order_name  VARCHAR(50),
    neggo_sale_order_id   INTEGER,
    neggo_sale_order_name VARCHAR(50),
    status                VARCHAR(30) DEFAULT 'pendiente',
    notes                 TEXT,
    total_estimated       NUMERIC(12,2),
    created_by            INTEGER REFERENCES users(id),
    created_at            TIMESTAMP DEFAULT NOW(),
    updated_at            TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pco_status ON preventa_client_orders(status);
CREATE INDEX IF NOT EXISTS idx_pco_created ON preventa_client_orders(created_at DESC);

CREATE TABLE IF NOT EXISTS preventa_client_order_items (
    id SERIAL PRIMARY KEY,
    client_order_id     INTEGER REFERENCES preventa_client_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES supplier_products(id),
    odoo_product_id     INTEGER,
    odoo_company        VARCHAR(20),
    source              VARCHAR(20) DEFAULT 'supplier',
    product_name        VARCHAR(500) NOT NULL,
    sku                 VARCHAR(100),
    quantity            INTEGER NOT NULL DEFAULT 1,
    unit_price          NUMERIC(12,2),
    unit_cost           NUMERIC(12,2),
    image_url           VARCHAR(1000),
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_pcoi_order ON preventa_client_order_items(client_order_id);

CREATE TABLE IF NOT EXISTS preventa_supplier_orders (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    status VARCHAR(30) DEFAULT 'borrador',
    odoo_purchase_order_id INTEGER,
    total_estimated NUMERIC(12,2),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pso_supplier ON preventa_supplier_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pso_status ON preventa_supplier_orders(status);

CREATE TABLE IF NOT EXISTS preventa_supplier_order_items (
    id SERIAL PRIMARY KEY,
    supplier_order_id INTEGER REFERENCES preventa_supplier_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES supplier_products(id),
    client_order_item_id INTEGER REFERENCES preventa_client_order_items(id),
    product_name VARCHAR(500) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_cost NUMERIC(12,2),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_psoi_order ON preventa_supplier_order_items(supplier_order_id);

-- =============================================
-- CATÁLOGOS GENERADOS
-- =============================================

CREATE TABLE IF NOT EXISTS catalogs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(30) NOT NULL,
    category VARCHAR(200),
    supplier_id INTEGER REFERENCES suppliers(id),
    file_path VARCHAR(500),
    product_count INTEGER,
    generated_by INTEGER REFERENCES users(id),
    downloaded_at TIMESTAMP,
    downloaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SCRAPING: LOG DE EJECUCIONES
-- =============================================

CREATE TABLE IF NOT EXISTS scraping_runs (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    status VARCHAR(20) NOT NULL,
    products_found INTEGER DEFAULT 0,
    products_new INTEGER DEFAULT 0,
    products_updated INTEGER DEFAULT 0,
    price_changes INTEGER DEFAULT 0,
    errors JSONB DEFAULT '[]',
    completed_categories JSONB DEFAULT '[]',
    checkpoint JSONB DEFAULT NULL,
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP,
    triggered_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sr_supplier ON scraping_runs(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sr_status ON scraping_runs(status);

-- =============================================
-- CONFIGURACIÓN GENERAL
-- =============================================

CREATE TABLE IF NOT EXISTS app_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SYNC LOG (Agente 03 — sync incremental Odoo)
-- =============================================

CREATE TABLE IF NOT EXISTS sync_log (
    id             SERIAL PRIMARY KEY,
    company        VARCHAR(20) NOT NULL UNIQUE,
    last_sync      TIMESTAMP,
    records_synced INTEGER DEFAULT 0,
    created_at     TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- INGRESO DE MERCADERÍA
-- =============================================

CREATE TABLE IF NOT EXISTS ingreso_mercaderia (
    id                       SERIAL PRIMARY KEY,
    comprobante_numero       VARCHAR(100),
    comprobante_tipo         VARCHAR(20) NOT NULL,
    supplier_id              INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    estado                   VARCHAR(20) DEFAULT 'pending',
    items_count              INTEGER DEFAULT 0,
    total_monto              NUMERIC(14,2) DEFAULT 0,
    odoo_purchase_order_id   INTEGER DEFAULT NULL,
    odoo_purchase_order_id_preventas INTEGER DEFAULT NULL,
    odoo_partner_id          INTEGER DEFAULT NULL,
    costo_envio              NUMERIC(14,2) DEFAULT 0,
    created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmed_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at             TIMESTAMP,
    created_at               TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingreso_items (
    id                      SERIAL PRIMARY KEY,
    ingreso_id              INTEGER NOT NULL REFERENCES ingreso_mercaderia(id) ON DELETE CASCADE,
    codigo                  VARCHAR(100),
    descripcion             VARCHAR(500),
    cantidad                INTEGER NOT NULL,
    precio_unitario         NUMERIC(14,2),
    subtotal                NUMERIC(14,2),
    odoo_product_id         INTEGER,
    odoo_product_name       VARCHAR(500),
    confidence_match        NUMERIC(5,3) DEFAULT 0,
    error_match             TEXT,
    estado_item             VARCHAR(20) DEFAULT 'pending',
    alerta_precio_diferente BOOLEAN DEFAULT FALSE,
    odoo_active             BOOLEAN DEFAULT NULL,
    cantidad_odoo_anterior  INTEGER,
    precio_odoo_anterior    NUMERIC(14,2),
    precio_odoo_nuevo       NUMERIC(14,2),
    precio_odoo_lista       NUMERIC(14,2),
    markup_override         NUMERIC(5,2) DEFAULT NULL,
    discount_override       NUMERIC(5,2) DEFAULT NULL,
        -- descuento negociado por ítem, sobreescribe el default del proveedor
    apply_cost              BOOLEAN DEFAULT false,
    apply_price             BOOLEAN DEFAULT false,
    motivo_rechazo          TEXT,
    checked                 BOOLEAN DEFAULT false,
        -- tildado durante el control físico de la mercadería
    checked_at              TIMESTAMP,
    checked_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
    preventa_qty_confirmed  INTEGER NOT NULL DEFAULT 0,
    match_level             VARCHAR(30),
    created_at              TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingreso_items_ingreso_id ON ingreso_items(ingreso_id);
CREATE INDEX IF NOT EXISTS idx_ingreso_mercaderia_supplier ON ingreso_mercaderia(supplier_id);

-- =============================================
-- VINCULACIONES PERSISTENTES DE CÓDIGOS DE FACTURA
-- Cuando el operador vincula manualmente un código de factura a un producto Odoo,
-- se guarda acá para que futuras facturas del mismo proveedor auto-matcheen.
-- =============================================

CREATE TABLE IF NOT EXISTS invoice_code_mappings (
    id                SERIAL PRIMARY KEY,
    supplier_id       INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    raw_code          VARCHAR(100) NOT NULL,
        -- código tal como aparece en la factura/CSV
    odoo_product_id   INTEGER NOT NULL,
    odoo_product_name VARCHAR(500),
    odoo_company      VARCHAR(20) NOT NULL DEFAULT 'neggo',
    created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, raw_code)
);

CREATE INDEX IF NOT EXISTS idx_icm_supplier_code ON invoice_code_mappings(supplier_id, raw_code);

-- =============================================
-- FASE 2: VENTAS + CLIENTES
-- =============================================

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
CREATE INDEX IF NOT EXISTS idx_cn_partner ON client_notes(odoo_partner_id);

-- =============================================
-- FASE 3: PEDIDOS NEGGO + PICKING + KANBAN
-- =============================================

CREATE TABLE IF NOT EXISTS neggo_orders (
    id SERIAL PRIMARY KEY,
    odoo_sale_order_id INTEGER NOT NULL,
    odoo_order_name VARCHAR(50),
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
    category VARCHAR(200),
    pick_confirmed BOOLEAN DEFAULT false,
    check_confirmed BOOLEAN DEFAULT false,
    check_notes TEXT
);

CREATE TABLE IF NOT EXISTS neggo_picking_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    order_ids JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    zone_sequence JSONB,
    current_zone VARCHAR(200),
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_no_status ON neggo_orders(status);
CREATE INDEX IF NOT EXISTS idx_no_odoo ON neggo_orders(odoo_sale_order_id);
CREATE INDEX IF NOT EXISTS idx_noi_order ON neggo_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_nps_user ON neggo_picking_sessions(user_id);

-- =============================================
-- FASE 4: MARKETING
-- =============================================

CREATE TABLE IF NOT EXISTS marketing_calendar (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    scheduled_date DATE NOT NULL,
    channel VARCHAR(30) NOT NULL,
        -- 'instagram', 'whatsapp', 'facebook'
    status VARCHAR(20) DEFAULT 'planificado',
        -- planificado, en_diseno, listo, publicado
    content_type VARCHAR(20),
    category VARCHAR(200),
    product_ids JSONB DEFAULT '[]',
    ai_suggestion TEXT,
    generated_file_path VARCHAR(500),
    created_by INTEGER REFERENCES users(id),
    published_by INTEGER REFERENCES users(id),
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,
    config JSONB NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_generated (
    id SERIAL PRIMARY KEY,
    calendar_id INTEGER REFERENCES marketing_calendar(id),
    type VARCHAR(20) NOT NULL,
    template_id INTEGER REFERENCES marketing_templates(id),
    file_path VARCHAR(500) NOT NULL,
    product_count INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mc_date ON marketing_calendar(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_mc_status ON marketing_calendar(status);
CREATE INDEX IF NOT EXISTS idx_mc_channel ON marketing_calendar(channel);

-- =============================================
-- FASE 4: COMPRAS INTELIGENTES
-- =============================================

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
    days_of_stock INTEGER,
    status VARCHAR(20) DEFAULT 'active',
        -- active, resolved, dismissed
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
    priority VARCHAR(10) DEFAULT 'medium',
        -- low, medium, high, urgent
    status VARCHAR(20) DEFAULT 'pending',
        -- pending, acted, dismissed
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_seasonality (
    id SERIAL PRIMARY KEY,
    category VARCHAR(200) NOT NULL,
    month INTEGER NOT NULL,
    avg_sales NUMERIC(12,2),
    trend VARCHAR(20),
        -- 'peak', 'high', 'normal', 'low'
    calculated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(category, month)
);

CREATE INDEX IF NOT EXISTS idx_cp_competitor ON competitor_products(competitor_id);
CREATE INDEX IF NOT EXISTS idx_sa_status ON stock_alerts(status);
CREATE INDEX IF NOT EXISTS idx_ps_type ON purchase_suggestions(suggestion_type);
CREATE INDEX IF NOT EXISTS idx_ps_priority ON purchase_suggestions(priority);
CREATE INDEX IF NOT EXISTS idx_ps_status ON purchase_suggestions(status);

-- =============================================
-- LISTAS DE PRECIOS ESPECIALES PARA CLIENTES
-- =============================================

CREATE TABLE IF NOT EXISTS client_pricelists (
    id                SERIAL PRIMARY KEY,
    name              VARCHAR(200) NOT NULL,
    description       TEXT,
    default_descuento NUMERIC(6,2) NOT NULL DEFAULT 0,
    active            BOOLEAN DEFAULT true,
    created_by        INTEGER REFERENCES users(id),
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_pricelist_rules (
    id            SERIAL PRIMARY KEY,
    pricelist_id  INTEGER REFERENCES client_pricelists(id) ON DELETE CASCADE,
    supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    descuento_pct NUMERIC(6,2) NOT NULL,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE(pricelist_id, supplier_id)
);

-- La lista se crea después que el pedido: la columna va acá, no en el CREATE,
-- para que el índice de abajo no falle en una base vacía.
ALTER TABLE preventa_client_orders
    ADD COLUMN IF NOT EXISTS pricelist_id INTEGER REFERENCES client_pricelists(id);

CREATE INDEX IF NOT EXISTS idx_pl_active ON client_pricelists(active);
CREATE INDEX IF NOT EXISTS idx_plr_pricelist ON client_pricelist_rules(pricelist_id);
CREATE INDEX IF NOT EXISTS idx_plr_supplier ON client_pricelist_rules(supplier_id);

ALTER TABLE preventa_client_orders
    ADD COLUMN IF NOT EXISTS pricelist_id INTEGER REFERENCES client_pricelists(id);

CREATE INDEX IF NOT EXISTS idx_pco_pricelist ON preventa_client_orders(pricelist_id);
