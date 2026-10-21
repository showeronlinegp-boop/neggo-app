-- CRM de clientes: fichas de Odoo duplicadas que la app muestra como un solo cliente (nota #72).
-- [{ id, name, tickets }] de cada partner unificado; vacío si el cliente tiene una sola ficha.
ALTER TABLE client_metrics_cache
    ADD COLUMN IF NOT EXISTS merged_partners JSONB DEFAULT '[]';
