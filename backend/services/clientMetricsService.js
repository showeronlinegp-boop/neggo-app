// CRM de clientes, fase 1: métricas por cliente desde Odoo → client_metrics_cache.
// Compra = ticket del POS de Neggo (decisión D2). Las cotizaciones abiertas de Neggo
// y Preventas se muestran como seguimiento de pedidos (D1). Ver docs/plan-crm-clientes.md.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const health = require('./clientHealth');

const COMPANY = 'neggo';
const PAGE = 2000;
const LINE_BATCH = 300;
const POS_STATES = ['paid', 'done', 'invoiced'];
// No es un cliente: queda afuera de todo (D4)
const EXCLUDED_NAMES = ['rma'];
// Cuenta genérica: suma en la facturación total pero no aparece en listados ni en el funnel (D4)
const GENERIC_NAMES = ['consumidor final'];

const SCHEMA_042 = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '042_clientes_crm.sql'), 'utf8');

let schemaReady = null;
let syncInFlight = null;

function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA_042).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

function m2oId(value) {
    return Array.isArray(value) ? value[0] : value || null;
}

function m2oName(value) {
    return Array.isArray(value) ? value[1] : null;
}

function normName(name) {
    return String(name || '').trim().toLowerCase();
}

async function readAll(model, domain, fields, context) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
        const rows = await callOdoo(model, 'search_read', [domain], {
            fields, limit: PAGE, offset, order: 'id asc', context,
        });
        out.push(...rows);
        if (rows.length < PAGE) break;
    }
    return out;
}

// Solo productos físicos (type consu): señas, saldos y envíos son servicios y no van al ranking
// de lo que más compra. El importe del ticket sí los incluye: es lo que pagó.
async function readPosLines(orderIds, context) {
    const lines = [];
    for (let i = 0; i < orderIds.length; i += LINE_BATCH) {
        const batch = orderIds.slice(i, i + LINE_BATCH);
        const rows = await callOdoo('pos.order.line', 'search_read',
            [[['order_id', 'in', batch], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl'], context });
        lines.push(...rows);
    }
    return lines;
}

/**
 * Cotizaciones abiertas (borrador o enviada) de las dos empresas, agrupadas por cliente.
 * Las que ya tienen factura o se cobraron en el POS no cuentan como abiertas.
 */
async function readOpenQuotations(companies) {
    const byPartner = new Map();
    for (const [key, companyId] of Object.entries(companies)) {
        if (!companyId) continue;
        const context = { allowed_company_ids: [companyId] };
        let rows;
        try {
            rows = await readAll('sale.order',
                [['company_id', '=', companyId], ['state', 'in', ['draft', 'sent']]],
                ['id', 'name', 'partner_id', 'state', 'date_order', 'amount_total', 'invoice_count', 'pos_order_count'],
                context);
        } catch (err) {
            console.warn(`⚠️ CRM: no pude leer cotizaciones abiertas de ${key}: ${err.message}`);
            continue;
        }
        for (const o of rows) {
            if ((o.invoice_count || 0) > 0 || (o.pos_order_count || 0) > 0) continue;
            const pid = m2oId(o.partner_id);
            if (!pid) continue;
            const list = byPartner.get(pid) || [];
            list.push({
                company: key,
                odoo_id: o.id,
                name: o.name,
                state: o.state,
                date: health.toArDate(o.date_order),
                amount: Number(o.amount_total) || 0,
            });
            byPartner.set(pid, list);
        }
    }
    for (const list of byPartner.values()) list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return byPartner;
}

async function readPartners(ids) {
    const out = new Map();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 500) {
        const rows = await callOdoo('res.partner', 'read', [list.slice(i, i + 500)], {
            fields: ['id', 'name', 'phone', 'city', 'category_id'],
            context: { active_test: false },
        });
        for (const r of rows) out.set(r.id, r);
    }
    const tagIds = [...new Set([...out.values()].flatMap((p) => p.category_id || []))];
    const tagNames = new Map();
    if (tagIds.length) {
        const tags = await callOdoo('res.partner.category', 'read', [tagIds], { fields: ['id', 'name'] });
        for (const t of tags) tagNames.set(t.id, t.name);
    }
    for (const p of out.values()) p.tags = (p.category_id || []).map((id) => tagNames.get(id)).filter(Boolean);
    return out;
}

/**
 * Arma las filas de métricas a partir de lo leído de Odoo. Sin I/O: se testea aparte.
 * @param {{ orders: object[], lines: object[], quotations: Map, partners: Map, today: string }} input
 */
function buildRows({ orders, lines, quotations, partners, today }) {
    const since12m = health.addDays(today, -365);
    const purchasesByPartner = new Map();
    const orderInfo = new Map();
    for (const o of orders) {
        const pid = m2oId(o.partner_id);
        if (!pid) continue;
        const date = health.toArDate(o.date_order);
        if (!date) continue;
        orderInfo.set(o.id, { pid, date });
        const list = purchasesByPartner.get(pid) || [];
        list.push({ date, amount: Number(o.amount_total) || 0 });
        purchasesByPartner.set(pid, list);
    }

    const linesByPartner = new Map();
    for (const l of lines) {
        const info = orderInfo.get(m2oId(l.order_id));
        if (!info || info.date <= since12m) continue;
        const list = linesByPartner.get(info.pid) || [];
        list.push({
            product_id: m2oId(l.product_id),
            name: m2oName(l.product_id),
            qty: l.qty,
            amount: l.price_subtotal_incl,
            date: info.date,
        });
        linesByPartner.set(info.pid, list);
    }

    const rows = [];
    const ids = new Set([...purchasesByPartner.keys(), ...quotations.keys()]);
    for (const pid of ids) {
        const partner = partners.get(pid) || {};
        const name = partner.name || `Cliente ${pid}`;
        if (EXCLUDED_NAMES.includes(normName(name))) continue;
        const metrics = health.buildMetrics(purchasesByPartner.get(pid) || [], today);
        rows.push({
            odoo_partner_id: pid,
            partner_name: name,
            phone: partner.phone || null,
            city: partner.city ? String(partner.city).trim() : null,
            tags: partner.tags || [],
            is_generic: GENERIC_NAMES.includes(normName(name)),
            ...metrics,
            top_products: health.topProducts(linesByPartner.get(pid) || []),
            open_quotations: quotations.get(pid) || [],
        });
    }
    return rows;
}

const COLUMNS = [
    'odoo_partner_id', 'partner_name', 'phone', 'city', 'tags', 'is_generic',
    'total_revenue', 'avg_ticket', 'purchase_count', 'first_purchase_date', 'last_purchase_date',
    'days_since_last_purchase', 'median_interval_days', 'interval_is_default',
    'revenue_90d', 'revenue_prev_90d', 'revenue_12m', 'health', 'trend', 'trend_pct', 'priority',
    'monthly_revenue', 'top_products', 'open_quotations',
];
const JSON_COLUMNS = new Set(['tags', 'monthly_revenue', 'top_products', 'open_quotations']);

async function persist(rows) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM client_metrics_cache WHERE company = $1', [COMPANY]);
        for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            const params = [];
            const values = batch.map((r) => {
                const ph = [`'${COMPANY}'`, 'NOW()'];
                for (const col of COLUMNS) {
                    params.push(JSON_COLUMNS.has(col) ? JSON.stringify(r[col] ?? []) : r[col] ?? null);
                    ph.push(`$${params.length}`);
                }
                return `(${ph.join(', ')})`;
            });
            await client.query(
                `INSERT INTO client_metrics_cache (company, synced_at, ${COLUMNS.join(', ')})
                 VALUES ${values.join(', ')}`,
                params
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function runSync() {
    await ensureSchema();
    const started = Date.now();
    const companies = await getCompanyIds();
    const neggoId = companies.neggo;
    if (!neggoId) throw new Error('No se pudo resolver company_id de Neggo');
    const context = { allowed_company_ids: [neggoId] };

    console.log('📦 CRM: leyendo tickets del POS de Neggo...');
    const orders = await readAll('pos.order',
        [['company_id', '=', neggoId], ['state', 'in', POS_STATES]],
        ['id', 'partner_id', 'date_order', 'amount_total'],
        context);
    const today = health.toArDate(new Date());
    const since12m = health.addDays(today, -365);
    const recentIds = orders.filter((o) => (health.toArDate(o.date_order) || '') > since12m).map((o) => o.id);
    const lines = await readPosLines(recentIds, context);
    const quotations = await readOpenQuotations(companies);

    const partnerIds = new Set([
        ...orders.map((o) => m2oId(o.partner_id)).filter(Boolean),
        ...quotations.keys(),
    ]);
    const partners = await readPartners(partnerIds);
    const rows = buildRows({ orders, lines, quotations, partners, today });
    await persist(rows);

    const seconds = Math.round((Date.now() - started) / 100) / 10;
    console.log(`✅ CRM: ${rows.length} cliente(s) actualizados (${orders.length} tickets, ${lines.length} líneas) en ${seconds} s`);
    return { clientes: rows.length, tickets: orders.length, lineas: lines.length, segundos: seconds };
}

/** Sync completo. Si ya hay uno corriendo, devuelve ese mismo. */
function syncClientMetrics() {
    if (!syncInFlight) {
        syncInFlight = runSync().finally(() => { syncInFlight = null; });
    }
    return syncInFlight;
}

function isSyncing() {
    return Boolean(syncInFlight);
}

async function lastSyncedAt() {
    await ensureSchema();
    const { rows: [row] } = await pool.query(
        'SELECT MAX(synced_at) AS last_sync FROM client_metrics_cache WHERE company = $1', [COMPANY]);
    return row?.last_sync || null;
}

/**
 * Si los datos tienen más de maxAgeHours (o no hay), dispara el sync en segundo plano.
 * No espera: la pantalla muestra lo que hay y avisa que se está actualizando.
 */
async function refreshIfStale(maxAgeHours = 6) {
    const last = await lastSyncedAt();
    const age = last ? (Date.now() - new Date(last).getTime()) / 3600000 : null;
    if (last && age < maxAgeHours) return false;
    syncClientMetrics().catch((err) => console.error('❌ CRM: error en el sync:', err.message));
    return true;
}

const HEALTH_VALUES = Object.values(health.HEALTH);
const SORTS = {
    prioridad: 'priority DESC, revenue_12m DESC',
    facturacion: 'revenue_12m DESC, partner_name ASC',
    ultima: 'last_purchase_date DESC NULLS LAST, partner_name ASC',
    nombre: 'partner_name ASC',
};

/**
 * Listado de clientes (sin la cuenta genérica).
 * @param {{ search?: string, city?: string, health?: string, open?: boolean, sort?: string, limit?: number, offset?: number }} f
 */
async function listClients(f = {}) {
    await ensureSchema();
    const where = ['company = $1', 'is_generic = false'];
    const params = [COMPANY];
    const search = String(f.search || '').trim();
    if (search) {
        params.push(`%${search}%`);
        const digits = search.replace(/\D/g, '');
        if (digits.length >= 4) {
            params.push(`%${digits}%`);
            where.push(`(partner_name ILIKE $${params.length - 1} OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE $${params.length})`);
        } else {
            where.push(`partner_name ILIKE $${params.length}`);
        }
    }
    if (f.city) {
        params.push(String(f.city).trim());
        where.push(`LOWER(TRIM(city)) = LOWER($${params.length})`);
    }
    if (f.health && HEALTH_VALUES.includes(f.health)) {
        params.push(f.health);
        where.push(`health = $${params.length}`);
    }
    if (f.open) where.push(`jsonb_array_length(open_quotations) > 0`);

    const order = SORTS[f.sort] || SORTS.prioridad;
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);

    const whereSql = where.join(' AND ');
    const { rows: [count] } = await pool.query(`SELECT COUNT(*) AS total FROM client_metrics_cache WHERE ${whereSql}`, params);
    const { rows } = await pool.query(
        `SELECT odoo_partner_id, partner_name, phone, city, tags, health, trend, trend_pct,
                purchase_count, avg_ticket, revenue_12m, revenue_90d, last_purchase_date,
                days_since_last_purchase, median_interval_days, interval_is_default,
                monthly_revenue, open_quotations, priority
         FROM client_metrics_cache
         WHERE ${whereSql}
         ORDER BY ${order}
         LIMIT ${limit} OFFSET ${offset}`,
        params
    );
    return { rows, total: parseInt(count.total, 10), limit, offset };
}

/** Contadores de la pantalla: por estado, ganados del mes, facturación y ciudades. */
async function summary() {
    await ensureSchema();
    const { rows: byHealth } = await pool.query(
        `SELECT health, COUNT(*)::int AS n FROM client_metrics_cache
         WHERE company = $1 AND is_generic = false GROUP BY health`, [COMPANY]);
    const { rows: [totals] } = await pool.query(
        `SELECT COALESCE(SUM(revenue_90d), 0) AS revenue_90d,
                COALESCE(SUM(revenue_prev_90d), 0) AS revenue_prev_90d,
                COALESCE(SUM(revenue_12m), 0) AS revenue_12m,
                COALESCE(SUM(revenue_90d) FILTER (WHERE is_generic), 0) AS revenue_90d_generic,
                COUNT(*) FILTER (WHERE NOT is_generic AND date_trunc('month', first_purchase_date) = date_trunc('month', CURRENT_DATE))::int AS nuevos_mes,
                COUNT(*) FILTER (WHERE NOT is_generic AND jsonb_array_length(open_quotations) > 0)::int AS con_cotizacion,
                MAX(synced_at) AS synced_at
         FROM client_metrics_cache WHERE company = $1`, [COMPANY]);
    const { rows: cities } = await pool.query(
        `SELECT MIN(TRIM(city)) AS city, COUNT(*)::int AS n FROM client_metrics_cache
         WHERE company = $1 AND is_generic = false AND NULLIF(TRIM(city), '') IS NOT NULL
         GROUP BY LOWER(TRIM(city)) ORDER BY n DESC, city ASC`, [COMPANY]);
    const counts = Object.fromEntries(HEALTH_VALUES.map((h) => [h, 0]));
    for (const r of byHealth) if (r.health) counts[r.health] = r.n;
    return {
        health: counts,
        total_clientes: byHealth.reduce((s, r) => s + r.n, 0),
        nuevos_mes: totals.nuevos_mes,
        con_cotizacion: totals.con_cotizacion,
        revenue_90d: Number(totals.revenue_90d),
        revenue_prev_90d: Number(totals.revenue_prev_90d),
        revenue_12m: Number(totals.revenue_12m),
        revenue_90d_generic: Number(totals.revenue_90d_generic),
        cities,
        synced_at: totals.synced_at,
        syncing: isSyncing(),
    };
}

/** Últimos tickets del cliente, leídos en vivo de Odoo. */
async function recentPurchases(partnerId, limit = 15) {
    const companies = await getCompanyIds();
    const context = { allowed_company_ids: [companies.neggo] };
    const orders = await callOdoo('pos.order', 'search_read',
        [[['company_id', '=', companies.neggo], ['partner_id', '=', partnerId], ['state', 'in', POS_STATES]]],
        { fields: ['id', 'name', 'pos_reference', 'date_order', 'amount_total', 'lines'], order: 'date_order desc', limit, context });
    return orders.map((o) => ({
        odoo_id: o.id,
        name: o.pos_reference || o.name,
        date: health.toArDate(o.date_order),
        amount: Number(o.amount_total) || 0,
        items: (o.lines || []).length,
    }));
}

/** Ficha del cliente: métricas guardadas + últimos tickets en vivo. */
async function getClient(partnerId) {
    await ensureSchema();
    const { rows: [row] } = await pool.query(
        'SELECT * FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = $2', [COMPANY, partnerId]);
    if (!row) return null;
    let purchases = [];
    let purchasesError = null;
    try {
        purchases = await recentPurchases(partnerId);
    } catch (err) {
        purchasesError = 'No pude leer los últimos tickets de Odoo';
        console.warn(`⚠️ CRM: tickets de ${partnerId}: ${err.message}`);
    }
    return { ...row, recent_purchases: purchases, recent_purchases_error: purchasesError };
}

module.exports = {
    ensureSchema,
    buildRows,
    syncClientMetrics,
    isSyncing,
    lastSyncedAt,
    refreshIfStale,
    listClients,
    summary,
    getClient,
    EXCLUDED_NAMES,
    GENERIC_NAMES,
};
