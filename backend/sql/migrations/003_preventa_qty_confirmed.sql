-- Cantidad de unidades del ítem confirmadas como entregadas a pedidos de preventa
ALTER TABLE ingreso_items
    ADD COLUMN IF NOT EXISTS preventa_qty_confirmed INT NOT NULL DEFAULT 0;
