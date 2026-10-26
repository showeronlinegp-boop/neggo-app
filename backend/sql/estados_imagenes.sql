-- Imágenes para estados (nota #91): se arman en el navegador y se descargan para subirlas a mano.
-- Lo descargado no vuelve a salir en el sorteo por unos días. Idempotente: se aplica al usarse.
CREATE TABLE IF NOT EXISTS estado_imagenes_descargas (
    id SERIAL PRIMARY KEY,
    company VARCHAR(20) NOT NULL CHECK (company IN ('neggo', 'preventas')),
    odoo_id INTEGER NOT NULL,
    formato VARCHAR(10) NOT NULL CHECK (formato IN ('historia', 'cuadrada')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estado_descargas_producto ON estado_imagenes_descargas(company, odoo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_estado_descargas_user ON estado_imagenes_descargas(user_id);
