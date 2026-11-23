-- CRM sobre WhatsApp: ficha comercial del prospecto. Resumen para vender (lo escribe Claude cada
-- noche con la charla del día o una persona a mano), objetivos de nutrición (Conocer e Informar),
-- lo que pidió (anotado a mano) y las cotizaciones de Odoo creadas desde la ficha.
-- El texto de los mensajes NO se guarda: la depuración semanal de 7 días sigue igual.
-- Idempotente: la aplica crmFichaService al arrancar (después de la 065 y la 066).

-- Lo que sabemos del prospecto. Conocer = ubicación (ciudad) + rubro o intereses.
CREATE TABLE IF NOT EXISTS crm_lead_perfil (
    lead_id INTEGER PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
    ciudad VARCHAR(120),
    tiene_local VARCHAR(20),            -- local | online | los_dos | null (no sabemos)
    rubro VARCHAR(120),
    intereses VARCHAR(300),
    proveedor_actual VARCHAR(200),
    trabas VARCHAR(300),
    volumen VARCHAR(200),
    compromisos VARCHAR(300),
    resumen TEXT,
    -- Hasta qué mensaje se resumió (el próximo resumen arranca de acá) y quién lo hizo
    resumen_hasta TIMESTAMPTZ,
    resumen_at TIMESTAMPTZ,
    resumen_por VARCHAR(20),            -- claude | manual
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Informar: qué pregunta frecuente ya se le contó (a mano, o detectada en lo que le mandamos)
CREATE TABLE IF NOT EXISTS crm_lead_informado (
    lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    respuesta_id INTEGER NOT NULL REFERENCES crm_respuestas(id) ON DELETE CASCADE,
    fuente VARCHAR(20) NOT NULL DEFAULT 'manual',   -- manual | chat | bot
    informado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (lead_id, respuesta_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_informado_respuesta ON crm_lead_informado (respuesta_id);

-- Lo que pidió, anotado a mano (de un mensaje de la charla o escrito). product_id = product.product
-- de Neggo en Odoo; sin producto no entra en la cotización.
CREATE TABLE IF NOT EXISTS crm_lead_pedido_items (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    texto VARCHAR(300) NOT NULL,
    cantidad NUMERIC(12,2),
    product_id INTEGER,
    product_name VARCHAR(500),
    -- De qué mensaje salió (solo la referencia: el texto del mensaje no se guarda)
    chat_jid VARCHAR(80),
    mensaje_id VARCHAR(100),
    -- Cotización en la que entró (null = todavía pendiente)
    cotizacion_id INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_pedido_items_lead ON crm_lead_pedido_items (lead_id);

-- Cotizaciones de Odoo creadas desde la ficha
CREATE TABLE IF NOT EXISTS crm_lead_cotizaciones (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    odoo_order_id INTEGER NOT NULL,
    odoo_order_name VARCHAR(40),
    odoo_partner_id INTEGER NOT NULL,
    partner_creado BOOLEAN NOT NULL DEFAULT false,
    lineas INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_cotizaciones_lead ON crm_lead_cotizaciones (lead_id);
