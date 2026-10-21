-- CRM de clientes: rubro del cliente = categoría de producto en la que más compró en 12 meses (D6).
ALTER TABLE client_metrics_cache
    ADD COLUMN IF NOT EXISTS rubro VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_cm_rubro ON client_metrics_cache(company, rubro);
