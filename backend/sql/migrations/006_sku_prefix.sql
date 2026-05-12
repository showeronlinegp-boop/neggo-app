-- Migración 006: normalizar SKUs de supplier_products al formato PRE{prefix}{sku_original}
-- Ejemplo: prefix=CT, sku=0250064 → PRECT0250064
-- Solo afecta productos que aún no tienen el prefijo PRE (idempotente)

UPDATE supplier_products sp
SET sku = 'PRE' || s.prefix || sp.sku
FROM suppliers s
WHERE sp.supplier_id = s.id
  AND sp.sku NOT LIKE 'PRE%';
