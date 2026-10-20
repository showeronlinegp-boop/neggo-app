-- Publicación de productos en grupos de WhatsApp (Evolution API).
-- Idempotente: corre en una base nueva (docker-entrypoint) y en una existente (initDatabase).

CREATE TABLE IF NOT EXISTS whatsapp_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    instance_name VARCHAR(40) NOT NULL DEFAULT 'neggo',
    group_jid VARCHAR(120),
    group_subject VARCHAR(200),
    interval_seconds INTEGER NOT NULL DEFAULT 90 CHECK (interval_seconds BETWEEN 10 AND 3600),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO whatsapp_settings (id, instance_name, interval_seconds)
VALUES (1, 'neggo', 90)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS whatsapp_batches (
    id SERIAL PRIMARY KEY,
    company VARCHAR(20) NOT NULL CHECK (company IN ('neggo', 'preventas')),
    category VARCHAR(200),
    dest_category VARCHAR(200),
    pricelist_id INTEGER REFERENCES client_pricelists(id),
    destino VARCHAR(20) NOT NULL DEFAULT 'grupo' CHECK (destino IN ('grupo', 'estado')),
    group_jid VARCHAR(120),
    group_subject VARCHAR(200),
    interval_seconds INTEGER NOT NULL DEFAULT 90 CHECK (interval_seconds BETWEEN 10 AND 3600),
    scheduled_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'programada'
        CHECK (status IN ('programada', 'en_curso', 'pausada', 'cancelada', 'completada')),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_batches_status ON whatsapp_batches(status, scheduled_at);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES whatsapp_batches(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    odoo_id INTEGER NOT NULL,
    company VARCHAR(20) NOT NULL,
    product_name VARCHAR(500) NOT NULL,
    price_amount INTEGER NOT NULL,
    price_label VARCHAR(40) NOT NULL,
    caption TEXT NOT NULL,
    image_template_id INTEGER,
    group_jid VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente', 'enviando', 'enviado', 'error')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
    last_error TEXT,
    evolution_message_id VARCHAR(160),
    scheduled_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, position)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_due
    ON whatsapp_messages(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_wa_messages_batch
    ON whatsapp_messages(batch_id, position);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER REFERENCES whatsapp_batches(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
    level VARCHAR(10) NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_logs_batch ON whatsapp_logs(batch_id, id DESC);

-- Bases que ya tenían la cola solo para grupos.
ALTER TABLE whatsapp_batches ADD COLUMN IF NOT EXISTS destino VARCHAR(20) NOT NULL DEFAULT 'grupo';
ALTER TABLE whatsapp_batches ALTER COLUMN group_jid DROP NOT NULL;
DO $$ BEGIN
    ALTER TABLE whatsapp_batches
        ADD CONSTRAINT whatsapp_batches_destino_check CHECK (destino IN ('grupo', 'estado'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
