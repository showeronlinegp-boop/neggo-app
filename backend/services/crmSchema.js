// Esquema del CRM de clientes: aplica las migraciones al arrancar (son idempotentes).
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const SCHEMA = ['042_clientes_crm.sql', '043_clientes_rubro.sql', '044_crm_seguimiento.sql', '047_crm_importancia.sql']
    .map((file) => fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', file), 'utf8'))
    .join('\n');

let schemaReady = null;

function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

module.exports = { ensureSchema };
