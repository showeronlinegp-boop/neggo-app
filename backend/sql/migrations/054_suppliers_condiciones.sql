-- Condiciones de compra por proveedor y cruce con el proveedor de Odoo
-- (plan de reposición automática, punto 4). Solo aditiva: no toca precios ni vínculos.
--   odoo_vendor_name → nombre exacto del proveedor en Odoo (opc.vendor_name). Varios proveedores
--                      de la app pueden apuntar al mismo (ej. "Parnassa" y "Parnassa Web").
--                      Vacío = se usa el nombre del proveedor.
--   pedido_minimo    → mínimo de compra en pesos, sin IVA
--   flete_pct        → flete en %; vacío = el 1,5 % que se usa hoy para todos
--   demora_dias      → días desde que se pide hasta que llega (lo que dice el proveedor)
--   acepta_auto      → si se le puede mandar un pedido sin aprobación (para más adelante)
--   condiciones_nota → forma de pago, por dónde se pide, horarios, lo que haga falta
-- La semilla de odoo_vendor_name se carga solo al crear la columna: volver a correrla no pisa
-- lo que se haya cargado en la pantalla.

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pedido_minimo NUMERIC(12,2);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS flete_pct NUMERIC(5,2);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS demora_dias INTEGER;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS acepta_auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS condiciones_nota TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'suppliers' AND column_name = 'odoo_vendor_name'
    ) THEN
        ALTER TABLE suppliers ADD COLUMN odoo_vendor_name VARCHAR(200);

        -- Los "X Web" son la web del mismo proveedor de Odoo; el resto se llama igual que en Odoo
        UPDATE suppliers SET odoo_vendor_name = regexp_replace(name, ' Web$', '')
        WHERE name LIKE '% Web';
        UPDATE suppliers SET odoo_vendor_name = name
        WHERE odoo_vendor_name IS NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_condiciones_check') THEN
        ALTER TABLE suppliers ADD CONSTRAINT suppliers_condiciones_check CHECK (
            (pedido_minimo IS NULL OR pedido_minimo >= 0)
            AND (flete_pct IS NULL OR (flete_pct >= 0 AND flete_pct <= 100))
            AND (demora_dias IS NULL OR demora_dias >= 0)
        );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_suppliers_odoo_vendor ON suppliers(odoo_vendor_name);

-- La vista de ofertas suma el proveedor de Odoo al final (CREATE OR REPLACE solo permite agregar
-- columnas al final). El resto queda igual que en la 051.
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
       sp.last_scraped_at,
       COALESCE(NULLIF(s.odoo_vendor_name, ''), s.name) AS proveedor_odoo
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules r
       ON r.supplier_id = sp.supplier_id AND r.source_category = sp.source_category AND r.active;
