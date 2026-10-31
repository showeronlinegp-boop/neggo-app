-- Propuestas de compra (plan de reposición automática, punto 6 / Etapa 1). Solo aditiva.
-- El motor arma las propuestas en el momento; acá queda lo que se APROBÓ: a quién, qué y a qué
-- precio se esperaba comprar, y por qué se eligió cada renglón. No escribe en Odoo.
-- Las columnas de envío y recepción (enviada_at, recibida_at, qty_recibida, precio_pagado) son
-- para la Etapa 2: hoy quedan vacías.

CREATE TABLE IF NOT EXISTS compra_propuestas (
    id SERIAL PRIMARY KEY,
    proveedor VARCHAR(200) NOT NULL,                -- proveedor de Odoo del pedido (canasta)
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'aprobada'
        CHECK (estado IN ('borrador', 'esperando_minimo', 'aprobada', 'enviada', 'recibida', 'cancelada')),
    total_estimado NUMERIC(14,2) NOT NULL DEFAULT 0,
    pedido_minimo_snapshot NUMERIC(12,2),
    solver VARCHAR(20),
    aprobada_at TIMESTAMP,
    aprobada_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
    enviada_at TIMESTAMP,
    enviada_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
    recibida_at TIMESTAMP,
    ingreso_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cp_proveedor ON compra_propuestas(proveedor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cp_estado ON compra_propuestas(estado);
CREATE INDEX IF NOT EXISTS idx_cp_supplier ON compra_propuestas(supplier_id);

CREATE TABLE IF NOT EXISTS compra_propuesta_items (
    id SERIAL PRIMARY KEY,
    propuesta_id INTEGER NOT NULL REFERENCES compra_propuestas(id) ON DELETE CASCADE,
    reposicion_item_id INTEGER REFERENCES reposicion_items(id) ON DELETE SET NULL,  -- vacío = solo encargue
    odoo_id INTEGER NOT NULL,
    supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE SET NULL, -- vacío = costo de Odoo
    nombre VARCHAR(300),
    qty INTEGER NOT NULL CHECK (qty > 0),
    pack INTEGER NOT NULL DEFAULT 1,
    precio_esperado NUMERIC(14,2),
    costo_efectivo NUMERIC(14,2),
    motivo VARCHAR(20),                              -- habitual, mas_barato, minimo, unico, manual
    alternativa JSONB,                               -- segundo mejor: proveedor y total
    qty_recibida INTEGER,
    precio_pagado NUMERIC(14,2),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cpi_propuesta ON compra_propuesta_items(propuesta_id);
CREATE INDEX IF NOT EXISTS idx_cpi_reposicion ON compra_propuesta_items(reposicion_item_id);
CREATE INDEX IF NOT EXISTS idx_cpi_odoo ON compra_propuesta_items(odoo_id);
CREATE INDEX IF NOT EXISTS idx_cpi_oferta ON compra_propuesta_items(supplier_product_id);
