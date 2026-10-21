-- Importancia del cliente o posible cliente (nota #71): 0 = sin marcar, 1 a 5 cuadraditos.
-- La pone el equipo a mano y pesa en la prioridad para llamar.
ALTER TABLE crm_followups
    ADD COLUMN IF NOT EXISTS importance SMALLINT NOT NULL DEFAULT 0
        CHECK (importance BETWEEN 0 AND 5),
    ADD COLUMN IF NOT EXISTS importance_changed_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS importance_changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_followups_importance ON crm_followups(importance) WHERE importance > 0;
