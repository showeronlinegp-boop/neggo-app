-- Agrega match_level a ingreso_items para distinguir vinculaciones automáticas de manuales.
-- Permite que los ítems sin código vinculados manualmente no sean reseteados al recargar.
ALTER TABLE ingreso_items
    ADD COLUMN IF NOT EXISTS match_level VARCHAR(30) DEFAULT NULL;
