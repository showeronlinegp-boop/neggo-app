-- Migración 015: referencia de sale.order de Odoo en pedidos de clientes

ALTER TABLE preventa_client_orders
    ADD COLUMN IF NOT EXISTS odoo_sale_order_id   INTEGER,
    ADD COLUMN IF NOT EXISTS odoo_sale_order_name VARCHAR(50);
