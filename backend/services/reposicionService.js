// Cola de reposición de Neggo.
// Los productos entran por dos caminos: se archivan en Odoo (= se agotaron) o alguien
// los marca "reponer" (queda poco). Se resuelven como repuesto o descartado.
// Solo lee Odoo a través de odoo_products_cache: nunca escribe en Odoo.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const SCHEMA_SQL = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '029_reposicion.sql'), 'utf8'
);

// Los productos de este proveedor se liquidan: se venden hasta agotarse y no se recompran
const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;

const ESTADOS_FINALES = ['repuesto', 'descartado'];

async function ensureSchema(db = pool) {
    await db.query(SCHEMA_SQL);
}

/**
 * Compara el estado activo del cache ANTES del sync con lo que trajo Odoo.
 * @param {Map<number, boolean>} antes — odoo_id → active previo en el cache
 * @param {Array<{id:number, active:boolean}>} productos — productos recibidos de Odoo
 * @returns {{ archivados: number[], reactivados: number[] }}
 */
function detectarTransiciones(antes, productos) {
    const archivados = [];
    const reactivados = [];
    for (const p of productos) {
        if (!antes.has(p.id)) continue; // producto nuevo: no hay cambio que detectar
        const eraActivo = antes.get(p.id) === true;
        if (eraActivo && !p.active) archivados.push(p.id);
        if (!eraActivo && p.active) reactivados.push(p.id);
    }
    return { archivados, reactivados };
}

/**
 * Mete en la cola productos archivados (origen 'archivado'), salvo los de "Liquidar".
 * Si ya estaban pendientes como 'reponer', pasan a 'archivado' (se agotaron).
 * @returns {Promise<number[]>} odoo_ids que quedaron en la cola
 */
async function registrarArchivados(odooIds, { createdBy = null, db = pool } = {}) {
    if (!odooIds.length) return [];
    const { rows } = await db.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, created_by)
         SELECT opc.odoo_id, 'neggo', 'archivado', $2
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo'
           AND opc.odoo_id = ANY($1::int[])
           AND NOT ${NO_REPONER_SQL}
         ON CONFLICT (odoo_id, company) WHERE estado = 'pendiente'
         DO UPDATE SET origen = 'archivado'
         RETURNING odoo_id`,
        [odooIds, createdBy]
    );
    return rows.map(r => r.odoo_id);
}

/**
 * Un producto que vuelve a estar activo ya se repuso: su pendiente queda 'repuesto'.
 * @returns {Promise<number>} cantidad de pendientes resueltos
 */
async function resolverReactivados(odooIds, { resolvedBy = null, db = pool } = {}) {
    if (!odooIds.length) return 0;
    const { rowCount } = await db.query(
        `UPDATE reposicion_items
         SET estado = 'repuesto', resolved_at = NOW(), resolved_by = $2,
             nota = COALESCE(nota, 'Se reactivó en Odoo')
         WHERE company = 'neggo' AND estado = 'pendiente' AND odoo_id = ANY($1::int[])`,
        [odooIds, resolvedBy]
    );
    return rowCount;
}

/**
 * Lo llama el sync de Odoo (empresa Neggo) con el estado previo del cache.
 * Un error acá no frena el sync.
 */
async function procesarSync(antes, productos) {
    const { archivados, reactivados } = detectarTransiciones(antes, productos);
    const encolados = await registrarArchivados(archivados);
    const repuestos = await resolverReactivados(reactivados);
    if (encolados.length || repuestos) {
        console.log(`📦 Reposición: ${encolados.length} archivado(s) a la cola, ${repuestos} reactivado(s) marcados repuestos`);
    }
    return { encolados: encolados.length, repuestos };
}

const SELECT_ITEM = `
    SELECT ri.id, ri.odoo_id, ri.origen, ri.estado, ri.qty_decidida, ri.nota,
           ri.created_at, ri.resolved_at,
           COALESCE(uc.display_name, uc.username) AS created_by_name,
           COALESCE(ur.display_name, ur.username) AS resolved_by_name,
           opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.has_image,
           opc.list_price, opc.standard_price, opc.categ_name, opc.active,
           COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name
    FROM reposicion_items ri
    LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ri.odoo_id AND opc.company = ri.company
    LEFT JOIN users uc ON uc.id = ri.created_by
    LEFT JOIN users ur ON ur.id = ri.resolved_by
`;

/**
 * Lista la cola. estado: 'pendiente' (default) o 'resueltos' (los últimos 200).
 */
async function listar({ estado = 'pendiente' } = {}) {
    if (estado === 'resueltos') {
        const { rows } = await pool.query(
            `${SELECT_ITEM} WHERE ri.estado = ANY($1::text[]) ORDER BY ri.resolved_at DESC NULLS LAST LIMIT 200`,
            [ESTADOS_FINALES]
        );
        return rows;
    }
    const { rows } = await pool.query(
        `${SELECT_ITEM} WHERE ri.estado = 'pendiente' ORDER BY vendor_name, ri.created_at`
    );
    return rows;
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Marca un producto activo como "reponer" (queda poco). No acepta productos de "Liquidar".
 */
async function agregarReponer(odooId, userId, nota = null) {
    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se repone`, 400);

    const { rows } = await pool.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, nota, created_by)
         VALUES ($1, 'neggo', 'reponer', $2, $3)
         ON CONFLICT (odoo_id, company) WHERE estado = 'pendiente' DO NOTHING
         RETURNING id`,
        [odooId, nota || null, userId]
    );
    if (!rows.length) throw httpError(`"${prod.name}" ya está en la cola de reposición`, 409);
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [rows[0].id]);
    return item;
}

/**
 * Resuelve un pendiente como 'repuesto' o 'descartado', o vuelve uno resuelto a 'pendiente'.
 */
async function cambiarEstado(id, { estado, qtyDecidida, nota }, userId) {
    if (![...ESTADOS_FINALES, 'pendiente'].includes(estado)) {
        throw httpError('Estado inválido: usá pendiente, repuesto o descartado', 400);
    }
    const qty = qtyDecidida == null || qtyDecidida === '' ? null : Number(qtyDecidida);
    if (qty !== null && (!Number.isInteger(qty) || qty < 0)) {
        throw httpError('La cantidad tiene que ser un número entero', 400);
    }
    const final = estado !== 'pendiente';
    try {
        const { rows } = await pool.query(
            `UPDATE reposicion_items
             SET estado = $2,
                 qty_decidida = COALESCE($3, qty_decidida),
                 nota = COALESCE($4, nota),
                 resolved_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
                 resolved_by = CASE WHEN $5 THEN $6::int ELSE NULL END
             WHERE id = $1
             RETURNING id`,
            [id, estado, qty, nota ?? null, final, userId]
        );
        if (!rows.length) throw httpError('Ítem de reposición no encontrado', 404);
    } catch (err) {
        // Volver a pendiente choca si el producto ya tiene otro pendiente
        if (err.code === '23505') throw httpError('Ese producto ya tiene otro pendiente en la cola', 409);
        throw err;
    }
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [id]);
    return item;
}

/**
 * Busca productos activos de Neggo para marcarlos "reponer" (nombre, referencia o código de barras).
 */
async function buscarProductos(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.list_price,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                EXISTS (SELECT 1 FROM reposicion_items ri
                        WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
                          AND ri.estado = 'pendiente') AS en_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.active = true
           AND (opc.name ILIKE $1 OR opc.internal_ref ILIKE $1 OR opc.barcode = $2)
         ORDER BY (opc.barcode = $2) DESC, opc.name
         LIMIT 20`,
        [`%${term}%`, term]
    );
    return rows;
}

module.exports = {
    ensureSchema,
    detectarTransiciones,
    registrarArchivados,
    resolverReactivados,
    procesarSync,
    listar,
    agregarReponer,
    cambiarEstado,
    buscarProductos,
};
