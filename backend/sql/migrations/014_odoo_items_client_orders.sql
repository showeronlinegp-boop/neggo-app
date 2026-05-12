-- Migración 014: soporte de productos Odoo en ítems de pedidos de clientes
-- Permite agregar artículos del cache de Odoo (neggo/preventas) además de supplier_products

ALTER TABLE preventa_client_order_items
    ADD COLUMN IF NOT EXISTS odoo_product_id INTEGER,
    ADD COLUMN IF NOT EXISTS odoo_company     VARCHAR(20),
    ADD COLUMN IF NOT EXISTS sku              VARCHAR(100),
    ADD COLUMN IF NOT EXISTS source           VARCHAR(20) DEFAULT 'supplier';

-- Rellenar 'source' para ítems ya existentes con supplier_product_id
UPDATE preventa_client_order_items
SET source = 'supplier'
WHERE source IS NULL AND supplier_product_id IS NOT NULL;

-- Índice para búsquedas por producto Odoo
CREATE INDEX IF NOT EXISTS idx_pcoi_odoo ON preventa_client_order_items(odoo_product_id, odoo_company)
WHERE odoo_product_id IS NOT NULL;
