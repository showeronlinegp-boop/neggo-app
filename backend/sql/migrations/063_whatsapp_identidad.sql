-- Quién es cada chat del WhatsApp del negocio. WhatsApp manda casi todos los chats con un código
-- (…@lid) sin número ni nombre: esto se deduce (cotizaciones de Odoo nombradas en la charla, mapeos
-- de WhatsApp) o se asigna a mano. No se borra con la depuración semanal de mensajes.
-- Idempotente: la aplica whatsappIdentidadService al arrancar.

CREATE TABLE IF NOT EXISTS whatsapp_chat_identidad (
    id SERIAL PRIMARY KEY,
    chat_jid VARCHAR(100) NOT NULL UNIQUE,
    numero VARCHAR(20),
    nombre VARCHAR(200),
    odoo_partner_id INTEGER,
    -- cotizacion | whatsapp | manual | agente
    fuente VARCHAR(20) NOT NULL,
    -- alta | media | baja (las manuales son alta)
    confianza VARCHAR(10) NOT NULL DEFAULT 'media',
    -- De dónde salió: cotizaciones contadas por cliente, lid de WhatsApp, quién lo asignó
    evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_identidad_partner ON whatsapp_chat_identidad (odoo_partner_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_identidad_numero ON whatsapp_chat_identidad (numero);
