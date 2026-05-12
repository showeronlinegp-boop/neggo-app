-- Migración 013: normalizar columnas de supplier_category_rules
--
-- La tabla fue creada originalmente con dest_category (singular, NOT NULL).
-- El código evolucionó a dest_category_neggo + dest_category_preventas + ignored,
-- pero faltaba esta migración para bases de datos ya inicializadas.

DO $$ BEGIN
    -- Renombrar dest_category → dest_category_neggo si aún existe el nombre viejo
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'supplier_category_rules' AND column_name = 'dest_category'
    ) THEN
        ALTER TABLE supplier_category_rules RENAME COLUMN dest_category TO dest_category_neggo;
    END IF;
END $$;

-- Quitar NOT NULL (en el modelo nuevo ambas columnas son opcionales)
ALTER TABLE supplier_category_rules ALTER COLUMN dest_category_neggo DROP NOT NULL;

-- Agregar columna para empresa Preventas
ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS dest_category_preventas VARCHAR(200);

-- Agregar columna ignored
ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT false;
