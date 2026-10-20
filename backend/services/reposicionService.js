// Cola de reposición de Neggo.
// Orígenes: archivado (sync / baja en el sistema), reponer (manual), recorrida (escáner).
// Neggo no lleva stock en Odoo: archivar = dar de baja el artículo. No hay origen bajo_stock.
// Solo lee Odoo vía cache. No genera OC: no usamos el módulo de compras (por ahora).

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const SCHEMA_029 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '029_reposicion.sql'), 'utf8'
);
const SCHEMA_030 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '030_reposicion_completo.sql'), 'utf8'
);

const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;
const ESTADOS_FINALES = ['repuesto', 'descartado'];
// Prioridad al actualizar un pendiente existente (mayor gana)
const ORIGEN_RANK = { archivado: 3, recorrida: 2, reponer: 1 };

/** Semanas de cobertura para qty sugerida (env o default 2). Sin stock: solo ritmo de venta. */
function semanasCobertura() {
    const n = parseFloat(process.env.REPOSICION_COBERTURA_SEMANAS);
    return Number.isFinite(n) && n > 0 ? n : 2;
}

async function ensureSchema(db = pool) {
    await db.query(SCHEMA_029);
    await db.query(SCHEMA_030);
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
 * Mete en la cola productos archivados (= baja en el sistema), salvo los de "Liquidar".
 * Si ya estaban pendientes con otro origen, suben a 'archivado'.
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

const SELECT_ITEM = `
    SELECT ri.id, ri.odoo_id, ri.origen, ri.estado, ri.qty_decidida, ri.qty_sugerida, ri.nota,
           ri.created_at, ri.resolved_at,
           COALESCE(uc.display_name, uc.username) AS created_by_name,
           COALESCE(ur.display_name, ur.username) AS resolved_by_name,
           opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.has_image,
           opc.list_price, opc.standard_price, opc.categ_name, opc.active, opc.qty_available,
           COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name
    FROM reposicion_items ri
    LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ri.odoo_id AND opc.company = ri.company
    LEFT JOIN users uc ON uc.id = ri.created_by
    LEFT JOIN users ur ON ur.id = ri.resolved_by
`;

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

/**
 * Marca un producto para reponer. origen: reponer | recorrida.
 */
async function agregarReponer(odooId, userId, nota = null, origen = 'reponer') {
    // Desde la UI solo se permite reponer (manual) o recorrida (escáner)
    if (origen !== 'reponer' && origen !== 'recorrida') {
        throw httpError('Origen inválido: usá reponer o recorrida', 400);
    }
    const origenFinal = origen;

    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se repone`, 400);

    // Si ya hay pendiente, no duplicar; si el nuevo origen es más fuerte, actualizar
    const { rows: [existente] } = await pool.query(
        `SELECT id, origen FROM reposicion_items
         WHERE company = 'neggo' AND estado = 'pendiente' AND odoo_id = $1`,
        [odooId]
    );
    if (existente) {
        if ((ORIGEN_RANK[origenFinal] || 0) > (ORIGEN_RANK[existente.origen] || 0)) {
            await pool.query(
                `UPDATE reposicion_items SET origen = $2, nota = COALESCE($3, nota) WHERE id = $1`,
                [existente.id, origenFinal, nota || null]
            );
        }
        const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [existente.id]);
        if ((ORIGEN_RANK[origenFinal] || 0) <= (ORIGEN_RANK[existente.origen] || 0)) {
            throw httpError(`"${prod.name}" ya está en la cola de reposición`, 409);
        }
        return item;
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
        if (err.code === '23505') throw httpError('Ese producto ya tiene otro pendiente en la cola', 409);
        throw err;
    }
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [id]);
    return item;
}

async function buscarProductos(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.list_price,
                opc.qty_available,
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

/** Busca un producto activo de Neggo por código de barras exacto (recorrida). */
async function buscarPorBarcode(barcode) {
    const code = String(barcode || '').trim();
    if (!code) return null;
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
                opc.list_price, opc.standard_price, opc.qty_available,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                EXISTS (SELECT 1 FROM reposicion_items ri
                        WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
                          AND ri.estado = 'pendiente') AS en_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.barcode = $1
         LIMIT 1`,
        [code]
    );
    return rows[0] || null;
}

/**
 * Lunes ISO (UTC date string YYYY-MM-DD) de una fecha.
 */
function lunesDe(fecha) {
    const d = new Date(fecha);
    const day = d.getUTCDay(); // 0=dom
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
}

/**
 * Métricas de venta por odoo_id a partir de product_sales_weekly.
 * qty_7d = semana actual (parcial) + fracción; usamos suma de la semana más reciente
 * y promedio de las últimas 4 semanas completas como ritmo.
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
        // Semáforo: ritmo reciente vs promedio (unidades)
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
 * A ≈ 80% acumulado de unidades, B ≈ 15%, C resto.
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

/**
 * Detalle de un proveedor: pendientes + métricas de venta + sugerencias.
 */
async function detalleProveedor(vendorName) {
    const nombre = String(vendorName || '').trim();
    if (!nombre) throw httpError('Proveedor requerido', 400);

    const { rows: items } = await pool.query(
        `${SELECT_ITEM}
         WHERE ri.estado = 'pendiente'
           AND COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') = $1
         ORDER BY ri.created_at`,
        [nombre]
    );

    // Ventas on-demand: no hay cron diario (la app corre local)
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
        // Sin stock en Odoo: sugerencia = ritmo semanal × semanas de cobertura
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
        vendor_name: nombre,
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
 * Resuelve en lote pendientes como repuesto/descartado (con qty opcional).
 * No escribe en Odoo: Neggo no usa el módulo de compras por ahora.
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
    cambiarEstado,
    buscarProductos,
    buscarPorBarcode,
    detalleProveedor,
    resolverLote,
    metricasVenta,
    clasificarAbc,
    lunesDe,
};
