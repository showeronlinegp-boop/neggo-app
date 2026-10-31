-- Interruptor "Va a Preventas" por proveedor (nota 125). Solo aditiva.
-- Todo lo scrapeado sigue yendo a Vínculos; a Sync Preventas solo van los proveedores prendidos:
--   prendido → se vincula con Preventas, propone crear, activar y cambiar precios
--   apagado  → no propone nada nuevo; sus productos activos en Preventas se proponen archivar
-- Arrancan prendidos solo los proveedores que ya tienen productos en Preventas (los que hoy
-- figuran en el cálculo de Sync Preventas); los nuevos arrancan apagados.
-- El valor inicial se carga solo al crear la columna: volver a correrla no pisa lo elegido.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'suppliers' AND column_name = 'va_a_preventas'
    ) THEN
        ALTER TABLE suppliers ADD COLUMN va_a_preventas BOOLEAN NOT NULL DEFAULT false;

        UPDATE suppliers s SET va_a_preventas = true
        WHERE EXISTS (
            SELECT 1 FROM preventas_sync_state pss
            WHERE pss.supplier_id = s.id AND pss.odoo_product_id IS NOT NULL
        );
    END IF;
END $$;
