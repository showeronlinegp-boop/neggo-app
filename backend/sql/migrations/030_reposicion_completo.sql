-- Migración 030: reposición completa (fases 2–4 de la propuesta)
--
-- Extiende la cola de la 029:
--   - origen 'recorrida' (escáner en depósito) y 'bajo_stock' (umbral en el sync)
--   - qty_sugerida (cálculo opcional) y odoo_po_id (OC generada en Odoo)
--   - product_sales_weekly: ventas agregadas por producto/semana (ritmo + ABC)
-- Idempotente: también la corre ensureSchema al arrancar.

-- Orígenes nuevos (conserva 'reponer' = marcado manual / «queda poco»)
ALTER TABLE reposicion_items DROP CONSTRAINT IF EXISTS reposicion_items_origen_check;
ALTER TABLE reposicion_items
    ADD CONSTRAINT reposicion_items_origen_check
    CHECK (origen IN ('archivado', 'reponer', 'recorrida', 'bajo_stock'));

ALTER TABLE reposicion_items
    ADD COLUMN IF NOT EXISTS qty_sugerida INTEGER
    CHECK (qty_sugerida IS NULL OR qty_sugerida >= 0);

ALTER TABLE reposicion_items
    ADD COLUMN IF NOT EXISTS odoo_po_id INTEGER;

-- Ventas semanales por producto (Neggo). week_start = lunes ISO de esa semana.
CREATE TABLE IF NOT EXISTS product_sales_weekly (
    odoo_id      INTEGER NOT NULL,
    company      VARCHAR(20) NOT NULL DEFAULT 'neggo' CHECK (company = 'neggo'),
    week_start   DATE NOT NULL,
    qty_vendida  NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    synced_at    TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (odoo_id, company, week_start)
);

CREATE INDEX IF NOT EXISTS idx_psw_week
    ON product_sales_weekly (company, week_start);
CREATE INDEX IF NOT EXISTS idx_psw_odoo
    ON product_sales_weekly (odoo_id, company);
