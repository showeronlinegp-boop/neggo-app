-- CRM de clientes, fase 2: posibles clientes, etapa del funnel, próximas acciones e historial.
-- El seguimiento vive solo en la app (D3). Cada fila es de un cliente de Odoo o de un posible
-- cliente, nunca de los dos. Ver docs/plan-crm-clientes.md.

-- Posibles clientes: todavía no son clientes en Odoo. Solo con celular o mail (D11).
CREATE TABLE IF NOT EXISTS crm_leads (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200),
    phone VARCHAR(30),                   -- +549XXXXXXXXXX
    phone_key VARCHAR(10) UNIQUE,        -- característica + número, para cruzar con Odoo
    email VARCHAR(200),
    city VARCHAR(120),
    source VARCHAR(40) NOT NULL DEFAULT 'manual',   -- manual | google_contacts
    source_status VARCHAR(20),           -- estado que traía el contacto: lead | nri | cliente | churn | recuperar
    source_list VARCHAR(40),             -- código de lista que traía el contacto: NLD-02, SLD, LD-30
    odoo_partner_id INTEGER,             -- cuando aparece en Odoo con el mismo teléfono
    linked_at TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (phone_key IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_partner ON crm_leads(odoo_partner_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_name ON crm_leads(name);
CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(source_status);

-- Etapa del funnel. Sin fila = Frío (D10: entran todos).
CREATE TABLE IF NOT EXISTS crm_followups (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER UNIQUE,
    lead_id INTEGER UNIQUE REFERENCES crm_leads(id) ON DELETE CASCADE,
    stage VARCHAR(20) NOT NULL DEFAULT 'frio',      -- frio | templado | caliente | ganado | descartado
    discard_reason VARCHAR(200),
    stage_changed_at TIMESTAMP DEFAULT NOW(),
    stage_changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK ((odoo_partner_id IS NULL) <> (lead_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_followups_stage ON crm_followups(stage);

-- Historial: contactos registrados, cambios de etapa, compras que lo hicieron ganar
CREATE TABLE IF NOT EXISTS crm_events (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER,
    lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL,           -- nota | llamar | whatsapp | visitar | lista | otra | etapa | compra
    text TEXT,
    meta JSONB DEFAULT '{}',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK ((odoo_partner_id IS NULL) <> (lead_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_events_partner ON crm_events(odoo_partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_events_lead ON crm_events(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_events_user ON crm_events(user_id);

-- Próximas acciones con fecha (Mi día)
CREATE TABLE IF NOT EXISTS crm_actions (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER,
    lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE,
    action_type VARCHAR(20) NOT NULL,    -- llamar | whatsapp | visitar | lista | otra
    note VARCHAR(500),
    due_date DATE NOT NULL,
    done BOOLEAN NOT NULL DEFAULT false,
    done_at TIMESTAMP,
    done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    result TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK ((odoo_partner_id IS NULL) <> (lead_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_actions_pending ON crm_actions(done, due_date);
CREATE INDEX IF NOT EXISTS idx_crm_actions_partner ON crm_actions(odoo_partner_id);
CREATE INDEX IF NOT EXISTS idx_crm_actions_lead ON crm_actions(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_actions_created_by ON crm_actions(created_by);
