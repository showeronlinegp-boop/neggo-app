// Imágenes para estados (nota #91): sorteo de productos y registro de lo descargado.
// Las imágenes se arman en el navegador; acá solo se elige qué sale y se anota lo bajado.
const fs = require('fs');
const path = require('path');
const { pickRandom, RECENT_DAYS } = require('./whatsappRandom');
const { COMPANIES } = require('./whatsappPrice');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'sql', 'estados_imagenes.sql'), 'utf8');
const FORMATOS = ['historia', 'cuadrada'];
const MAX_DESCARGAS = 500;

let schemaReady = null;

// Una sola vez por proceso: correrlo en cada request es lo que trababa la base (deadlock).
function ensureSchema(pool) {
    if (!schemaReady) {
        schemaReady = pool.query(SCHEMA_SQL).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

async function sortear(pool, { company, category, count, excludeIds }) {
    await ensureSchema(pool);
    return pickRandom(pool, { company, category, count, excludeIds, excludeDownloaded: true });
}

function validarDescargas({ company, odooIds, formato }) {
    if (!COMPANIES.includes(company)) throw new Error('La lista tiene que ser neggo o preventas');
    if (!FORMATOS.includes(formato)) throw new Error('El formato tiene que ser historia o cuadrada');
    const ids = [...new Set((Array.isArray(odooIds) ? odooIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new Error('No hay productos para anotar');
    if (ids.length > MAX_DESCARGAS) throw new Error(`Se pueden anotar hasta ${MAX_DESCARGAS} imágenes juntas`);
    return ids;
}

async function registrarDescargas(pool, { company, odooIds, formato, userId = null }) {
    const ids = validarDescargas({ company, odooIds, formato });
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`
        INSERT INTO estado_imagenes_descargas (company, odoo_id, formato, user_id)
        SELECT $1, id, $3, $4 FROM unnest($2::int[]) AS id
    `, [company, ids, formato, userId]);
    return { anotadas: rowCount, dias_sin_repetir: RECENT_DAYS };
}

module.exports = { ensureSchema, sortear, validarDescargas, registrarDescargas, FORMATOS };
