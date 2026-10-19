-- Fuentes de scraping por proveedor (web vs Neggo interno) y control de habilitación
-- - suppliers.scrape_enabled: permite pausar el scraping de un proveedor sin desactivarlo
-- - supplier_products.source: 'web' (scraper externo) o 'neggo' (productos internos de Neggo)
-- - supplier_products.neggo_odoo_id: product.template de Neggo de donde salió el producto

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS scrape_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_suppliers_scrape_enabled ON suppliers(scrape_enabled);

ALTER TABLE supplier_products
    ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'web';

ALTER TABLE supplier_products DROP CONSTRAINT IF EXISTS supplier_products_source_check;
ALTER TABLE supplier_products
    ADD CONSTRAINT supplier_products_source_check CHECK (source IN ('web', 'neggo'));

ALTER TABLE supplier_products
    ADD COLUMN IF NOT EXISTS neggo_odoo_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_sp_neggo_odoo ON supplier_products(neggo_odoo_id);
CREATE INDEX IF NOT EXISTS idx_sp_source ON supplier_products(source);

-- Antigüedad máxima (días) del último scrapeo completo para proponer inactivaciones
INSERT INTO app_config (key, value)
VALUES ('preventas_inactivar_max_dias', '7')
ON CONFLICT (key) DO NOTHING;
