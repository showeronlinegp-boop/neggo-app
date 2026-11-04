-- API del agente (Grok Bot): seguimiento de posibles clientes (crm_leads) por WhatsApp.
-- Es un flujo aparte del de clientes de Odoo: tablas propias, clave lead_id.
-- Cadencia: presentacion → recordatorio (7 días después) → cierre (14 días después).
-- Tope diario de envíos de la cadencia (AGENTE_LEADS_TOPE_DIARIO, 15 por defecto).

-- Estado del bot con cada posible cliente. Sin fila = etapa 'pendiente'.
CREATE TABLE IF NOT EXISTS crm_bot_lead_seguimiento (
    lead_id INTEGER PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
    etapa VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (etapa IN ('pendiente', 'presentacion', 'recordatorio', 'cierre', 'finalizado')),
    -- Cómo terminó: interesado | no_interesado | no_contactar | sin_respuesta | ya_en_odoo
    resultado VARCHAR(20)
        CHECK (resultado IN ('interesado', 'no_interesado', 'no_contactar', 'sin_respuesta', 'ya_en_odoo')),
    resultado_at TIMESTAMPTZ,
    ultimo_contacto TIMESTAMPTZ,
    no_contactar BOOLEAN NOT NULL DEFAULT false,
    no_contactar_at TIMESTAMPTZ,
    contacto VARCHAR(200),
    revisado_hasta TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_lead_seg_etapa ON crm_bot_lead_seguimiento(etapa);

-- Mensajes con cada posible cliente: los de la cadencia (envio_etapa, en dos pasos) y la charla.
CREATE TABLE IF NOT EXISTS crm_bot_lead_mensajes (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('enviado', 'recibido')),
    etapa VARCHAR(20) CHECK (etapa IN ('presentacion', 'recordatorio', 'cierre')),
    envio_etapa BOOLEAN NOT NULL DEFAULT false,
    estado VARCHAR(12) NOT NULL DEFAULT 'enviado'
        CHECK (estado IN ('reservado', 'enviado', 'cancelado', 'vencido')),
    reservado_hasta TIMESTAMPTZ,
    motivo_cancelacion VARCHAR(20),
    mensaje TEXT NOT NULL,
    id_externo VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_lead_msg_lead ON crm_bot_lead_mensajes(lead_id, fecha DESC);
-- Para contar los envíos del día contra el tope
CREATE INDEX IF NOT EXISTS idx_bot_lead_msg_envios ON crm_bot_lead_mensajes(fecha) WHERE envio_etapa;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_lead_msg_id_externo
    ON crm_bot_lead_mensajes(id_externo) WHERE id_externo IS NOT NULL;
-- Cada etapa: una sola reserva o envío activo por posible cliente
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_lead_msg_etapa_activa
    ON crm_bot_lead_mensajes(lead_id, etapa) WHERE envio_etapa AND estado IN ('reservado', 'enviado');
