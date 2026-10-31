-- Cruce de productos revisado por Claude (plan de reposición automática, punto 5). Solo aditiva.
-- Cada fila es lo que Claude decidió sobre un producto de Neggo en una tanda:
--   elegido → la oferta que le parece la misma (queda como sugerido en product_mappings, metodo 'claude')
--   ninguno → ninguno de los candidatos es el mismo producto
--   duda    → no alcanza la información (otro color, otra medida, sin precio)
-- La confirmación siempre la hace una persona en Vincular: esto no confirma nada ni toca Odoo.
-- Sirve también para no volver a revisar el mismo producto en cada tanda.

-- La tanda que se le muestra a Claude: productos y candidatos con su letra. Se guarda para que al
-- registrar las respuestas cada letra apunte a la misma oferta que vio.
CREATE TABLE IF NOT EXISTS cruce_lotes (
    id VARCHAR(40) PRIMARY KEY,
    productos JSONB NOT NULL,
    registrado_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cruce_revisiones (
    id SERIAL PRIMARY KEY,
    lote VARCHAR(40) NOT NULL REFERENCES cruce_lotes(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
    odoo_company VARCHAR(20) NOT NULL DEFAULT 'neggo',
    resultado VARCHAR(10) NOT NULL CHECK (resultado IN ('elegido', 'ninguno', 'duda')),
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    confianza VARCHAR(6) CHECK (confianza IS NULL OR confianza IN ('alta', 'media')),
    motivo TEXT,
    candidatos INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK ((resultado = 'elegido') = (supplier_product_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_cr_odoo ON cruce_revisiones(odoo_product_id, odoo_company, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cr_oferta ON cruce_revisiones(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_cr_lote ON cruce_revisiones(lote);
