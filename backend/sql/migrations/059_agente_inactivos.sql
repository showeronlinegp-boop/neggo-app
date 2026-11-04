-- API del agente (Grok Bot): seguimiento de clientes inactivos (más de 60 días sin comprar).
-- Es un flujo aparte de la cadencia de nuevos: no agrega valores a la etapa.

-- De qué flujo es cada envío. Los de inactivos no llevan etapa: llevan tipo_inactivo y el
-- ciclo (fecha de la última compra) al que pertenecen.
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS flujo VARCHAR(12) NOT NULL DEFAULT 'nuevos'
    CHECK (flujo IN ('nuevos', 'inactivos'));
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS tipo_inactivo VARCHAR(20)
    CHECK (tipo_inactivo IN ('primer_toque', 'segundo_toque'));
ALTER TABLE crm_bot_interacciones ADD COLUMN IF NOT EXISTS ciclo_desde DATE;

-- Cada toque de un ciclo: una sola reserva o envío activo (las canceladas y vencidas no cuentan)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_int_inactivo_activo
    ON crm_bot_interacciones(odoo_partner_id, ciclo_desde, tipo_inactivo)
    WHERE envio_etapa AND flujo = 'inactivos' AND estado IN ('reservado', 'enviado');
CREATE INDEX IF NOT EXISTS idx_bot_int_flujo ON crm_bot_interacciones(flujo, fecha DESC);

-- Estado del seguimiento de inactivos de cada cliente y la marca manual (excluido).
-- Sin fila = nunca se lo contactó como inactivo y sin marca.
CREATE TABLE IF NOT EXISTS crm_bot_seguimiento_inactivo (
    odoo_partner_id INTEGER PRIMARY KEY,
    ciclo_desde_compra DATE,
    toques_enviados SMALLINT NOT NULL DEFAULT 0 CHECK (toques_enviados BETWEEN 0 AND 2),
    ultimo_contacto TIMESTAMPTZ,
    ultimo_tipo VARCHAR(20) CHECK (ultimo_tipo IN ('primer_toque', 'segundo_toque')),
    proxima_accion DATE,
    cerrado BOOLEAN NOT NULL DEFAULT false,
    marca VARCHAR(20) CHECK (marca IN ('excluido')),
    marca_nota VARCHAR(500),
    marca_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_seg_inactivo_marca ON crm_bot_seguimiento_inactivo(marca) WHERE marca IS NOT NULL;
