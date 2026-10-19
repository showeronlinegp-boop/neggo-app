-- Catálogos ya descargados (nota #17): se marcan en dorado para saber cuáles ya se mandaron
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMP;
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS downloaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
