// Sync de ventas semanales de Odoo Neggo → product_sales_weekly.
// Agrega sale.order.line (y pos.order.line si existe) de las últimas ~5 semanas.
// Lo consume el modal de reposición (ritmo de venta + ABC + qty sugerida).

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { lunesDe } = require('../services/reposicionService');

const WEEKS_BACK = 5;

function fechaDesde() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - WEEKS_BACK * 7);
    return d.toISOString().slice(0, 10);
}

/**
 * Lee líneas de venta confirmadas y las agrupa por (odoo_id, week_start).
 * @returns {Map<string, {odoo_id:number, week_start:string, qty:number, amount:number}>}
 */
async function leerVentasSaleOrder(companyId) {
    const desde = fechaDesde();
    const orders = await callOdoo(
        'sale.order',
        'search_read',
        [[
            ['date_order', '>=', desde],
            ['state', 'in', ['sale', 'done']],
            ['company_id', '=', companyId],
        ]],
        { fields: ['id', 'date_order'], limit: 5000 }
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
            {
                fields: ['product_id', 'product_uom_qty', 'price_subtotal', 'order_id'],
                limit: 10000,
            }
        );
        for (const line of lines) {
            const productId = Array.isArray(line.product_id) ? line.product_id[0] : line.product_id;
            if (!productId) continue;
            const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
            const fecha = orderDates.get(orderId);
            if (!fecha) continue;
            const week = lunesDe(fecha);
            const key = `${productId}|${week}`;
            const prev = agg.get(key) || { odoo_id: productId, week_start: week, qty: 0, amount: 0 };
            prev.qty += Number(line.product_uom_qty) || 0;
            prev.amount += Number(line.price_subtotal) || 0;
            agg.set(key, prev);
        }
    }
    return agg;
}

/**
 * Intenta sumar POS (si el modelo existe en esta base Odoo).
 */
async function leerVentasPos(companyId) {
    const desde = fechaDesde();
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
            { fields: ['id', 'date_order'], limit: 5000 }
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
                [[['order_id', 'in', batch], ['product_id', '!=', false]]],
                {
                    fields: ['product_id', 'qty', 'price_subtotal', 'order_id'],
                    limit: 10000,
                }
            );
        } catch (err) {
            console.warn(`⚠️ Líneas POS: ${err.message}`);
            break;
        }
        for (const line of lines) {
            const productId = Array.isArray(line.product_id) ? line.product_id[0] : line.product_id;
            if (!productId) continue;
            const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
            const fecha = orderDates.get(orderId);
            if (!fecha) continue;
            const week = lunesDe(fecha);
            const key = `${productId}|${week}`;
            const prev = agg.get(key) || { odoo_id: productId, week_start: week, qty: 0, amount: 0 };
            prev.qty += Number(line.qty) || 0;
            prev.amount += Number(line.price_subtotal) || 0;
            agg.set(key, prev);
        }
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
 * Upsert de las filas agregadas. Borra semanas fuera de la ventana para no crecer infinito.
 */
async function persistir(agg) {
    const rows = [...agg.values()];
    if (!rows.length) return 0;

    // Upsert en batches
    let written = 0;
    for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const values = [];
        const params = [];
        let n = 1;
        for (const r of batch) {
            values.push(`($${n++}, 'neggo', $${n++}::date, $${n++}, $${n++}, NOW())`);
            params.push(r.odoo_id, r.week_start, r.qty, r.amount);
        }
        await pool.query(
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

    await pool.query(
        `DELETE FROM product_sales_weekly
         WHERE company = 'neggo' AND week_start < (CURRENT_DATE - INTERVAL '42 days')`
    );
    return written;
}

/**
 * Sync completo (on-demand / al arrancar). La app corre local: no hay cron diario.
 */
async function syncSalesWeekly() {
    await require('../services/reposicionService').ensureSchema(pool);
    const companies = await getCompanyIds();
    const companyId = companies.neggo;
    if (!companyId) throw new Error('No se pudo resolver company_id de Neggo');

    console.log('📈 Sync ventas semanales (Neggo)...');
    const sale = await leerVentasSaleOrder(companyId);
    const pos = await leerVentasPos(companyId);
    const agg = mergeAgg(sale, pos);
    const written = await persistir(agg);
    console.log(`✅ Ventas semanales: ${written} fila(s) (sale=${sale.size}, pos=${pos.size})`);
    return { written, saleRows: sale.size, posRows: pos.size };
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

module.exports = { syncSalesWeekly, ensureFresh, leerVentasSaleOrder, lunesDe };
