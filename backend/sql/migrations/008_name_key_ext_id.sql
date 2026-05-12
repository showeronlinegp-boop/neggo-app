-- Migración 008: columnas de matching secundario para sync Preventas
-- name_key en supplier_products: nombre normalizado (mayúsculas, solo alfanumérico)
-- external_id y ext_id_clean en odoo_products_cache: ref externa de ir.model.data

-- ─── supplier_products ────────────────────────────────────────────────────────
ALTER TABLE supplier_products
    ADD COLUMN IF NOT EXISTS name_key VARCHAR(500);

-- Poblar desde nombres existentes
UPDATE supplier_products
SET name_key = UPPER(REGEXP_REPLACE(name, '[^A-Za-z0-9]', '', 'g'))
WHERE name_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_sp_name_key ON supplier_products(name_key);

-- ─── odoo_products_cache ──────────────────────────────────────────────────────
ALTER TABLE odoo_products_cache
    ADD COLUMN IF NOT EXISTS external_id VARCHAR(200),
    ADD COLUMN IF NOT EXISTS ext_id_clean VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_opc_external_id  ON odoo_products_cache(external_id)  WHERE external_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opc_ext_id_clean ON odoo_products_cache(ext_id_clean) WHERE ext_id_clean IS NOT NULL;
