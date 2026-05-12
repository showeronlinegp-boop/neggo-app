-- Migración 012: IDs de categoría Odoo en reglas de categoría de proveedor
-- Permite mapear una source_category del scraper a una categ_id real de Odoo
-- por empresa (neggo y preventas) además del nombre de texto ya existente.

ALTER TABLE supplier_category_rules
    ADD COLUMN IF NOT EXISTS odoo_categ_id_neggo INTEGER,
    ADD COLUMN IF NOT EXISTS odoo_categ_id_preventas INTEGER;
