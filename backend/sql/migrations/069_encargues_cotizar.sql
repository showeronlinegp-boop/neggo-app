-- Migración 069: encargues a cotizar (nota 248)
--
-- Mercadería que NO está en el catálogo y un cliente o prospecto pidió que averigüemos.
-- Se carga desde el botón «Pedidos» de Clientes › Chats y se ve en Reposición › A cotizar,
-- para tenerla a mano al armar los pedidos a los proveedores.
--   pendiente       → hay que averiguarlo
--   cotizado        → se consiguió: precio y proveedor cargados; falta avisarle al cliente
--   avisado         → ya se le avisó al cliente (cerrado)
--   no_se_consigue  → no se consiguió (cerrado)
-- contacto_tipo/contacto_id = la clave del chat: 'cliente' (partner de Odoo) o 'prospecto' (crm_leads.id).
-- Solo vive en la app: no escribe en Odoo. Idempotente: la corre el servicio la primera vez que se usa.

CREATE TABLE IF NOT EXISTS encargues_cotizar (
    id               SERIAL PRIMARY KEY,
    contacto_tipo    VARCHAR(20) NOT NULL CHECK (contacto_tipo IN ('cliente', 'prospecto')),
    contacto_id      INTEGER NOT NULL CHECK (contacto_id > 0),
    contacto_nombre  VARCHAR(200),
    texto            TEXT NOT NULL CHECK (length(btrim(texto)) > 0),
    cantidad         NUMERIC(12, 2) CHECK (cantidad IS NULL OR cantidad > 0),
    nota             TEXT,
    estado           VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente', 'cotizado', 'avisado', 'no_se_consigue')),
    precio           NUMERIC(14, 2) CHECK (precio IS NULL OR precio >= 0),
    proveedor        VARCHAR(200),
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW(),
    resolved_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_encargues_cotizar_estado     ON encargues_cotizar (estado);
CREATE INDEX IF NOT EXISTS idx_encargues_cotizar_contacto   ON encargues_cotizar (contacto_tipo, contacto_id);
CREATE INDEX IF NOT EXISTS idx_encargues_cotizar_created_by ON encargues_cotizar (created_by);
CREATE INDEX IF NOT EXISTS idx_encargues_cotizar_resolved_by ON encargues_cotizar (resolved_by);
