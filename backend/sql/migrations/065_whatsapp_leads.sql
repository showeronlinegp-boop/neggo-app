-- CRM sobre WhatsApp, parte L1: cada chat del WhatsApp del negocio queda vinculado a un posible
-- cliente (crm_leads) o a un cliente de Odoo. Solo se guarda quién es cada chat, nunca el texto:
-- la depuración semanal de 7 días de evolution_negocio sigue igual.
-- Idempotente: la aplica whatsappLeadsService al arrancar (después de la 063).

ALTER TABLE whatsapp_chat_identidad
    ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;

-- Primer y último mensaje vistos (para ordenar y para saber desde cuándo habla con el negocio)
ALTER TABLE whatsapp_chat_identidad ADD COLUMN IF NOT EXISTS primer_mensaje_at TIMESTAMPTZ;
ALTER TABLE whatsapp_chat_identidad ADD COLUMN IF NOT EXISTS ultimo_mensaje_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_identidad_lead ON whatsapp_chat_identidad (lead_id);

-- Último mensaje de cada lado: para saber si la conversación espera respuesta nuestra (L2)
ALTER TABLE whatsapp_chat_identidad ADD COLUMN IF NOT EXISTS ultimo_de_ellos_at TIMESTAMPTZ;
ALTER TABLE whatsapp_chat_identidad ADD COLUMN IF NOT EXISTS ultimo_nuestro_at TIMESTAMPTZ;

-- Etapa que marcó una persona (gana sobre la automática hasta volver a automático). Ver leadEtapas.js
CREATE TABLE IF NOT EXISTS crm_lead_etapa_manual (
    lead_id INTEGER PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
    -- contactado | conversando | interesado | descartado
    etapa VARCHAR(20) NOT NULL,
    motivo VARCHAR(200),
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
