ALTER TABLE ingreso_mercaderia
    ADD COLUMN IF NOT EXISTS odoo_purchase_order_id_preventas INT;
