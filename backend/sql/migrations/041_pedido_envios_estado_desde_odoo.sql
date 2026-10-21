-- El estado de armado/control sale de los envíos de Odoo (lo recalcula el sync).
-- Acá sólo el estado en Odoo del pedido de pendientes, para la solapa Pendientes:
-- draft/sent = sigue esperando; sale/done/cancel = ya se resolvió.
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS pendientes_odoo_state TEXT;

CREATE INDEX IF NOT EXISTS idx_pedido_envios_backorder_odoo
    ON pedido_envios (company_key, backorder_odoo_id)
    WHERE backorder_odoo_id IS NOT NULL;
