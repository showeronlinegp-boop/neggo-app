-- Migración 033: órdenes revisadas en Reposición (empresa Neggo)
-- La pestaña «Órdenes» lista las ventas (sale.order) y tickets de POS (pos.order)
-- de los últimos días leídos en vivo de Odoo. Cada orden es una tarea: se marca
-- qué reponer o archivar y se termina. Una fila acá = la orden ya se revisó.
-- Reabrir la orden borra la fila. Idempotente.

CREATE TABLE IF NOT EXISTS reposicion_ordenes (
    id             SERIAL PRIMARY KEY,
    company        VARCHAR(20) NOT NULL DEFAULT 'neggo' CHECK (company = 'neggo'),
    origen         VARCHAR(10) NOT NULL CHECK (origen IN ('venta', 'pos')),
    odoo_order_id  INTEGER NOT NULL,
    order_name     VARCHAR(100),
    revisada_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revisada_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMP DEFAULT NOW(),
    UNIQUE (company, origen, odoo_order_id)
);

CREATE INDEX IF NOT EXISTS idx_reposicion_ordenes_revisada_by ON reposicion_ordenes(revisada_by);
CREATE INDEX IF NOT EXISTS idx_reposicion_ordenes_revisada_at ON reposicion_ordenes(revisada_at DESC);
