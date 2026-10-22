-- CRM de clientes: lista de seguimiento cercano (nota #74).
-- Clientes de Odoo que el usuario marca a mano para tenerlos a mano. Es una sola lista
-- compartida; la fila existe mientras el cliente está en la lista.
CREATE TABLE IF NOT EXISTS crm_watchlist (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER NOT NULL UNIQUE,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_watchlist_added_by ON crm_watchlist(added_by);
