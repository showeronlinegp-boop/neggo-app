-- Limpieza de proveedores (nota #20). También corre en caliente desde initDatabase.js.
-- Antes de los DROP se rescatan default_markup / markup_override que no se hayan copiado (ver initDatabase.js).
-- El estado de un proveedor queda en active (activo/desactivado) + scrape_enabled (scraping sí/no).
-- Las categorías pendientes se calculan en vivo desde supplier_products y supplier_category_rules.
ALTER TABLE suppliers DROP COLUMN IF EXISTS status;            -- staging/active: lo reemplaza scrape_enabled
ALTER TABLE suppliers DROP COLUMN IF EXISTS is_published;      -- no lo leía nada
ALTER TABLE suppliers DROP COLUMN IF EXISTS default_markup;    -- reemplazado por markup_neggo / markup_preventas
ALTER TABLE suppliers DROP COLUMN IF EXISTS scrape_schedule;   -- nunca se configuró: el scraping se lanza desde /scraping
ALTER TABLE supplier_category_rules DROP COLUMN IF EXISTS markup_override;  -- reemplazado por los override por empresa
DROP TABLE IF EXISTS pending_category_mappings;               -- quedaba desactualizada al crear reglas
