-- Agrega template_id y has_image a odoo_products_cache
-- template_id: ID del product.template en Odoo (para escribir imágenes en el modelo correcto)
-- has_image: si el producto en Odoo ya tiene imagen (evitar re-subir innecesariamente)

ALTER TABLE odoo_products_cache
    ADD COLUMN IF NOT EXISTS template_id  INTEGER,
    ADD COLUMN IF NOT EXISTS has_image    BOOLEAN NOT NULL DEFAULT FALSE;
