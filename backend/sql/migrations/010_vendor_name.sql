-- Migración 010: vendor_name en odoo_products_cache
-- Almacena el primer proveedor (seller) de cada producto traído desde Odoo.
-- Se usa en bracket_code matching para comparar proveedor vs proveedor.

ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(200);
CREATE INDEX IF NOT EXISTS idx_opc_vendor ON odoo_products_cache(vendor_name) WHERE vendor_name IS NOT NULL;
