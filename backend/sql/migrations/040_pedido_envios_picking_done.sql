-- Cuántos envíos (pickings outgoing/internal) ya están validados en Odoo.
-- Con 2 o más, el pedido se resolvió allá: no va a «Para armar».
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_done_count INTEGER;
