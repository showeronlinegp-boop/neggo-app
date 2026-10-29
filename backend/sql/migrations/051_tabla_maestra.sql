-- Tabla maestra / vincular productos (nota 107), PRIMER PASO.
-- Solo aditiva: no borra ni cambia datos existentes.

-- Ofertas: código del proveedor sin el prefijo de la app y unidades por pack
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS codigo_proveedor VARCHAR(100);
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS pack_cantidad INTEGER NOT NULL DEFAULT 1
    CHECK (pack_cantidad >= 1);
-- De dónde salió el pack: nombre ("x12"), costo (costo Odoo ÷ neto ≈ 1/n), ambos, dudoso o manual
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS pack_origen VARCHAR(10)
    CHECK (pack_origen IN ('nombre', 'costo', 'ambos', 'dudoso', 'manual'));
CREATE INDEX IF NOT EXISTS idx_sp_codigo_proveedor ON supplier_products(supplier_id, codigo_proveedor);

-- Vínculos idénticos (oferta ↔ producto Odoo). Un producto puede tener muchas ofertas:
-- la UNIQUE sigue siendo (oferta, producto, empresa).
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS estado VARCHAR(12) NOT NULL DEFAULT 'sugerido'
    CHECK (estado IN ('sugerido', 'confirmado', 'rechazado'));
-- codigo / nombre / semilla_neggo / semilla_preventas / factura / ingreso / manual / auto_ref / auto_fuzzy
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS metodo VARCHAR(20);
-- La oferta a la que se le compra: solo esta va a mover precios en Odoo
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS es_habitual BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS confirmado_por INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS confirmado_at TIMESTAMP;
-- Como máximo un habitual por producto y empresa (los demás vínculos siguen sin límite)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_habitual ON product_mappings(odoo_product_id, odoo_company)
    WHERE es_habitual;
CREATE INDEX IF NOT EXISTS idx_pm_estado ON product_mappings(estado, odoo_company);

-- Cada decisión sobre un vínculo: no volver a proponer un "no es este" y medir el acierto por método
CREATE TABLE IF NOT EXISTS match_decisiones (
    id SERIAL PRIMARY KEY,
    supplier_product_id INTEGER NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
    odoo_product_id INTEGER NOT NULL,
    odoo_company VARCHAR(20) NOT NULL,
    decision VARCHAR(12) NOT NULL CHECK (decision IN ('confirmado', 'rechazado')),
    metodo VARCHAR(20),
    puntaje NUMERIC(5,3),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_md_oferta ON match_decisiones(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_md_odoo ON match_decisiones(odoo_product_id, odoo_company);
CREATE INDEX IF NOT EXISTS idx_md_metodo ON match_decisiones(metodo, decision);

-- Reemplazos: OTRO producto que sirve en lugar del que hay que reponer (nunca en product_mappings).
-- El reemplazo es un producto de Odoo o una oferta de proveedor, uno de los dos.
CREATE TABLE IF NOT EXISTS producto_reemplazos (
    id SERIAL PRIMARY KEY,
    odoo_product_id INTEGER NOT NULL,
    odoo_company VARCHAR(20) NOT NULL,
    reemplazo_odoo_product_id INTEGER,
    reemplazo_supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
    motivos VARCHAR(10)[] NOT NULL DEFAULT '{}',   -- precio / marca / modelo
    estado VARCHAR(12) NOT NULL DEFAULT 'sugerido'
        CHECK (estado IN ('sugerido', 'confirmado', 'rechazado')),
    puntaje NUMERIC(5,3),
    senales JSONB NOT NULL DEFAULT '{}',
    confirmado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmado_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK ((reemplazo_odoo_product_id IS NULL) <> (reemplazo_supplier_product_id IS NULL)),
    CHECK (motivos <@ ARRAY['precio', 'marca', 'modelo']::VARCHAR(10)[])
);
CREATE INDEX IF NOT EXISTS idx_pr_odoo ON producto_reemplazos(odoo_product_id, odoo_company);
CREATE INDEX IF NOT EXISTS idx_pr_reemplazo_odoo ON producto_reemplazos(reemplazo_odoo_product_id, odoo_company);
CREATE INDEX IF NOT EXISTS idx_pr_reemplazo_oferta ON producto_reemplazos(reemplazo_supplier_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_odoo ON producto_reemplazos(odoo_product_id, odoo_company, reemplazo_odoo_product_id)
    WHERE reemplazo_odoo_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_oferta ON producto_reemplazos(odoo_product_id, odoo_company, reemplazo_supplier_product_id)
    WHERE reemplazo_supplier_product_id IS NOT NULL;

-- Precio comparable por unidad, sin IVA y sin el 1,5 % de flete:
--   web     → precio × (1 − descuento) ÷ pack (descuento = override de la categoría o el del proveedor)
--   "neggo" → costo de Odoo ÷ pack (ya trae el descuento: no se vuelve a descontar)
-- ZLE no tiene precio sin sesión: queda con precio_comparable NULL.
CREATE OR REPLACE VIEW v_ofertas_comparables AS
SELECT sp.id AS supplier_product_id,
       sp.supplier_id,
       s.name AS proveedor,
       sp.source,
       sp.sku,
       sp.codigo_proveedor,
       sp.name,
       sp.source_category,
       sp.available,
       sp.pack_cantidad,
       sp.pack_origen,
       sp.raw_price AS precio_lista,
       CASE WHEN sp.source = 'neggo' THEN 0
            ELSE COALESCE(r.discount_override, s.default_discount, 0) END AS descuento_pct,
       ROUND(
           CASE WHEN sp.source = 'neggo' THEN NULLIF(sp.raw_price, 0)
                ELSE NULLIF(sp.raw_price, 0)
                     * (1 - COALESCE(r.discount_override, s.default_discount, 0) / 100.0)
           END / sp.pack_cantidad, 2) AS precio_comparable,
       sp.last_scraped_at
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules r
       ON r.supplier_id = sp.supplier_id AND r.source_category = sp.source_category AND r.active;
