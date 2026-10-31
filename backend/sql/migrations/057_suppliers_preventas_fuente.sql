-- De dónde toma Preventas los datos de un proveedor (nota 127). Solo aditiva.
--   web   → lo scrapeado de la web del proveedor (como hasta ahora)
--   neggo → los productos que Neggo tiene cargados para el proveedor en Odoo.
--           La web se sigue scrapeando para Reposición y Vínculos, pero no entra a Preventas.
-- Los proveedores con fuente interna (neggo_scraper) ya leen de Neggo: el valor no les cambia nada.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS preventas_fuente VARCHAR(10) NOT NULL DEFAULT 'web';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_preventas_fuente_check'
    ) THEN
        ALTER TABLE suppliers ADD CONSTRAINT suppliers_preventas_fuente_check
            CHECK (preventas_fuente IN ('web', 'neggo'));
    END IF;
END $$;
