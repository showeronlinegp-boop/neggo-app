-- Nota 204: propuestas de publicaciones de WhatsApp armadas por Claude (skill publicaciones-temporada).
-- Claude solo elige los productos y el orden según la época del año; la pantalla /admin/whatsapp
-- las carga en "Generar imágenes" y una persona las revisa y programa como siempre.
-- Solo Neggo (es la única empresa con ventas en product_sales_weekly).

CREATE TABLE IF NOT EXISTS whatsapp_propuestas (
    id SERIAL PRIMARY KEY,
    company VARCHAR(20) NOT NULL DEFAULT 'neggo' CHECK (company = 'neggo'),
    titulo VARCHAR(200) NOT NULL,
    resumen TEXT,
    -- [{ "odoo_id": 123, "motivo": "..." }] en el orden en que conviene publicarlos
    items JSONB NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'usada', 'descartada', 'reemplazada')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_propuestas_estado ON whatsapp_propuestas(company, estado, created_at DESC);
