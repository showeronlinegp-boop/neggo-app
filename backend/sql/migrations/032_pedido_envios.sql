-- Armado y control de pedidos (réplica 2-step adentro de Neggo App).
-- El picking/control vive acá. Recién al saldar se escribe la sale.order de Odoo
-- y, si sobra cantidad, se crea un pedido nuevo con los pendientes.

CREATE TABLE IF NOT EXISTS pedido_envios (
    id SERIAL PRIMARY KEY,
    company_key VARCHAR(20) NOT NULL DEFAULT 'neggo',
    odoo_sale_order_id INTEGER NOT NULL,
    odoo_order_name VARCHAR(50),
    partner_id INTEGER,
    partner_name VARCHAR(200),
    date_order TIMESTAMP,
    amount_total NUMERIC(12,2),
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        -- pendiente | armando | armado | controlando | saldado
    assembled_by INTEGER REFERENCES users(id),
    assembled_at TIMESTAMP,
    checked_by INTEGER REFERENCES users(id),
    checked_at TIMESTAMP,
    saldado_at TIMESTAMP,
    saldado_by INTEGER REFERENCES users(id),
    backorder_odoo_id INTEGER,
    backorder_odoo_name VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (company_key, odoo_sale_order_id)
);

CREATE TABLE IF NOT EXISTS pedido_envio_items (
    id SERIAL PRIMARY KEY,
    envio_id INTEGER NOT NULL REFERENCES pedido_envios(id) ON DELETE CASCADE,
    odoo_line_id INTEGER NOT NULL,
    odoo_product_id INTEGER,
    product_name VARCHAR(500),
    barcode VARCHAR(50),
    internal_ref VARCHAR(100),
    image_url VARCHAR(1000),
    price_unit NUMERIC(12,2) DEFAULT 0,
    qty_pedida NUMERIC(12,2) NOT NULL,
    qty_armada NUMERIC(12,2) NOT NULL DEFAULT 0,
    qty_controlada NUMERIC(12,2) NOT NULL DEFAULT 0,
    faltante_motivo VARCHAR(20),
        -- archivado | reponer | faltante | null
    UNIQUE (envio_id, odoo_line_id)
);

CREATE INDEX IF NOT EXISTS idx_pe_estado ON pedido_envios(estado);
CREATE INDEX IF NOT EXISTS idx_pe_company ON pedido_envios(company_key);
CREATE INDEX IF NOT EXISTS idx_pe_odoo ON pedido_envios(odoo_sale_order_id);
CREATE INDEX IF NOT EXISTS idx_pei_envio ON pedido_envio_items(envio_id);
CREATE INDEX IF NOT EXISTS idx_pei_barcode ON pedido_envio_items(barcode)
    WHERE barcode IS NOT NULL;
