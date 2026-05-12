-- Migración 007: normalizar SKUs mal generados por los scrapers
-- Problema: los scrapers agregaban prefijos propios (elrey-, imptk-, mali-)
-- y caracteres especiales que no coinciden con los external_id de Odoo Preventas.
-- Regla final: PRE{supplier_prefix}{codigo_limpio_mayusculas}

-- ─── El Rey ───────────────────────────────────────────────────────────────────
-- PREERelrey-3789 → PREER3789
UPDATE supplier_products sp
SET sku = 'PREER' || UPPER(REGEXP_REPLACE(SUBSTRING(sp.sku, 12), '[^A-Z0-9\-\.]', '', 'gi'))
FROM suppliers s
WHERE sp.supplier_id = s.id
  AND s.prefix = 'ER'
  AND sp.sku LIKE 'PREERelrey-%';

-- ─── Impotekno ────────────────────────────────────────────────────────────────
-- PREITimptk-010-LUNA → PREIT010LUNA  (uppercase, sin imptk-, sin chars especiales)
UPDATE supplier_products sp
SET sku = 'PREIT' || UPPER(REGEXP_REPLACE(SUBSTRING(sp.sku, 11), '[^A-Z0-9\-\.]', '', 'gi'))
FROM suppliers s
WHERE sp.supplier_id = s.id
  AND s.prefix = 'IT'
  AND sp.sku LIKE 'PREITimptk-%';

-- ─── CastMayorista — slugs en minúscula ───────────────────────────────────────
-- PRECTsahum-xxx → PRECTSAHUM-XXX  (uppercase, sin otros chars especiales)
-- Solo los que tienen letras minúsculas (los que vienen del scraper como slug)
UPDATE supplier_products sp
SET sku = 'PRECT' || UPPER(REGEXP_REPLACE(SUBSTRING(sp.sku, 6), '[^A-Z0-9\-\.]', '', 'gi'))
FROM suppliers s
WHERE sp.supplier_id = s.id
  AND s.prefix = 'CT'
  AND sp.sku ~ 'PRECT[a-z]';   -- tienen minúsculas → fueron generados como slug

-- ─── Verificación ─────────────────────────────────────────────────────────────
SELECT s.name, COUNT(*) AS total,
       COUNT(CASE WHEN sp.sku ~ '[a-z]' THEN 1 END) AS con_minusculas,
       COUNT(CASE WHEN sp.sku ~ 'imptk|elrey|mali' THEN 1 END) AS con_prefijo_viejo
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
GROUP BY s.name
ORDER BY s.name;
