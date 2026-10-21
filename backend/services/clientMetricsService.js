// CRM de clientes, fase 1: métricas por cliente desde Odoo → client_metrics_cache.
// Compra = ticket del POS de Neggo (decisión D2). Las cotizaciones abiertas de Neggo
// y Preventas de los últimos 60 días se muestran como motivo para hablarle (D1, D19).
// Ver docs/plan-crm-clientes.md.

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const health = require('./clientHealth');
const { ensureSchema } = require('./crmSchema');
const followups = require('./crmFollowupService');
const duplicates = require('./clientDuplicates');

const COMPANY = 'neggo';
const PAGE = 2000;
const LINE_BATCH = 300;
const POS_STATES = ['paid', 'done', 'invoiced'];
// No es un cliente: queda afuera de todo (D4)
const EXCLUDED_NAMES = ['rma'];
// Cuenta genérica: suma en la facturación total pero no aparece en listados ni en el funnel (D4)
const GENERIC_NAMES = ['consumidor final'];

let syncInFlight = null;

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
// Un ticket que cobra un pedido de venta (anticipo o saldo) no trae los productos: se toman
// del pedido, una sola vez aunque se haya pagado en varios tickets, con el primero de ellos.
async function readPosLines(orderIds, context) {
    const lines = [];
    const firstTicketBySale = new Map();
    for (let i = 0; i < orderIds.length; i += LINE_BATCH) {
        const batch = orderIds.slice(i, i + LINE_BATCH);
        const rows = await callOdoo('pos.order.line', 'search_read',
            [[['order_id', 'in', batch], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl'], context });
        lines.push(...rows);
        const settled = await callOdoo('pos.order.line', 'search_read',
            [[['order_id', 'in', batch], ['sale_order_origin_id', '!=', false]]],
            { fields: ['order_id', 'sale_order_origin_id'], context });
        for (const l of settled) {
            const saleId = m2oId(l.sale_order_origin_id);
            const posId = m2oId(l.order_id);
            if (!firstTicketBySale.has(saleId) || posId < firstTicketBySale.get(saleId)) firstTicketBySale.set(saleId, posId);
        }
    }

    const saleIds = [...firstTicketBySale.keys()];
    for (let i = 0; i < saleIds.length; i += LINE_BATCH) {
        const rows = await callOdoo('sale.order.line', 'search_read',
            [[['order_id', 'in', saleIds.slice(i, i + LINE_BATCH)], ['display_type', '=', false], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_total'], context });
        for (const r of rows) {
            lines.push({
                order_id: [firstTicketBySale.get(m2oId(r.order_id)), null],
                product_id: r.product_id,
                qty: r.product_uom_qty,
                price_subtotal_incl: r.price_total,
            });
        }
    }
    return lines;
}

/** Categoría de producto (rubro) de cada producto que aparece en las líneas. */
async function readProductCategories(productIds, context) {
    const out = new Map();
    const list = [...productIds];
    for (let i = 0; i < list.length; i += 500) {
        const rows = await callOdoo('product.product', 'read', [list.slice(i, i + 500)], {
            fields: ['id', 'categ_id'],
            context: { ...context, active_test: false },
        });
        for (const r of rows) out.set(r.id, m2oName(r.categ_id));
    }
    return out;
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
            fields: ['id', 'name', 'phone', 'email', 'vat', 'city', 'category_id', 'commercial_partner_id'],
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
 * Junta las fichas duplicadas de Odoo (ver clientDuplicates.js): los tickets y cotizaciones de
 * cada una pasan a la ficha que representa al grupo. Sin I/O: se testea aparte.
 * @returns {{ orders: object[], quotations: Map, partners: Map, groups: Map<number, number[]> }}
 */
function mergeDuplicates({ orders, quotations, partners }) {
    const { repOf, groups } = duplicates.groupDuplicates(partners, {
        skipNames: [...EXCLUDED_NAMES, ...GENERIC_NAMES],
    });
    if (!groups.size) return { orders, quotations, partners, groups };
    const rep = (id) => repOf.get(id) || id;

    const tickets = new Map();
    for (const o of orders) {
        const pid = m2oId(o.partner_id);
        if (pid) tickets.set(pid, (tickets.get(pid) || 0) + 1);
    }
    const mergedPartners = new Map(partners);
    for (const [repId, ids] of groups) {
        mergedPartners.set(repId, duplicates.mergedPartner(repId, ids.map((id) => partners.get(id)), tickets));
    }

    const mergedOrders = orders.map((o) => {
        const pid = m2oId(o.partner_id);
        return pid && rep(pid) !== pid ? { ...o, partner_id: [rep(pid), m2oName(o.partner_id)] } : o;
    });
    const mergedQuotes = new Map();
    for (const [pid, list] of quotations) {
        const key = rep(pid);
        mergedQuotes.set(key, [...(mergedQuotes.get(key) || []), ...list]);
    }
    for (const list of mergedQuotes.values()) list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { orders: mergedOrders, quotations: mergedQuotes, partners: mergedPartners, groups };
}

/**
 * El seguimiento (etapa, eventos, acciones, seguimiento cercano) y los posibles clientes vinculados a una ficha
 * que quedó unificada pasan al representante del grupo. Si los dos tenían etapa, queda la
 * del representante.
 */
async function moveFollowupsToRep(groups) {
    const moves = [];
    for (const [rep, ids] of groups) for (const id of ids) if (id !== rep) moves.push([id, rep]);
    if (!moves.length) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // La lista de seguimiento cercano (nota #74) puede no estar todavía
        const { rows: [{ watchlist }] } = await client.query(
            "SELECT to_regclass('crm_watchlist') IS NOT NULL AS watchlist");
        for (const [from, to] of moves) {
            if (watchlist) {
                await client.query(
                    `UPDATE crm_watchlist SET odoo_partner_id = $2
                     WHERE odoo_partner_id = $1 AND NOT EXISTS (SELECT 1 FROM crm_watchlist WHERE odoo_partner_id = $2)`,
                    [from, to]);
            }
            await client.query('UPDATE crm_events SET odoo_partner_id = $2 WHERE odoo_partner_id = $1', [from, to]);
            await client.query('UPDATE crm_actions SET odoo_partner_id = $2 WHERE odoo_partner_id = $1', [from, to]);
            await client.query('UPDATE crm_leads SET odoo_partner_id = $2 WHERE odoo_partner_id = $1', [from, to]);
            await client.query(
                `UPDATE crm_followups SET odoo_partner_id = $2
                 WHERE odoo_partner_id = $1 AND NOT EXISTS (SELECT 1 FROM crm_followups WHERE odoo_partner_id = $2)`,
                [from, to]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Arma las filas de métricas a partir de lo leído de Odoo. Sin I/O: se testea aparte.
 * @param {{ orders: object[], lines: object[], quotations: Map, partners: Map, categories?: Map, today: string }} input
 */
function buildRows({ orders, lines, quotations, partners, categories = new Map(), today }) {
    const since12m = health.addDays(today, -365);
    // Solo las cotizaciones recientes: sirven de excusa para hablarle, las viejas no (D19)
    const sinceQuotes = health.addDays(today, -health.QUOTATION_DAYS);
    const recentQuotes = new Map();
    for (const [pid, list] of quotations) {
        const recent = list.filter((q) => q.date && q.date >= sinceQuotes);
        if (recent.length) recentQuotes.set(pid, recent);
    }
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

    const rubros = health.rubroLabels(categories.values());
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
            category: rubros.get(categories.get(m2oId(l.product_id))) || null,
        });
        linesByPartner.set(info.pid, list);
    }

    const rows = [];
    const ids = new Set([...purchasesByPartner.keys(), ...recentQuotes.keys()]);
    for (const pid of ids) {
        const partner = partners.get(pid) || {};
        const name = partner.name || `Cliente ${pid}`;
        if (EXCLUDED_NAMES.includes(normName(name))) continue;
        const metrics = health.buildMetrics(purchasesByPartner.get(pid) || [], today);
        const partnerLines = linesByPartner.get(pid) || [];
        rows.push({
            odoo_partner_id: pid,
            partner_name: name,
            phone: partner.phone || null,
            city: partner.city ? String(partner.city).trim() : null,
            tags: partner.tags || [],
            is_generic: GENERIC_NAMES.includes(normName(name)),
            ...metrics,
            rubro: health.topRubro(partnerLines),
            top_products: health.topProducts(partnerLines),
            open_quotations: recentQuotes.get(pid) || [],
            merged_partners: partner.merged || [],
        });
    }
    return rows;
}

const COLUMNS = [
    'odoo_partner_id', 'partner_name', 'phone', 'city', 'tags', 'is_generic', 'rubro',
    'total_revenue', 'avg_ticket', 'purchase_count', 'first_purchase_date', 'last_purchase_date',
    'days_since_last_purchase', 'median_interval_days', 'interval_is_default',
    'revenue_90d', 'revenue_prev_90d', 'revenue_12m', 'health', 'trend', 'trend_pct', 'priority',
    'monthly_revenue', 'top_products', 'open_quotations', 'merged_partners',
];
const JSON_COLUMNS = new Set(['tags', 'monthly_revenue', 'top_products', 'open_quotations', 'merged_partners']);

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
    const categories = await readProductCategories(new Set(lines.map((l) => m2oId(l.product_id)).filter(Boolean)), context);

    const partnerIds = new Set([
        ...orders.map((o) => m2oId(o.partner_id)).filter(Boolean),
        ...quotations.keys(),
    ]);
    const partners = await readPartners(partnerIds);
    // Los contactos hijos suman a su cliente principal: hay que tenerlo aunque no haya comprado
    const mainIds = new Set([...partners.values()]
        .map((p) => m2oId(p.commercial_partner_id)).filter((id) => id && !partners.has(id)));
    for (const [id, p] of await readPartners(mainIds)) partners.set(id, p);
    const merged = mergeDuplicates({ orders, quotations, partners });
    const rows = buildRows({ ...merged, lines, categories, today });
    await persist(rows);
    await moveFollowupsToRep(merged.groups);
    // Vincula posibles clientes que aparecieron en Odoo y marca los ganados
    await followups.afterSync().catch((err) => console.error('❌ CRM: error después del sync:', err.message));

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
 * Se calcula una vez por día (D16): al arrancar el servidor y, si quedó prendido, a las 24 h.
 */
async function refreshIfStale(maxAgeHours = 24) {
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
    accion: 'next_action_date ASC NULLS LAST, priority DESC',
};
const STAGE_VALUES = followups.STAGES;
// Cliente + etapa del funnel (sin fila = Frío) + fecha de la próxima acción pendiente
const CLIENTS_FROM = `(
    SELECT c.*, COALESCE(f.stage, 'frio') AS stage,
           (SELECT MIN(a.due_date)::text FROM crm_actions a
            WHERE a.odoo_partner_id = c.odoo_partner_id AND a.done = false) AS next_action_date
    FROM client_metrics_cache c
    LEFT JOIN crm_followups f ON f.odoo_partner_id = c.odoo_partner_id
) x`;

/**
 * Listado de clientes (sin la cuenta genérica).
 * @param {{ search?: string, city?: string, rubro?: string, health?: string, stage?: string, open?: boolean, sort?: string, limit?: number, offset?: number }} f
 */
async function listClients(f = {}) {
    await ensureSchema();
    const where = ['company = $1', 'is_generic = false'];
    const params = [COMPANY];
    const search = String(f.search || '').trim();
    if (search) {
        params.push(`%${search}%`);
        // También por el nombre de cualquiera de sus fichas unificadas
        const byName = (n) => `(partner_name ILIKE $${n} OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(merged_partners) m WHERE m->>'name' ILIKE $${n}))`;
        const digits = search.replace(/\D/g, '');
        if (digits.length >= 4) {
            params.push(`%${digits}%`);
            where.push(`(${byName(params.length - 1)} OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE $${params.length})`);
        } else {
            where.push(byName(params.length));
        }
    }
    if (f.city) {
        params.push(String(f.city).trim());
        where.push(`LOWER(TRIM(city)) = LOWER($${params.length})`);
    }
    if (f.rubro) {
        params.push(String(f.rubro).trim());
        where.push(`rubro = $${params.length}`);
    }
    if (f.health && HEALTH_VALUES.includes(f.health)) {
        params.push(f.health);
        where.push(`health = $${params.length}`);
    }
    if (f.stage && STAGE_VALUES.includes(f.stage)) {
        params.push(f.stage);
        where.push(`stage = $${params.length}`);
    }
    if (f.open) where.push(`jsonb_array_length(open_quotations) > 0`);

    const order = SORTS[f.sort] || SORTS.prioridad;
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);

    const whereSql = where.join(' AND ');
    const { rows: [count] } = await pool.query(`SELECT COUNT(*) AS total FROM ${CLIENTS_FROM} WHERE ${whereSql}`, params);
    const { rows } = await pool.query(
        `SELECT odoo_partner_id, partner_name, phone, city, tags, rubro, health, trend, trend_pct,
                purchase_count, avg_ticket, revenue_12m, revenue_90d, last_purchase_date,
                days_since_last_purchase, median_interval_days, interval_is_default,
                monthly_revenue, open_quotations, priority, stage, next_action_date
         FROM ${CLIENTS_FROM}
         WHERE ${whereSql}
         ORDER BY ${order}
         LIMIT ${limit} OFFSET ${offset}`,
        params
    );
    return { rows, total: parseInt(count.total, 10), limit, offset };
}

/** Contadores de la pantalla: por estado, ganados del mes, facturación, ciudades y rubros. */
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
    const { rows: rubros } = await pool.query(
        `SELECT rubro, COUNT(*)::int AS n FROM client_metrics_cache
         WHERE company = $1 AND is_generic = false AND rubro IS NOT NULL
         GROUP BY rubro ORDER BY n DESC, rubro ASC`, [COMPANY]);
    const { rows: byStage } = await pool.query(
        `SELECT COALESCE(f.stage, 'frio') AS stage, COUNT(*)::int AS n
         FROM client_metrics_cache c LEFT JOIN crm_followups f ON f.odoo_partner_id = c.odoo_partner_id
         WHERE c.company = $1 AND c.is_generic = false GROUP BY 1`, [COMPANY]);
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
        rubros,
        stages: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
        synced_at: totals.synced_at,
        syncing: isSyncing(),
    };
}

/** Últimos tickets del cliente (de todas sus fichas unificadas), leídos en vivo de Odoo. */
async function recentPurchases(partnerIds, limit = 15) {
    const companies = await getCompanyIds();
    const context = { allowed_company_ids: [companies.neggo] };
    const orders = await callOdoo('pos.order', 'search_read',
        [[['company_id', '=', companies.neggo], ['partner_id', 'in', partnerIds], ['state', 'in', POS_STATES]]],
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
        const merged = (row.merged_partners || []).map((p) => p.id);
        purchases = await recentPurchases(merged.length ? merged : [row.odoo_partner_id]);
    } catch (err) {
        purchasesError = 'No pude leer los últimos tickets de Odoo';
        console.warn(`⚠️ CRM: tickets de ${partnerId}: ${err.message}`);
    }
    return { ...row, recent_purchases: purchases, recent_purchases_error: purchasesError };
}

module.exports = {
    ensureSchema,
    buildRows,
    mergeDuplicates,
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
