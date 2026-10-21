-- CRM de clientes, fase 1: métricas por cliente calculadas desde los tickets del POS de Neggo.
-- Reusa client_metrics_cache (vacía hasta ahora) y le suma lo que necesita la ficha.
-- Ver docs/plan-crm-clientes.md.
ALTER TABLE client_metrics_cache
    ADD COLUMN IF NOT EXISTS partner_name VARCHAR(300),
    ADD COLUMN IF NOT EXISTS phone VARCHAR(80),
    ADD COLUMN IF NOT EXISTS city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS is_generic BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS first_purchase_date DATE,
    ADD COLUMN IF NOT EXISTS median_interval_days NUMERIC(8,2),
    ADD COLUMN IF NOT EXISTS interval_is_default BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS revenue_90d NUMERIC(14,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS revenue_prev_90d NUMERIC(14,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS revenue_12m NUMERIC(14,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS health VARCHAR(20),
    ADD COLUMN IF NOT EXISTS trend VARCHAR(10),
    ADD COLUMN IF NOT EXISTS trend_pct NUMERIC(8,1),
    ADD COLUMN IF NOT EXISTS priority NUMERIC(16,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_revenue JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS top_products JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS open_quotations JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_cm_health ON client_metrics_cache(company, health);
CREATE INDEX IF NOT EXISTS idx_cm_priority ON client_metrics_cache(company, priority DESC);
CREATE INDEX IF NOT EXISTS idx_cm_partner_name ON client_metrics_cache(partner_name);
