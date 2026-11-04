-- Nota 150: productos de cotizaciones «Pendiente» de Neggo que ya están separados para el
-- cliente. Lo separado no se vuelve a pedir: sale de lo que falta reponer.
-- Una fila por cotización (sale.order de Odoo) + producto; destildar borra la fila.
CREATE TABLE IF NOT EXISTS cotizacion_separados (
    id SERIAL PRIMARY KEY,
    company VARCHAR(20) NOT NULL DEFAULT 'neggo',
    odoo_order_id INTEGER NOT NULL,
    order_name VARCHAR(64),
    odoo_id INTEGER NOT NULL,
    qty NUMERIC(12, 2),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (company, odoo_order_id, odoo_id)
);

CREATE INDEX IF NOT EXISTS idx_cotizacion_separados_order ON cotizacion_separados (odoo_order_id);
CREATE INDEX IF NOT EXISTS idx_cotizacion_separados_user ON cotizacion_separados (user_id);
