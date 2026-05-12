-- =============================================
-- Ingreso de Mercadería — Módulo Nuevo
-- =============================================

CREATE TABLE IF NOT EXISTS ingreso_mercaderia (
    id SERIAL PRIMARY KEY,
    comprobante_numero VARCHAR(50) NOT NULL,
    comprobante_tipo VARCHAR(20) DEFAULT 'factura',
        CHECK (comprobante_tipo IN ('factura', 'remito', 'nota')),
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(255),
    estado VARCHAR(20) DEFAULT 'pending',
        CHECK (estado IN ('pending', 'validado', 'confirmado', 'rechazado')),
    items_count INTEGER DEFAULT 0,
    total_monto DECIMAL(12,2),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMP,
    UNIQUE(comprobante_numero, comprobante_tipo, supplier_id)
);

CREATE TABLE IF NOT EXISTS ingreso_items (
    id SERIAL PRIMARY KEY,
    ingreso_id INTEGER NOT NULL REFERENCES ingreso_mercaderia(id) ON DELETE CASCADE,
    codigo VARCHAR(100) NOT NULL,
    descripcion VARCHAR(255),
    cantidad INTEGER NOT NULL,
    precio_unitario DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(12,2),
    odoo_product_id INTEGER,
    odoo_product_name VARCHAR(255),
    precio_odoo_anterior DECIMAL(10,2),
    precio_odoo_nuevo DECIMAL(10,2),
    cantidad_odoo_anterior INTEGER,
    cantidad_odoo_nueva INTEGER,
    error_match TEXT,
    confidence_match DECIMAL(3,2),
    estado_item VARCHAR(20) DEFAULT 'pending',
        CHECK (estado_item IN ('pending', 'matched', 'rejected')),
    motivo_rechazo TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingreso_supplier ON ingreso_mercaderia(supplier_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingreso_items ON ingreso_items(ingreso_id, odoo_product_id);
CREATE INDEX IF NOT EXISTS idx_ingreso_items_estado ON ingreso_items(ingreso_id, estado_item);
