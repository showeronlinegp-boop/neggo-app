-- Estado del envío 1 y backorder de stock (faltantes al validar el picking).
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_state VARCHAR(20);
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_backorder_id INTEGER;
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_picking_backorder_name VARCHAR(50);
