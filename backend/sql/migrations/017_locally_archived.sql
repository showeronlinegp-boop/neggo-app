-- Agrega campo locally_archived a odoo_products_cache
-- Permite archivar productos de Neggo en el sistema local sin tocar Odoo.
-- El sync no sobrescribe este campo.

ALTER TABLE odoo_products_cache
    ADD COLUMN IF NOT EXISTS locally_archived BOOLEAN DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS idx_opc_locally_archived
    ON odoo_products_cache(locally_archived)
    WHERE locally_archived = true;
