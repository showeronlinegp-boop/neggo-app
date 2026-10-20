-- Armado: solo cotizaciones enviadas (Odoo state=sent), no facturadas.
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS odoo_state VARCHAR(20);
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(30);
