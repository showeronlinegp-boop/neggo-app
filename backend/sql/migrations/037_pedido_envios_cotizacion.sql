-- Marca manual (solo en la app) de que la cotización ya se le mandó al cliente.
-- No se escribe en Odoo.

ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS cotizacion_enviada_at TIMESTAMP;
ALTER TABLE pedido_envios ADD COLUMN IF NOT EXISTS cotizacion_enviada_by INTEGER REFERENCES users(id);
