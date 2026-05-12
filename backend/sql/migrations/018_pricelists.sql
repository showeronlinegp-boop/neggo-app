-- Migración 018: Listas de precios especiales para clientes

CREATE TABLE IF NOT EXISTS client_pricelists (
    id                SERIAL PRIMARY KEY,
    name              VARCHAR(200) NOT NULL,
    description       TEXT,
    default_descuento NUMERIC(6,2) NOT NULL DEFAULT 0,
    active            BOOLEAN DEFAULT true,
    created_by        INTEGER REFERENCES users(id),
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_pricelist_rules (
    id            SERIAL PRIMARY KEY,
    pricelist_id  INTEGER REFERENCES client_pricelists(id) ON DELETE CASCADE,
    supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    descuento_pct NUMERIC(6,2) NOT NULL,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE(pricelist_id, supplier_id)
);

ALTER TABLE preventa_client_orders
    ADD COLUMN IF NOT EXISTS pricelist_id INTEGER REFERENCES client_pricelists(id);

CREATE INDEX IF NOT EXISTS idx_pl_active ON client_pricelists(active);
CREATE INDEX IF NOT EXISTS idx_plr_pricelist ON client_pricelist_rules(pricelist_id);
CREATE INDEX IF NOT EXISTS idx_plr_supplier ON client_pricelist_rules(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pco_pricelist ON preventa_client_orders(pricelist_id);
