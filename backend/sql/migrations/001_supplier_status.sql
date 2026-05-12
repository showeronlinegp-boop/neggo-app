-- =============================================
-- Migration 001: Columna status en suppliers
-- Agrega el ciclo de vida staging → active → inactive
-- =============================================

-- Agregar columna status con constraint de valores válidos
ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'staging'
        CHECK (status IN ('staging', 'active', 'inactive'));

-- Los proveedores existentes que ya tienen datos los promovemos a active
UPDATE suppliers SET status = 'active' WHERE last_scraped_at IS NOT NULL;

-- También promovemos los que no tienen scraper (proveedores manuales) si ya estaban active
UPDATE suppliers SET status = 'active' WHERE active = true AND scraper_key IS NULL;

-- Índice para filtrar por status (muy usado en scheduler y matching)
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);
