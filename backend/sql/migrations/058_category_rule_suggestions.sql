-- Categorías de Odoo propuestas por Claude para las categorías pendientes de los proveedores (nota 131).
-- Solo aditiva. Una fila por categoría del proveedor que entró en una tanda de scripts/categoriasClaude.js:
--   revisada_at NULL            → está en una tanda, Claude todavía no contestó
--   revisada_at + categ ids     → propuesta (se ve precargada en "Categorías pendientes")
--   revisada_at sin categ ids   → Claude no encontró categoría que encaje
-- La regla la crea siempre una persona con "Asignar": esto no crea reglas ni toca Odoo.

CREATE TABLE IF NOT EXISTS category_rule_suggestions (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    source_category VARCHAR(200) NOT NULL,
    odoo_categ_id_neggo INTEGER,
    odoo_categ_id_preventas INTEGER,
    dest_category_neggo VARCHAR(200),
    dest_category_preventas VARCHAR(200),
    confianza VARCHAR(10) CHECK (confianza IN ('alta', 'media', 'baja')),
    motivo TEXT,
    revisada_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (supplier_id, source_category)
);

CREATE INDEX IF NOT EXISTS idx_crs_supplier ON category_rule_suggestions (supplier_id);
CREATE INDEX IF NOT EXISTS idx_crs_pendientes ON category_rule_suggestions (id) WHERE revisada_at IS NULL;
