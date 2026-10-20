-- Migración 029: cola de reposición (solo empresa Neggo)
--
-- Cada fila es un producto de Odoo Neggo que hay que evaluar para recomprar:
--   origen 'archivado' → se archivó en Odoo (= se agotó); lo detecta el sync
--   origen 'reponer'   → alguien lo marcó "queda poco, hay que comprar"
-- Al resolverlo queda 'repuesto' o 'descartado'. Un producto tiene como mucho
-- un pendiente a la vez (índice único parcial). Los del proveedor "Liquidar"
-- no entran nunca: se venden hasta agotarse y no se recompran.
-- La reposición solo lee Odoo (vía odoo_products_cache): no escribe en Odoo.
-- Idempotente: también la corre initDatabase al arrancar el backend.

CREATE TABLE IF NOT EXISTS reposicion_items (
    id            SERIAL PRIMARY KEY,
    odoo_id       INTEGER NOT NULL,
    company       VARCHAR(20) NOT NULL DEFAULT 'neggo' CHECK (company = 'neggo'),
    origen        VARCHAR(20) NOT NULL CHECK (origen IN ('archivado', 'reponer')),
    estado        VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'repuesto', 'descartado')),
    qty_decidida  INTEGER CHECK (qty_decidida IS NULL OR qty_decidida >= 0),
    nota          TEXT,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP DEFAULT NOW(),
    resolved_at   TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reposicion_pendiente
    ON reposicion_items (odoo_id, company) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_reposicion_estado  ON reposicion_items (estado);
CREATE INDEX IF NOT EXISTS idx_reposicion_odoo    ON reposicion_items (odoo_id, company);
CREATE INDEX IF NOT EXISTS idx_reposicion_created_by ON reposicion_items (created_by);
