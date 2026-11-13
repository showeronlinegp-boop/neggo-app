-- API del agente 3.8.0: alta manual de posibles clientes (POST /api/agente/leads).
-- Los que da de alta el bot quedan con source = 'agente_manual' (origen "manual" en la API):
-- entran a la cola aunque estén fuera de la zona de 150 km. Churn y no_contactar siguen afuera.
-- El teléfono ya es único (crm_leads.phone_key UNIQUE, migración 044).

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS direccion VARCHAR(300);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS rubro VARCHAR(100);

-- Para filtrar la cola por origen (?origen=manual)
CREATE INDEX IF NOT EXISTS idx_crm_leads_source ON crm_leads(source);
