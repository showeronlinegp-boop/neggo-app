-- API del agente (Grok Bot), v3: envío en dos pasos (reservar → mandar el WhatsApp → confirmar).
-- Una reserva bloquea la etapa durante unos minutos; si no se confirma, vence y la etapa se libera.
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS estado VARCHAR(12) NOT NULL DEFAULT 'enviado'
    CHECK (estado IN ('reservado', 'enviado', 'cancelado', 'vencido'));
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS reservado_hasta TIMESTAMPTZ;
-- Por qué se canceló: agente (no salió el WhatsApp) o no_contactar (el cliente pidió que no le escriban)
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS motivo_cancelacion VARCHAR(20);
-- Qué productos se recomendaron en el mensaje (product.product), para auditar y no repetir
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS productos_recomendados INTEGER[] NOT NULL DEFAULT '{}';

-- Cada etapa: una sola reserva o envío activo por cliente (las canceladas y vencidas no cuentan)
DROP INDEX IF EXISTS uq_bot_int_envio_etapa;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_int_envio_etapa_activo
    ON crm_bot_interacciones(odoo_partner_id, etapa) WHERE envio_etapa AND estado IN ('reservado', 'enviado');

-- Hasta cuándo el agente revisó las respuestas del cliente (para "respuesta pendiente")
ALTER TABLE crm_bot_seguimiento ADD COLUMN IF NOT EXISTS revisado_hasta TIMESTAMPTZ;
