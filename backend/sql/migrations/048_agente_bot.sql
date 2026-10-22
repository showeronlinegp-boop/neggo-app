-- API del agente (Grok Bot): cadencia de seguimiento de clientes nuevos e historial de mensajes.
-- Es distinto del embudo del CRM (crm_followups): esto es la cadencia del bot.
-- Sin fila en crm_bot_seguimiento = etapa 'pendiente' y no_contactar false.
CREATE TABLE IF NOT EXISTS crm_bot_seguimiento (
    odoo_partner_id INTEGER PRIMARY KEY,
    etapa VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (etapa IN ('pendiente', 'dia_1', 'dia_7', 'dia_15', 'finalizado')),
    ultimo_contacto TIMESTAMPTZ,
    proxima_accion DATE,
    no_contactar BOOLEAN NOT NULL DEFAULT false,
    no_contactar_at TIMESTAMPTZ,
    contacto VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_seg_etapa ON crm_bot_seguimiento(etapa);
CREATE INDEX IF NOT EXISTS idx_bot_seg_no_contactar ON crm_bot_seguimiento(no_contactar);

CREATE TABLE IF NOT EXISTS crm_bot_interacciones (
    id SERIAL PRIMARY KEY,
    odoo_partner_id INTEGER NOT NULL,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('enviado', 'recibido')),
    etapa VARCHAR(20) CHECK (etapa IN ('pendiente', 'dia_1', 'dia_7', 'dia_15', 'finalizado')),
    mensaje TEXT NOT NULL,
    respuesta TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_int_partner ON crm_bot_interacciones(odoo_partner_id, fecha DESC);

-- Lo que Grok quiere que cambie en la API (faltantes, errores, mejoras). Lo lee el equipo.
CREATE TABLE IF NOT EXISTS crm_bot_feedback (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('falta', 'error', 'mejora', 'comentario')),
    endpoint VARCHAR(200),
    mensaje TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_feedback_created ON crm_bot_feedback(created_at DESC);
