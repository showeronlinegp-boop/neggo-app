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
