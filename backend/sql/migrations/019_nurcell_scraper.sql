-- Migración 019: activar scraper de Nurcell
-- Nurcell está cargado como proveedor "Babu" (prefijo BB, partner Odoo 65).
-- Sus productos en Precompras usan external_id PREBB{codigo_limpio}.

UPDATE suppliers
SET scraper_key = 'nurcell',
    website_url = 'https://www.nurcell.com.ar',
    status      = 'active',
    updated_at  = NOW()
WHERE prefix = 'BB'
  AND (scraper_key IS NULL OR scraper_key = '');

SELECT id, name, prefix, scraper_key, website_url, status, default_discount
FROM suppliers
WHERE prefix = 'BB';
