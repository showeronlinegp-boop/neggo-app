-- Al empezar a armar se confirma la sale.order y se ata el envío 1 (stock.picking).
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_id INTEGER;
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_name VARCHAR(50);
