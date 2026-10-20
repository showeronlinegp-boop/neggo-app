-- Solapa "Esperando pago": marca manual (solo en la app) de que el cliente ya pagó.
-- No se escribe en Odoo.

ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS pago_recibido_at TIMESTAMP;
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS pago_recibido_by INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_pe_cotizacion_enviada ON pedido_envios(cotizacion_enviada_at)
    WHERE cotizacion_enviada_at IS NOT NULL;
