-- Migración 031: estado 'encargado' (se pidió, todavía no llegó)
--
-- Encargado NO es un resuelto: el producto sigue abierto hasta que llega
-- (ingreso activo para Neggo, o alguien lo marca repuesto) o se descarta.
-- Si no llega, vuelve a pendiente. Idempotente: la corre ensureSchema.
-- La 030 es reposición completa (recorrida / ventas). No reutilizar ese número.

ALTER TABLE reposicion_items DROP CONSTRAINT IF EXISTS reposicion_items_estado_check;
ALTER TABLE reposicion_items ADD CONSTRAINT reposicion_items_estado_check
    CHECK (estado IN ('pendiente', 'encargado', 'repuesto', 'descartado'));

ALTER TABLE reposicion_items ADD COLUMN IF NOT EXISTS encargado_at TIMESTAMP;
ALTER TABLE reposicion_items ADD COLUMN IF NOT EXISTS encargado_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS uq_reposicion_pendiente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reposicion_abierto
    ON reposicion_items (odoo_id, company)
    WHERE estado IN ('pendiente', 'encargado');

CREATE INDEX IF NOT EXISTS idx_reposicion_encargado_by ON reposicion_items (encargado_by);
CREATE INDEX IF NOT EXISTS idx_ingreso_items_odoo ON ingreso_items (odoo_product_id)
    WHERE odoo_product_id IS NOT NULL;
