// Cola de reposición de Neggo.
// Orígenes: archivado (sync / baja), reponer (manual), recorrida (escáner).
// De la cola pueden pasar a 'encargado' (se pidió al proveedor) y, si no llega,
// volver a pendiente. Se cierran como repuesto o descartado.
// Un ingreso con el producto activo para Neggo se marca llego_ingreso.
// Neggo no lleva stock en Odoo: archivar = dar de baja. No hay origen bajo_stock.
// Lee Odoo vía cache. Archivar/activar escriben en Odoo solo a pedido de la UI.
// No genera OC: no usamos el módulo de compras (por ahora).

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const odooService = require('./odooService');

const SCHEMA_029 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '029_reposicion.sql'), 'utf8'
);
const SCHEMA_030 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '030_reposicion_completo.sql'), 'utf8'
);
const SCHEMA_031 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '031_reposicion_encargado.sql'), 'utf8'
);

const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;
const VENDOR_SQL = `COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor')`;
const TOP_VENDIDOS = 20;
const MAX_ACTIVOS = 200;
const MAX_ARCHIVADOS = 100;

const ESTADOS_FINALES = ['repuesto', 'descartado'];
const ESTADOS_ABIERTOS = ['pendiente', 'encargado'];
const CONFLICT_ABIERTOS = `(odoo_id, company) WHERE estado IN ('pendiente', 'encargado')`;
const ORIGEN_RANK = { archivado: 3, recorrida: 2, reponer: 1 };

function semanasCobertura() {
    const n = parseFloat(process.env.REPOSICION_COBERTURA_SEMANAS);
    return Number.isFinite(n) && n > 0 ? n : 2;
}

function vendorLabel(name) {
    const s = String(name || '').trim();
    return s || 'Sin proveedor';
}

function origenDesdeActivo(active) {
    return active ? 'reponer' : 'archivado';
}

function conQtySemana(productos, qtyById) {
    return productos.map(p => ({ ...p, qty_semana: qtyById.get(p.odoo_id) || 0 }));
}

function porVentasLuegoNombre(a, b) {
    return (b.qty_semana - a.qty_semana) || String(a.name || '').localeCompare(String(b.name || ''), 'es');
}

function rankearMasVendidos(productos, qtyById, limit = TOP_VENDIDOS) {
    return conQtySemana(productos, qtyById)
        .filter(p => p.qty_semana > 0)
        .sort(porVentasLuegoNombre)
        .slice(0, limit);
}

function rankearActivos(productos, qtyById, limit = MAX_ACTIVOS) {
    return conQtySemana(productos.filter(p => p.active !== false), qtyById)
        .sort(porVentasLuegoNombre)
        .slice(0, limit);
}

function rankearArchivados(productos, qtyById, limit = MAX_ARCHIVADOS) {
    return conQtySemana(productos.filter(p => !p.active), qtyById)
        .sort(porVentasLuegoNombre)
        .slice(0, limit);
}

async function ensureSchema(db = pool) {
    await db.query(SCHEMA_029);
    await db.query(SCHEMA_030);
    await db.query(SCHEMA_031);
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
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
        if (!antes.has(p.id)) continue;
        const eraActivo = antes.get(p.id) === true;
        if (eraActivo && !p.active) archivados.push(p.id);
        if (!eraActivo && p.active) reactivados.push(p.id);
    }
    return { archivados, reactivados };
}

/**
 * Mete en la cola productos archivados (origen 'archivado'), salvo los de "Liquidar".
 * Si ya estaban pendientes con otro origen, suben a 'archivado'.
 * Si ya estaban encargados, no los toca: siguen esperando el pedido.
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
         ON CONFLICT ${CONFLICT_ABIERTOS}
         DO UPDATE SET origen = 'archivado'
         WHERE reposicion_items.estado = 'pendiente'
         RETURNING odoo_id`,
        [odooIds, createdBy]
    );
    return rows.map(r => r.odoo_id);
}

/**
 * Un producto que vuelve a estar activo ya se repuso: pendiente o encargado quedan 'repuesto'.
 */
async function resolverReactivados(odooIds, { resolvedBy = null, db = pool } = {}) {
    if (!odooIds.length) return 0;
    const { rowCount } = await db.query(
        `UPDATE reposicion_items
         SET estado = 'repuesto', resolved_at = NOW(), resolved_by = $2,
             nota = COALESCE(nota, 'Se reactivó en Odoo')
         WHERE company = 'neggo' AND estado IN ('pendiente', 'encargado') AND odoo_id = ANY($1::int[])`,
        [odooIds, resolvedBy]
    );
    return rowCount;
}

/**
 * Lo llama el sync de Odoo (empresa Neggo) con el estado previo del cache.
 * Solo detecta altas/bajas por archivo: Neggo no usa qty_available para reponer.
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

/**
 * Un ingreso “cruza” la cola si el producto está matcheado, activo para Neggo
 * (no archivado en el ingreso), con unidades que no se fueron todas a Preventas,
 * y el comprobante es posterior a cuando el ítem entró a la cola.
 */
function cruzaIngresoActivoNeggo({
    estadoItem,
    odooActive,
    odooCompany,
    ingresoEstado,
    preventaQtyConfirmed,
    cantidad,
    ingresoAt,
    colaCreatedAt,
} = {}) {
    if (estadoItem !== 'matched') return false;
    if (odooActive === false) return false;
    if ((odooCompany || 'neggo') !== 'neggo') return false;
    if (ingresoEstado === 'rechazado') return false;
    const cant = Number(cantidad);
    const prev = Number(preventaQtyConfirmed) || 0;
    if (Number.isFinite(cant) && cant > 0 && prev >= cant) return false;
    if (ingresoAt && colaCreatedAt && new Date(ingresoAt) < new Date(colaCreatedAt)) return false;
    return true;
}

const INGRESO_LATERAL = `
    LEFT JOIN LATERAL (
        SELECT im.id AS ingreso_id,
               im.comprobante_numero AS ingreso_comprobante,
               im.created_at AS ingreso_at,
               im.estado AS ingreso_estado,
               ii.cantidad AS ingreso_qty
        FROM ingreso_items ii
        JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
        WHERE ii.odoo_product_id = ri.odoo_id
          AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'
          AND ii.estado_item = 'matched'
          AND ii.odoo_active IS DISTINCT FROM FALSE
          AND im.estado IS DISTINCT FROM 'rechazado'
          AND COALESCE(ii.preventa_qty_confirmed, 0) < ii.cantidad
          AND im.created_at >= ri.created_at
        ORDER BY im.created_at DESC
        LIMIT 1
    ) ing ON TRUE
`;

const SELECT_ITEM = `
    SELECT ri.id, ri.odoo_id, ri.origen, ri.estado, ri.qty_decidida, ri.qty_sugerida, ri.nota,
           ri.created_at, ri.resolved_at, ri.encargado_at,
           COALESCE(uc.display_name, uc.username) AS created_by_name,
           COALESCE(ur.display_name, ur.username) AS resolved_by_name,
           COALESCE(ue.display_name, ue.username) AS encargado_by_name,
           opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.has_image,
           opc.list_price, opc.standard_price, opc.categ_name, opc.active, opc.qty_available,
           ${VENDOR_SQL} AS vendor_name,
           ing.ingreso_id, ing.ingreso_comprobante, ing.ingreso_at,
           ing.ingreso_estado, ing.ingreso_qty,
           (ing.ingreso_id IS NOT NULL) AS llego_ingreso
    FROM reposicion_items ri
    LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ri.odoo_id AND opc.company = ri.company
    LEFT JOIN users uc ON uc.id = ri.created_by
    LEFT JOIN users ur ON ur.id = ri.resolved_by
    LEFT JOIN users ue ON ue.id = ri.encargado_by
    ${INGRESO_LATERAL}
`;

/**
 * Lista la cola. estado: 'pendiente' (default), 'encargado' o 'resueltos' (los últimos 200).
 */
async function listar({ estado = 'pendiente' } = {}) {
    if (estado === 'resueltos') {
        const { rows } = await pool.query(
            `${SELECT_ITEM} WHERE ri.estado = ANY($1::text[])
             ORDER BY (ing.ingreso_id IS NOT NULL) DESC, ri.resolved_at DESC NULLS LAST
             LIMIT 200`,
            [ESTADOS_FINALES]
        );
        return rows;
    }
    if (estado === 'encargado') {
        const { rows } = await pool.query(
            `${SELECT_ITEM} WHERE ri.estado = 'encargado'
             ORDER BY (ing.ingreso_id IS NOT NULL) DESC, vendor_name, ri.encargado_at NULLS LAST, ri.created_at`
        );
        return rows;
    }
    const { rows } = await pool.query(
        `${SELECT_ITEM} WHERE ri.estado = 'pendiente'
         ORDER BY (ing.ingreso_id IS NOT NULL) DESC, vendor_name, ri.created_at`
    );
    return rows;
}

/**
 * Marca un producto para reponer. origen pedido: reponer | recorrida.
 * Si el producto está archivado y se pidió 'reponer', entra como agotado.
 */
async function agregarReponer(odooId, userId, nota = null, origenPedido = 'reponer') {
    if (origenPedido !== 'reponer' && origenPedido !== 'recorrida') {
        throw httpError('Origen inválido: usá reponer o recorrida', 400);
    }

    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se repone`, 400);

    const origenFinal = origenPedido === 'recorrida' ? 'recorrida' : origenDesdeActivo(prod.active);

    const { rows: [existente] } = await pool.query(
        `SELECT id, origen, estado FROM reposicion_items
         WHERE company = 'neggo' AND estado IN ('pendiente', 'encargado') AND odoo_id = $1`,
        [odooId]
    );
    if (existente) {
        if (existente.estado === 'encargado') {
            throw httpError(`"${prod.name}" ya está encargado`, 409);
        }
        if ((ORIGEN_RANK[origenFinal] || 0) > (ORIGEN_RANK[existente.origen] || 0)) {
            await pool.query(
                `UPDATE reposicion_items SET origen = $2, nota = COALESCE($3, nota) WHERE id = $1`,
                [existente.id, origenFinal, nota || null]
            );
            const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [existente.id]);
            return item;
        }
        throw httpError(`"${prod.name}" ya está en la cola de reposición`, 409);
    }

    const { rows } = await pool.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, nota, created_by)
         VALUES ($1, 'neggo', $2, $3, $4)
         RETURNING id`,
        [odooId, origenFinal, nota || null, userId]
    );
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [rows[0].id]);
    return item;
}

/**
 * Archiva en Odoo un producto activo de Neggo y lo mete a la cola como agotado.
 */
async function archivarYEncolar(odooId, userId) {
    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se archiva ni se repone`, 400);
    if (!prod.active) throw httpError(`"${prod.name}" ya está archivado`, 409);

    await odooService.setProductArchived(odooId, 'neggo', true);
    await pool.query(
        `UPDATE odoo_products_cache
            SET locally_archived = true, active = false
          WHERE odoo_id = $1 AND company = 'neggo'`,
        [odooId]
    );
    await registrarArchivados([odooId], { createdBy: userId });
    const { rows: [item] } = await pool.query(
        `${SELECT_ITEM} WHERE ri.odoo_id = $1 AND ri.company = 'neggo'
           AND ri.estado IN ('pendiente', 'encargado')`,
        [odooId]
    );
    if (!item) throw httpError(`Se archivó "${prod.name}" en Odoo pero no quedó en la cola`, 500);
    return item;
}

/**
 * Reactiva en Odoo un producto archivado de Neggo y lo saca de la cola de reposición
 * (pendiente o encargado). Desarchivar a mano es deshacer: no queda como repuesto.
 * El sync, en cambio, sigue cerrando como repuesto lo que se reactiva en Odoo.
 */
async function activarYResolver(odooId) {
    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se activa ni se repone`, 400);
    if (prod.active) throw httpError(`"${prod.name}" ya está activo`, 409);

    await odooService.setProductArchived(odooId, 'neggo', false);
    await pool.query(
        `UPDATE odoo_products_cache
            SET locally_archived = false, active = true
          WHERE odoo_id = $1 AND company = 'neggo'`,
        [odooId]
    );
    const { rowCount: cerrados } = await pool.query(
        `DELETE FROM reposicion_items
         WHERE company = 'neggo' AND estado IN ('pendiente', 'encargado') AND odoo_id = $1`,
        [odooId]
    );
    const { rows: [item] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, opc.internal_ref, opc.barcode,
                opc.image_url, opc.standard_price, opc.list_price
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    return { ...(item || prod), cola_cerrada: cerrados > 0 };
}

/**
 * Cambia el estado: pendiente, encargado, repuesto o descartado.
 * Encargado no cierra el ítem: si no llega, vuelve a pendiente.
 */
async function cambiarEstado(id, { estado, qtyDecidida, nota }, userId) {
    if (![...ESTADOS_ABIERTOS, ...ESTADOS_FINALES].includes(estado)) {
        throw httpError('Estado inválido: usá pendiente, encargado, repuesto o descartado', 400);
    }
    const qty = qtyDecidida == null || qtyDecidida === '' ? null : Number(qtyDecidida);
    if (qty !== null && (!Number.isInteger(qty) || qty < 0)) {
        throw httpError('La cantidad tiene que ser un número entero', 400);
    }
    const final = ESTADOS_FINALES.includes(estado);
    const aEncargado = estado === 'encargado';
    try {
        const { rows } = await pool.query(
            `UPDATE reposicion_items
             SET estado = $2::varchar,
                 qty_decidida = COALESCE($3, qty_decidida),
                 nota = COALESCE($4, nota),
                 resolved_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
                 resolved_by = CASE WHEN $5 THEN $6::int ELSE NULL END,
                 encargado_at = CASE
                     WHEN $7 THEN NOW()
                     WHEN $2::varchar = 'pendiente' THEN NULL
                     ELSE encargado_at
                 END,
                 encargado_by = CASE
                     WHEN $7 THEN $6::int
                     WHEN $2::varchar = 'pendiente' THEN NULL
                     ELSE encargado_by
                 END
             WHERE id = $1
             RETURNING id`,
            [id, estado, qty, nota ?? null, final, userId, aEncargado]
        );
        if (!rows.length) throw httpError('Ítem de reposición no encontrado', 404);
    } catch (err) {
        if (err.code === '23505') throw httpError('Ese producto ya tiene otro pendiente o encargado en la cola', 409);
        throw err;
    }
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [id]);
    return item;
}

/**
 * Saca de la cola un producto marcado por error. Solo si está pendiente:
 * lo encargado ya se pidió al proveedor y se maneja desde la cola.
 * No toca Odoo: si estaba archivado, sigue archivado.
 */
async function quitarDeCola(odooId) {
    const { rows: [item] } = await pool.query(
        `SELECT ri.id, ri.estado, ri.origen, opc.name
         FROM reposicion_items ri
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ri.odoo_id AND opc.company = ri.company
         WHERE ri.company = 'neggo' AND ri.odoo_id = $1 AND ri.estado IN ('pendiente', 'encargado')`,
        [odooId]
    );
    if (!item) throw httpError('Ese producto ya no está en la cola', 404);
    if (item.estado === 'encargado') {
        throw httpError(`"${item.name || odooId}" ya está encargado: volvelo a pendientes o descartalo desde la cola`, 409);
    }
    await pool.query(`DELETE FROM reposicion_items WHERE id = $1`, [item.id]);
    return { odoo_id: odooId, name: item.name, origen: item.origen };
}

const ESTADO_COLA_SQL =`(SELECT ri.estado FROM reposicion_items ri
            WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
              AND ri.estado IN ('pendiente', 'encargado')
            LIMIT 1)`;

/**
 * Busca productos activos de Neggo para marcarlos "reponer".
 */
async function buscarProductos(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.list_price,
                opc.qty_available,
                ${VENDOR_SQL} AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                ${ESTADO_COLA_SQL} AS estado_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.active = true
           AND (opc.name ILIKE $1 OR opc.internal_ref ILIKE $1 OR opc.barcode = $2)
         ORDER BY (opc.barcode = $2) DESC, opc.name
         LIMIT 20`,
        [`%${term}%`, term]
    );
    return rows.map(r => ({ ...r, en_cola: !!r.estado_cola }));
}

const SELECT_PROD = `
    opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
    opc.list_price, opc.standard_price, opc.qty_available, opc.active,
    ${VENDOR_SQL} AS vendor_name,
    ${ESTADO_COLA_SQL} AS estado_cola
`;

/**
 * Todos los proveedores de Neggo en el cache (salvo Liquidar), con conteos.
 */
async function listarProveedores() {
    const { rows } = await pool.query(
        `SELECT ${VENDOR_SQL} AS vendor_name,
                COUNT(*) FILTER (WHERE opc.active) AS n_activos,
                COUNT(*) FILTER (WHERE NOT opc.active) AS n_archivados,
                COUNT(ri.id) FILTER (WHERE ri.estado = 'pendiente') AS n_pendientes,
                COUNT(ri.id) FILTER (WHERE ri.estado = 'encargado') AS n_encargados,
                COUNT(ri.id) FILTER (WHERE ri.estado = 'pendiente' AND ri.origen = 'archivado') AS n_agotados
         FROM odoo_products_cache opc
         LEFT JOIN reposicion_items ri
           ON ri.odoo_id = opc.odoo_id AND ri.company = opc.company
          AND ri.estado IN ('pendiente', 'encargado')
         WHERE opc.company = 'neggo'
           AND NOT ${NO_REPONER_SQL}
         GROUP BY 1
         ORDER BY n_pendientes DESC, n_encargados DESC, vendor_name`
    );
    return rows.map(r => ({
        vendor_name:  r.vendor_name,
        n_activos:    Number(r.n_activos) || 0,
        n_archivados: Number(r.n_archivados) || 0,
        n_pendientes: Number(r.n_pendientes) || 0,
        n_encargados: Number(r.n_encargados) || 0,
        n_agotados:   Number(r.n_agotados) || 0,
    }));
}

/** Busca un producto de Neggo por código de barras exacto (recorrida). */
async function buscarPorBarcode(barcode) {
    const code = String(barcode || '').trim();
    if (!code) return null;
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
                opc.list_price, opc.standard_price, opc.qty_available,
                ${VENDOR_SQL} AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                ${ESTADO_COLA_SQL} AS estado_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.barcode = $1
         LIMIT 1`,
        [code]
    );
    const prod = rows[0];
    if (!prod) return null;
    return { ...prod, en_cola: !!prod.estado_cola };
}

function lunesDe(fecha) {
    const d = new Date(fecha);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
}

/**
 * Métricas de venta por odoo_id a partir de product_sales_weekly.
 */
async function metricasVenta(odooIds) {
    if (!odooIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT odoo_id, week_start, qty_vendida, amount_total
         FROM product_sales_weekly
         WHERE company = 'neggo' AND odoo_id = ANY($1::int[])
           AND week_start >= (CURRENT_DATE - INTERVAL '35 days')
         ORDER BY odoo_id, week_start DESC`,
        [odooIds]
    );
    const byId = new Map();
    for (const r of rows) {
        if (!byId.has(r.odoo_id)) byId.set(r.odoo_id, []);
        byId.get(r.odoo_id).push(r);
    }
    const out = new Map();
    const cobertura = semanasCobertura();
    for (const id of odooIds) {
        const weeks = byId.get(id) || [];
        const qty7 = weeks[0] ? Number(weeks[0].qty_vendida) : 0;
        const last4 = weeks.slice(0, 4);
        const avgWeekly = last4.length
            ? last4.reduce((s, w) => s + Number(w.qty_vendida), 0) / last4.length
            : 0;
        const qty30 = weeks.reduce((s, w) => s + Number(w.qty_vendida), 0);
        let ritmo = 'sin_datos';
        if (avgWeekly > 0 || qty7 > 0) {
            if (avgWeekly <= 0) ritmo = 'reponer';
            else if (qty7 >= avgWeekly * 1.15) ritmo = 'reponer';
            else if (qty7 <= avgWeekly * 0.7) ritmo = 'flojo';
            else ritmo = 'estable';
        }
        out.set(id, { qty_7d: qty7, avg_weekly: avgWeekly, qty_30d: qty30, ritmo });
    }
    void cobertura;
    return out;
}

/**
 * Pareto ABC por unidades vendidas (qty_30d), no por monto.
 */
function clasificarAbc(itemsConQty) {
    const sorted = [...itemsConQty].sort((a, b) => b.qty_30d - a.qty_30d);
    const total = sorted.reduce((s, i) => s + i.qty_30d, 0);
    const labels = new Map();
    if (total <= 0) {
        for (const i of sorted) labels.set(i.odoo_id, 'C');
        return labels;
    }
    let acum = 0;
    for (const i of sorted) {
        acum += i.qty_30d;
        const pct = acum / total;
        labels.set(i.odoo_id, pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C');
    }
    return labels;
}

async function colaConMetricas(vendor) {
    const { rows: items } = await pool.query(
        `${SELECT_ITEM}
         WHERE ri.estado = 'pendiente'
           AND ${VENDOR_SQL} = $1
         ORDER BY ri.created_at`,
        [vendor]
    );

    let ventasMeta = null;
    try {
        ventasMeta = await require('../jobs/salesWeeklySync').ensureFresh(12);
    } catch (err) {
        console.warn(`⚠️ Reposición: no se pudieron refrescar ventas: ${err.message}`);
    }

    const ids = items.map(i => i.odoo_id);
    const metrics = await metricasVenta(ids);
    const forAbc = ids.map(id => ({
        odoo_id: id,
        qty_30d: metrics.get(id)?.qty_30d || 0,
    }));
    const abc = clasificarAbc(forAbc);
    const cobertura = semanasCobertura();

    const enriched = items.map(it => {
        const m = metrics.get(it.odoo_id) || { qty_7d: 0, avg_weekly: 0, qty_30d: 0, ritmo: 'sin_datos' };
        const sugerida = m.avg_weekly > 0
            ? Math.max(1, Math.ceil(m.avg_weekly * cobertura))
            : (m.qty_7d > 0 ? Math.max(1, Math.ceil(m.qty_7d)) : 0);
        return {
            ...it,
            qty_7d: m.qty_7d,
            avg_weekly: Math.round(m.avg_weekly * 100) / 100,
            qty_30d: m.qty_30d,
            ritmo: m.ritmo,
            abc: abc.get(it.odoo_id) || 'C',
            qty_sugerida_calc: sugerida,
        };
    });

    return {
        items: enriched,
        ventas: ventasMeta,
        resumen: {
            pendientes: enriched.length,
            reponer: enriched.filter(i => i.ritmo === 'reponer').length,
            flojo: enriched.filter(i => i.ritmo === 'flojo').length,
            sin_datos: enriched.filter(i => i.ritmo === 'sin_datos').length,
        },
    };
}

/**
 * Detalle de un proveedor: catálogo (activos/archivados) + cola pendiente con métricas.
 */
async function detalleProveedor(nombre) {
    const vendor = vendorLabel(nombre);
    const { rows: productos } = await pool.query(
        `SELECT ${SELECT_PROD}
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo'
           AND ${VENDOR_SQL} = $1
           AND NOT ${NO_REPONER_SQL}
         ORDER BY opc.name`,
        [vendor]
    );
    if (!productos.length) throw httpError(`No hay productos de "${vendor}" en Neggo`, 404);

    const conCola = productos.map(p => ({ ...p, en_cola: !!p.estado_cola }));
    const ventas = await odooService.getWeeklySoldQty('neggo');
    const activos = rankearActivos(conCola, ventas.qtyById);
    const archivados = rankearArchivados(conCola, ventas.qtyById);
    const cola = await colaConMetricas(vendor);

    return {
        vendor_name: vendor,
        n_productos: productos.length,
        n_activos_total: productos.filter(p => p.active).length,
        n_archivados_total: productos.filter(p => !p.active).length,
        ventas_error: ventas.error,
        ventas_desde: ventas.desde,
        activos,
        archivados,
        ...cola,
    };
}

/**
 * Resuelve en lote pendientes como repuesto/descartado (con qty opcional).
 */
async function resolverLote({ items, estado = 'repuesto' }, userId) {
    if (!items?.length) throw httpError('Seleccioná al menos un producto', 400);
    if (![...ESTADOS_FINALES].includes(estado)) {
        throw httpError('Estado inválido: usá repuesto o descartado', 400);
    }
    const resolved = [];
    for (const raw of items) {
        const id = parseInt(raw.id, 10);
        if (!Number.isInteger(id)) continue;
        const item = await cambiarEstado(id, {
            estado,
            qtyDecidida: raw.qty_decidida,
            nota: raw.nota,
        }, userId);
        resolved.push(item);
    }
    if (!resolved.length) throw httpError('No hay pendientes válidos', 400);
    console.log(`✅ Reposición: ${resolved.length} ítem(s) → ${estado}`);
    return { resueltos: resolved.length, items: resolved };
}

module.exports = {
    ensureSchema,
    detectarTransiciones,
    registrarArchivados,
    resolverReactivados,
    procesarSync,
    listar,
    agregarReponer,
    archivarYEncolar,
    activarYResolver,
    cambiarEstado,
    quitarDeCola,
    buscarProductos,
    buscarPorBarcode,
    listarProveedores,
    detalleProveedor,
    resolverLote,
    metricasVenta,
    clasificarAbc,
    lunesDe,
    vendorLabel,
    origenDesdeActivo,
    rankearMasVendidos,
    rankearActivos,
    rankearArchivados,
    ESTADOS_FINALES,
    ESTADOS_ABIERTOS,
    cruzaIngresoActivoNeggo,
};
