-- API del agente (Grok Bot), v2: envíos de la cadencia sin duplicados.
-- id_externo: lo manda el agente para que un reintento no guarde el mismo mensaje dos veces.
-- envio_etapa: el mensaje es el de una etapa de la cadencia (POST envios); cada etapa se manda una sola vez.
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS id_externo VARCHAR(100);
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS envio_etapa BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_int_id_externo
    ON crm_bot_interacciones(id_externo) WHERE id_externo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_int_envio_etapa
    ON crm_bot_interacciones(odoo_partner_id, etapa) WHERE envio_etapa;

-- Un cliente finalizado o que pidió no recibir mensajes no lleva próxima acción
UPDATE crm_bot_seguimiento SET proxima_accion = NULL
WHERE proxima_accion IS NOT NULL AND (no_contactar OR etapa = 'finalizado');
