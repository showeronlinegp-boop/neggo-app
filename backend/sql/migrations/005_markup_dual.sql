-- Migración 005: markup dual por empresa (Neggo vs Preventas)
-- Reemplaza default_markup (único) por markup_neggo + markup_preventas en suppliers
-- Agrega markup_neggo_override y markup_preventas_override en supplier_category_rules

-- =============================================
-- Tabla suppliers: agregar columnas de markup dual
-- =============================================
ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS markup_neggo     NUMERIC(5,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS markup_preventas NUMERIC(5,2) DEFAULT 0;

-- Inicializar con el valor actual de default_markup
UPDATE suppliers
SET markup_neggo     = default_markup,
    markup_preventas = default_markup
WHERE markup_neggo = 0 AND markup_preventas = 0;

-- =============================================
-- Tabla supplier_category_rules: agregar columnas de markup override dual
-- =============================================
ALTER TABLE supplier_category_rules
    ADD COLUMN IF NOT EXISTS markup_neggo_override     NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS markup_preventas_override NUMERIC(5,2);

-- Inicializar desde markup_override existente (si tiene valor)
UPDATE supplier_category_rules
SET markup_neggo_override     = markup_override,
    markup_preventas_override = markup_override
WHERE markup_override IS NOT NULL
  AND markup_neggo_override IS NULL
  AND markup_preventas_override IS NULL;
