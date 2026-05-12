-- Migración 009: tabla de estado pre-computado para sync Preventas
-- La query pesada corre en background; la página lee de esta tabla (instant).

CREATE TABLE IF NOT EXISTS preventas_sync_state (
    id                  SERIAL PRIMARY KEY,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    odoo_product_id     INTEGER,
    supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    match_type          VARCHAR(30),   -- exact_sku | barcode | internal_ref | name_key | fuzzy_name | null
    match_score         NUMERIC(5,2),  -- 0-100
    estado              VARCHAR(30) NOT NULL,
    costo               NUMERIC(12,2),
    precio_preventas    NUMERIC(12,2),
    computed_at         TIMESTAMP DEFAULT NOW()
);

-- Cada producto scraper aparece como máximo una vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_pss_sp_uniq
    ON preventas_sync_state(supplier_product_id)
    WHERE supplier_product_id IS NOT NULL;

-- Cada producto Odoo aparece como máximo una vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_pss_odoo_uniq
    ON preventas_sync_state(odoo_product_id)
    WHERE odoo_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pss_estado   ON preventas_sync_state(estado);
CREATE INDEX IF NOT EXISTS idx_pss_supplier ON preventas_sync_state(supplier_id) WHERE supplier_id IS NOT NULL;
