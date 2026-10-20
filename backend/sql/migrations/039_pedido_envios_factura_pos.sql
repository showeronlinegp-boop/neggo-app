-- Cuántas facturas y tickets de POS tiene la orden en Odoo.
-- Con alguno de los dos el pedido ya se cobró por otro lado y no va a «Armar».
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_invoice_count INTEGER;
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_pos_count INTEGER;
