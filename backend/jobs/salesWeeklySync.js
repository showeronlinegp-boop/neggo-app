// Sync de ventas semanales de Odoo Neggo → product_sales_weekly.
// Agrega sale.order.line y pos.order.line por semana. Guarda hasta un año: la primera vez
// trae las 52 semanas y después rehace solo las últimas 6 (cubre cancelaciones y ventas tardías).
// Lo consumen Reposición (ritmo + ABC + qty sugerida), Vincular, Comparar compras y la tabla maestra.
// No entran anticipos ni pedidos de preventa (no son mercadería), ni las líneas del POS que
// repiten una línea de una venta (cotización derivada al POS: ya se cuenta en la sale.order).

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { lunesDe } = require('../services/reposicionService');

// Semanas que se guardan y semanas que se rehacen en cada sync
const WEEKS_HISTORIA = 52;
const WEEKS_RECIENTES = 6;
// Con menos semanas guardadas que esto, se vuelve a traer el año entero
const MIN_SEMANAS_HISTORIA = 40;
// Productos de Odoo que no son mercadería
const NO_MERCADERIA = ['Down Payment (POS)', 'Pedido Preventa'];

function fechaDesde(weeks, hoy = new Date()) {
    const d = new Date(hoy);
    d.setUTCDate(d.getUTCDate() - weeks * 7);
    // Arranca en lunes para no guardar una semana a medias
    return lunesDe(d.toISOString());
}

/**
 * Suma líneas por (producto, semana). Saltea las de productos excluidos.
 * @param {object[]} lines — líneas de Odoo con product_id y order_id
 * @param {Map<number,string>} orderDates — order_id → date_order
 * @param {string} qtyField — 'product_uom_qty' (venta) o 'qty' (POS)
 * @param {Set<number>} excluidos — product_id que no son mercadería
 * @param {Map} [agg] — acumulado al que se suman
 */
function agregarLineas(lines, orderDates, qtyField, excluidos, agg = new Map()) {
    for (const line of lines || []) {
        const productId = Array.isArray(line.product_id) ? line.product_id[0] : line.product_id;
        if (!productId || excluidos.has(productId)) continue;
        const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
        const fecha = orderDates.get(orderId);
        if (!fecha) continue;
        const week = lunesDe(fecha);
        const key = `${productId}|${week}`;
        const prev = agg.get(key) || { odoo_id: productId, week_start: week, qty: 0, amount: 0 };
        prev.qty += Number(line[qtyField]) || 0;
        prev.amount += Number(line.price_subtotal) || 0;
        agg.set(key, prev);
    }
    return agg;
}

/**
 * IDs de los productos que no son mercadería (incluye archivados).
 */
async function idsNoMercaderia() {
    const rows = await callOdoo(
        'product.product',
        'search_read',
        [[['name', 'in', NO_MERCADERIA]]],
        { fields: ['id'], context: { active_test: false } }
    );
    return new Set(rows.map(r => r.id));
}

/**
 * Lee líneas de venta confirmadas y las agrupa por (odoo_id, week_start).
 * @returns {Map<string, {odoo_id:number, week_start:string, qty:number, amount:number}>}
 */
async function leerVentasSaleOrder(companyId, desde, excluidos) {
    const orders = await callOdoo(
        'sale.order',
        'search_read',
        [[
            ['date_order', '>=', desde],
            ['state', 'in', ['sale', 'done']],
            ['company_id', '=', companyId],
        ]],
        { fields: ['id', 'date_order'] }
    );
    if (!orders.length) return new Map();

    const orderDates = new Map(orders.map(o => [o.id, o.date_order]));
    const orderIds = orders.map(o => o.id);
    const agg = new Map();

    // Batches de 200 órdenes para no saturar
    for (let i = 0; i < orderIds.length; i += 200) {
        const batch = orderIds.slice(i, i + 200);
        const lines = await callOdoo(
            'sale.order.line',
            'search_read',
            [[['order_id', 'in', batch], ['product_id', '!=', false]]],
            { fields: ['product_id', 'product_uom_qty', 'price_subtotal', 'order_id'] }
        );
        agregarLineas(lines, orderDates, 'product_uom_qty', excluidos, agg);
    }
    return agg;
}

/**
 * Suma POS (si el modelo existe en esta base Odoo), sin las líneas que vienen de una venta.
 */
async function leerVentasPos(companyId, desde, excluidos) {
    let orders;
    try {
        orders = await callOdoo(
            'pos.order',
            'search_read',
            [[
                ['date_order', '>=', desde],
                ['state', 'in', ['paid', 'done', 'invoiced']],
                ['company_id', '=', companyId],
            ]],
            { fields: ['id', 'date_order'] }
        );
    } catch (err) {
        console.warn(`⚠️ Ventas POS no disponibles: ${err.message}`);
        return new Map();
    }
    if (!orders.length) return new Map();

    const orderDates = new Map(orders.map(o => [o.id, o.date_order]));
    const agg = new Map();
    const orderIds = orders.map(o => o.id);

    for (let i = 0; i < orderIds.length; i += 200) {
        const batch = orderIds.slice(i, i + 200);
        let lines;
        try {
            lines = await callOdoo(
                'pos.order.line',
                'search_read',
                [[
                    ['order_id', 'in', batch],
                    ['product_id', '!=', false],
                    ['sale_order_line_id', '=', false],
                ]],
                { fields: ['product_id', 'qty', 'price_subtotal', 'order_id'] }
            );
        } catch (err) {
            console.warn(`⚠️ Líneas POS: ${err.message}`);
            break;
        }
        agregarLineas(lines, orderDates, 'qty', excluidos, agg);
    }
    return agg;
}

function mergeAgg(a, b) {
    const out = new Map(a);
    for (const [key, row] of b) {
        const prev = out.get(key) || { odoo_id: row.odoo_id, week_start: row.week_start, qty: 0, amount: 0 };
        prev.qty += row.qty;
        prev.amount += row.amount;
        out.set(key, prev);
    }
    return out;
}

/**
 * Reemplaza las semanas desde `desde` con lo agregado y borra lo que tiene más de un año.
 * Todo en una transacción: si algo falla, quedan las ventas que había.
 */
async function persistir(agg, desde) {
    const rows = [...agg.values()];
    const client = await pool.connect();
    let written = 0;
    try {
        await client.query('BEGIN');
        await client.query(
            `DELETE FROM product_sales_weekly WHERE company = 'neggo' AND week_start >= $1::date`,
            [desde]
        );
        for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            const values = [];
            const params = [];
            let n = 1;
            for (const r of batch) {
                values.push(`($${n++}, 'neggo', $${n++}::date, $${n++}, $${n++}, NOW())`);
                params.push(r.odoo_id, r.week_start, r.qty, r.amount);
            }
            await client.query(
                `INSERT INTO product_sales_weekly (odoo_id, company, week_start, qty_vendida, amount_total, synced_at)
                 VALUES ${values.join(',')}
                 ON CONFLICT (odoo_id, company, week_start)
                 DO UPDATE SET qty_vendida = EXCLUDED.qty_vendida,
                               amount_total = EXCLUDED.amount_total,
                               synced_at = NOW()`,
                params
            );
            written += batch.length;
        }
        await client.query(
            `DELETE FROM product_sales_weekly WHERE company = 'neggo' AND week_start < $1::date`,
            [fechaDesde(WEEKS_HISTORIA)]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return written;
}

/**
 * Cuántas semanas trae este sync: el año entero si todavía no hay historia guardada.
 * @param {number} semanasViejas — semanas guardadas anteriores a la ventana reciente
 */
function semanasATraer(semanasViejas) {
    return semanasViejas + WEEKS_RECIENTES < MIN_SEMANAS_HISTORIA ? WEEKS_HISTORIA : WEEKS_RECIENTES;
}

async function contarSemanasViejas() {
    const { rows: [row] } = await pool.query(
        `SELECT COUNT(DISTINCT week_start)::int AS semanas
         FROM product_sales_weekly
         WHERE company = 'neggo' AND week_start < $1::date`,
        [fechaDesde(WEEKS_RECIENTES)]
    );
    return row?.semanas || 0;
}

/**
 * Sync completo (on-demand / al arrancar). La app corre local: no hay cron diario.
 */
async function syncSalesWeekly() {
    await require('../services/reposicionService').ensureSchema(pool);
    const companies = await getCompanyIds();
    const companyId = companies.neggo;
    if (!companyId) throw new Error('No se pudo resolver company_id de Neggo');

    const weeks = semanasATraer(await contarSemanasViejas());
    const desde = fechaDesde(weeks);
    console.log(`📈 Sync ventas semanales (Neggo): ${weeks} semanas desde ${desde}...`);
    const excluidos = await idsNoMercaderia();
    const sale = await leerVentasSaleOrder(companyId, desde, excluidos);
    const pos = await leerVentasPos(companyId, desde, excluidos);
    const agg = mergeAgg(sale, pos);
    const written = await persistir(agg, desde);
    console.log(`✅ Ventas semanales: ${written} fila(s) (sale=${sale.size}, pos=${pos.size})`);
    return { written, saleRows: sale.size, posRows: pos.size, weeks };
}

/**
 * Si no hay datos o el último sync tiene más de maxAgeHours, vuelve a pedir a Odoo.
 * @returns {{ synced: boolean, ageHours: number|null, result?: object }}
 */
async function ensureFresh(maxAgeHours = 12) {
    await require('../services/reposicionService').ensureSchema(pool);
    const { rows: [row] } = await pool.query(
        `SELECT MAX(synced_at) AS last_sync FROM product_sales_weekly WHERE company = 'neggo'`
    );
    const last = row?.last_sync ? new Date(row.last_sync) : null;
    const ageHours = last ? (Date.now() - last.getTime()) / 3600000 : null;
    if (last && ageHours < maxAgeHours) {
        return { synced: false, ageHours, last_sync: last.toISOString() };
    }
    const result = await syncSalesWeekly();
    return { synced: true, ageHours, last_sync: new Date().toISOString(), result };
}

module.exports = {
    syncSalesWeekly,
    ensureFresh,
    leerVentasSaleOrder,
    agregarLineas,
    fechaDesde,
    semanasATraer,
    lunesDe,
};
