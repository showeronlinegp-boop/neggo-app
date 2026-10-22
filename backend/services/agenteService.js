// API del agente (Grok Bot): lectura de Odoo y de la base, y armado de las respuestas.
// Regla dura: no escribe nada en Odoo. Solo escribe en las tablas crm_bot_* y en crm_events.
// El cálculo de clientes nuevos está en agenteNuevos.js (lógica pura).

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const health = require('./clientHealth');
const { ensureSchema } = require('./crmSchema');
const { phoneKey, phoneDisplay } = require('./crmContacts');
const { productLink } = require('./whatsappMessage');
const nuevos = require('./agenteNuevos');

const COMPANY = 'neggo';
const PAGE = 2000;
const LINE_BATCH = 300;
const NUEVOS_TTL_MS = 5 * 60 * 1000;
const TEMPLATE_TTL_MS = 60 * 60 * 1000;
const TEXTO_NO_CONTACTAR = 'Pidió por WhatsApp que no le escriban más (Grok Bot)';

class AgenteError extends Error {
    constructor(status, message, details) {
        super(message);
        this.name = 'AgenteError';
        this.status = status;
        this.details = details;
    }
}

/** Cualquier falla leyendo Odoo sale como 502, con el detalle solo en el log. */
async function odoo(fn) {
    try {
        return await fn();
    } catch (err) {
        console.error('❌ Agente: error leyendo Odoo:', err.message);
        throw new AgenteError(502, 'No pude leer Odoo');
    }
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

async function neggoContext() {
    const companies = await getCompanyIds();
    if (!companies.neggo) throw new Error('No se pudo resolver company_id de Neggo');
    return { companyId: companies.neggo, context: { allowed_company_ids: [companies.neggo] } };
}

function hoyAr() {
    return health.toArDate(new Date());
}

// =============================================
// Clientes nuevos
// =============================================

/**
 * Líneas de los tickets, con la misma lógica que readPosLines del CRM (solo productos físicos;
 * si el ticket cobra un pedido, las líneas del pedido una sola vez en el primer ticket).
 * Además devuelve el pedido que cobra cada ticket, para agrupar seña y saldo.
 */
async function readLineas(ticketIds, context) {
    const lineas = [];
    const ventaPorTicket = new Map();
    const primerTicketPorVenta = new Map();
    for (let i = 0; i < ticketIds.length; i += LINE_BATCH) {
        const batch = ticketIds.slice(i, i + LINE_BATCH);
        const rows = await callOdoo('pos.order.line', 'search_read',
            [[['order_id', 'in', batch], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'qty', 'price_subtotal_incl'], context });
        lineas.push(...rows);
        const cobros = await callOdoo('pos.order.line', 'search_read',
            [[['order_id', 'in', batch], ['sale_order_origin_id', '!=', false]]],
            { fields: ['order_id', 'sale_order_origin_id'], order: 'id asc', context });
        for (const l of cobros) {
            const tid = nuevos.m2oId(l.order_id);
            const saleId = nuevos.m2oId(l.sale_order_origin_id);
            // Un ticket que cobra más de un pedido se agrupa con el de menor id
            const prev = ventaPorTicket.get(tid);
            if (!prev || saleId < nuevos.m2oId(prev)) ventaPorTicket.set(tid, l.sale_order_origin_id);
            if (!primerTicketPorVenta.has(saleId) || tid < primerTicketPorVenta.get(saleId)) primerTicketPorVenta.set(saleId, tid);
        }
    }
    const saleIds = [...primerTicketPorVenta.keys()];
    for (let i = 0; i < saleIds.length; i += LINE_BATCH) {
        const rows = await callOdoo('sale.order.line', 'search_read',
            [[['order_id', 'in', saleIds.slice(i, i + LINE_BATCH)], ['display_type', '=', false], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_total'], context });
        for (const r of rows) {
            lineas.push({
                order_id: [primerTicketPorVenta.get(nuevos.m2oId(r.order_id)), null],
                product_id: r.product_id,
                qty: r.product_uom_qty,
                price_subtotal_incl: r.price_total,
            });
        }
    }
    return { lineas, ventaPorTicket };
}

/** Partners con nombre, teléfono, ciudad y el nombre del primer contacto hijo. */
async function readPartners(ids) {
    const out = new Map();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 500) {
        const rows = await callOdoo('res.partner', 'read', [list.slice(i, i + 500)], {
            fields: ['id', 'name', 'phone', 'city', 'child_ids'],
            context: { active_test: false },
        });
        for (const r of rows) out.set(r.id, r);
    }
    const childIds = [...new Set([...out.values()].flatMap((p) => p.child_ids || []))];
    const childs = new Map();
    for (let i = 0; i < childIds.length; i += 500) {
        const rows = await callOdoo('res.partner', 'read', [childIds.slice(i, i + 500)], { fields: ['id', 'name', 'type'] });
        for (const r of rows) childs.set(r.id, r);
    }
    for (const p of out.values()) {
        const contacto = (p.child_ids || [])
            .map((id) => childs.get(id))
            .filter((c) => c && c.type === 'contact' && String(c.name || '').trim())
            .sort((a, b) => a.id - b.id)[0];
        p.contacto_odoo = contacto ? String(contacto.name).trim() : null;
    }
    return out;
}

async function readCategorias(productIds, context) {
    const out = new Map();
    const list = [...productIds];
    for (let i = 0; i < list.length; i += 500) {
        const rows = await callOdoo('product.product', 'read', [list.slice(i, i + 500)], {
            fields: ['id', 'categ_id'],
            context: { ...context, active_test: false },
        });
        for (const r of rows) out.set(r.id, nuevos.m2oName(r.categ_id));
    }
    return out;
}

/** Rubro del cliente: el de client_metrics_cache; si todavía no está, topRubro sobre sus compras. */
async function rubros(clientes, context) {
    const ids = clientes.map((c) => c.id);
    const { rows } = await pool.query(
        'SELECT odoo_partner_id, rubro FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = ANY($2::int[])',
        [COMPANY, ids]);
    const out = new Map(rows.map((r) => [r.odoo_partner_id, r.rubro || null]));
    const faltan = clientes.filter((c) => !out.has(c.id));
    if (!faltan.length) return out;
    const productIds = new Set(faltan.flatMap((c) => c.compras.flatMap((k) => k.productos.map((p) => p.id))));
    const categorias = await readCategorias(productIds, context);
    const labels = health.rubroLabels(categorias.values());
    for (const c of faltan) {
        const lineas = c.compras.flatMap((k) => k.productos.map((p) => ({
            category: labels.get(categorias.get(p.id)) || null,
            amount: p.precio * p.cantidad,
        })));
        out.set(c.id, health.topRubro(lineas));
    }
    return out;
}

// Caché en memoria de la parte que viene de Odoo, por cantidad de días. Lo local (etapa,
// no_contactar, contacto) se lee en cada pedido porque cambia con los PATCH.
const nuevosCache = new Map();

async function calcularNuevosOdoo(dias, hoy) {
    const { companyId, context } = await neggoContext();
    const desde = nuevos.desdeVentana(hoy, dias);
    const recientes = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES], ['date_order', '>=', nuevos.inicioDiaUtc(desde)]],
        ['partner_id'], context);
    const candidatos = [...new Set(recientes.map((t) => nuevos.m2oId(t.partner_id)).filter(Boolean))];
    if (!candidatos.length) return [];

    const todos = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES], ['partner_id', 'in', candidatos]],
        ['id', 'name', 'pos_reference', 'partner_id', 'date_order', 'amount_total', 'state'], context);
    const tickets = nuevos.ticketsDeNuevos({ tickets: todos, hoy, dias });
    if (!tickets.length) return [];

    const { lineas, ventaPorTicket } = await readLineas(tickets.map((t) => t.id), context);
    for (const t of tickets) t.sale_order_origin_id = ventaPorTicket.get(t.id) || false;
    const clientes = nuevos.calcularClientesNuevos({ tickets, lineas, hoy, dias });
    if (!clientes.length) return [];

    const partners = await readPartners(clientes.map((c) => c.id));
    const rubroPorCliente = await rubros(clientes, context);
    return clientes.map((c) => {
        const p = partners.get(c.id) || {};
        return {
            id: c.id,
            nombre: p.name || c.nombre,
            contacto_odoo: p.contacto_odoo || null,
            telefono: phoneDisplay(phoneKey(p.phone)),
            ciudad: p.city ? String(p.city).trim() : null,
            rubro: rubroPorCliente.get(c.id) || null,
            fecha_primera_compra: c.fecha_primera_compra,
            cantidad_compras: c.cantidad_compras,
            compras: c.compras,
        };
    });
}

async function nuevosDesdeOdoo(dias, refresh) {
    const hoy = hoyAr();
    const hit = nuevosCache.get(dias);
    if (!refresh && hit && hit.hoy === hoy && Date.now() - hit.at < NUEVOS_TTL_MS) return hit.data;
    const data = await odoo(() => calcularNuevosOdoo(dias, hoy));
    nuevosCache.set(dias, { at: Date.now(), hoy, data });
    return data;
}

function formatSeguimiento(row) {
    return {
        etapa: row ? row.etapa : 'pendiente',
        ultimo_contacto: row && row.ultimo_contacto ? nuevos.toArIso(row.ultimo_contacto) : null,
        proxima_accion: row ? row.proxima_accion || null : null,
    };
}

const SEG_SELECT = `SELECT odoo_partner_id, etapa, ultimo_contacto, proxima_accion::text AS proxima_accion,
                           no_contactar, no_contactar_at, contacto, updated_at
                    FROM crm_bot_seguimiento`;

async function seguimientos(ids, db = pool) {
    const { rows } = await db.query(`${SEG_SELECT} WHERE odoo_partner_id = ANY($1::int[])`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r]));
}

/** GET clientes/nuevos. */
async function listarNuevos({ dias, etapa, no_contactar: noContactar, page, limit, offset, refresh }) {
    await ensureSchema();
    const base = await nuevosDesdeOdoo(dias, refresh);
    const segs = await seguimientos(base.map((c) => c.id));
    let lista = base.map((c) => {
        const s = segs.get(c.id);
        const { contacto_odoo: contactoOdoo, ...resto } = c;
        return {
            id: resto.id,
            nombre: resto.nombre,
            contacto: (s && s.contacto) || contactoOdoo || null,
            telefono: resto.telefono,
            ciudad: resto.ciudad,
            rubro: resto.rubro,
            no_contactar: Boolean(s && s.no_contactar),
            fecha_primera_compra: resto.fecha_primera_compra,
            cantidad_compras: resto.cantidad_compras,
            compras: resto.compras,
            seguimiento: formatSeguimiento(s),
        };
    });
    if (etapa) lista = lista.filter((c) => c.seguimiento.etapa === etapa);
    if (noContactar !== undefined) lista = lista.filter((c) => c.no_contactar === noContactar);
    return { data: lista.slice(offset, offset + limit), total: lista.length, page, limit };
}

// =============================================
// Clientes: existencia, seguimiento, no contactar
// =============================================

/** { id, nombre } si el partner existe (en la caché del CRM o en Odoo), o null. */
async function clienteBasico(id) {
    await ensureSchema();
    const { rows: [row] } = await pool.query(
        'SELECT partner_name FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = $2', [COMPANY, id]);
    if (row) return { id, nombre: row.partner_name };
    const rows = await odoo(() => callOdoo('res.partner', 'search_read', [[['id', '=', id]]], {
        fields: ['id', 'name'], limit: 1, context: { active_test: false },
    }));
    return rows.length ? { id, nombre: rows[0].name } : null;
}

async function exigirCliente(id) {
    const cliente = await clienteBasico(id);
    if (!cliente) throw new AgenteError(404, 'Cliente inexistente');
    return cliente;
}

function seguimientoCompleto(id, row) {
    return {
        id,
        ...formatSeguimiento(row),
        no_contactar: Boolean(row && row.no_contactar),
        no_contactar_at: row && row.no_contactar_at ? nuevos.toArIso(row.no_contactar_at) : null,
        contacto: (row && row.contacto) || null,
        actualizado: row && row.updated_at ? nuevos.toArIso(row.updated_at) : null,
    };
}

/** PATCH clientes/:id/seguimiento. Solo toca los campos que vinieron. */
async function actualizarSeguimiento(id, value) {
    await exigirCliente(id);
    const cols = Object.keys(value);
    const params = [id, ...cols.map((c) => value[c])];
    const sets = cols.map((c) => `${c} = EXCLUDED.${c}`);
    await pool.query(
        `INSERT INTO crm_bot_seguimiento (odoo_partner_id${cols.map((c) => `, ${c}`).join('')})
         VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')})
         ON CONFLICT (odoo_partner_id) DO UPDATE SET ${[...sets, 'updated_at = NOW()'].join(', ')}`,
        params);
    const segs = await seguimientos([id]);
    return seguimientoCompleto(id, segs.get(id));
}

/** Nombre del primer contacto hijo en Odoo. Si Odoo no responde, null: es solo un respaldo. */
async function contactoOdoo(id) {
    try {
        const partners = await readPartners([id]);
        return partners.get(id)?.contacto_odoo || null;
    } catch (err) {
        console.warn(`⚠️ Agente: no pude leer el contacto de ${id}: ${err.message}`);
        return null;
    }
}

/** PATCH clientes/:id: no_contactar y contacto. */
async function actualizarCliente(id, value) {
    const cliente = await exigirCliente(id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO crm_bot_seguimiento (odoo_partner_id) VALUES ($1) ON CONFLICT (odoo_partner_id) DO NOTHING', [id]);
        const { rows: [prev] } = await client.query(
            'SELECT no_contactar FROM crm_bot_seguimiento WHERE odoo_partner_id = $1 FOR UPDATE', [id]);
        const sets = ['updated_at = NOW()'];
        const params = [id];
        if ('contacto' in value) {
            params.push(value.contacto);
            sets.push(`contacto = $${params.length}`);
        }
        if (value.no_contactar === true && !prev.no_contactar) {
            sets.push('no_contactar = true', 'no_contactar_at = NOW()', "etapa = 'finalizado'");
            // Queda en la ficha del cliente para que lo vea el equipo
            await client.query(
                `INSERT INTO crm_events (odoo_partner_id, kind, text, meta, user_id) VALUES ($1, 'nota', $2, $3, NULL)`,
                [id, TEXTO_NO_CONTACTAR, JSON.stringify({ origen: 'agente' })]);
        } else if (value.no_contactar === false) {
            sets.push('no_contactar = false', 'no_contactar_at = NULL');
        }
        await client.query(`UPDATE crm_bot_seguimiento SET ${sets.join(', ')} WHERE odoo_partner_id = $1`, params);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    const row = (await seguimientos([id])).get(id);
    if (value.no_contactar === true) console.log(`✅ Agente: cliente ${id} marcado como no contactar`);
    return {
        id,
        nombre: cliente.nombre,
        contacto: row.contacto || await contactoOdoo(id),
        no_contactar: row.no_contactar,
        seguimiento: formatSeguimiento(row),
    };
}

// =============================================
// Interacciones
// =============================================

function formatInteraccion(r) {
    return {
        id: r.id,
        cliente_id: r.odoo_partner_id,
        fecha: nuevos.toArIso(r.fecha),
        tipo: r.tipo,
        etapa: r.etapa,
        mensaje: r.mensaje,
        respuesta: r.respuesta,
    };
}

/** POST clientes/:id/interacciones. Un 'enviado' a quien pidió no recibir mensajes → 409. */
async function registrarInteraccion(id, value) {
    await exigirCliente(id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [seg] } = await client.query(
            'SELECT no_contactar FROM crm_bot_seguimiento WHERE odoo_partner_id = $1 FOR UPDATE', [id]);
        if (value.tipo === 'enviado' && seg && seg.no_contactar) {
            throw new AgenteError(409, 'El cliente pidió no recibir mensajes');
        }
        const { rows: [row] } = await client.query(
            `INSERT INTO crm_bot_interacciones (odoo_partner_id, fecha, tipo, etapa, mensaje, respuesta)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [id, value.fecha, value.tipo, value.etapa, value.mensaje, value.respuesta]);
        if (value.tipo === 'enviado') {
            // Un mensaje cargado tarde (más viejo) no pisa un contacto más nuevo
            await client.query(
                `INSERT INTO crm_bot_seguimiento (odoo_partner_id, ultimo_contacto) VALUES ($1, $2)
                 ON CONFLICT (odoo_partner_id) DO UPDATE
                 SET ultimo_contacto = GREATEST(crm_bot_seguimiento.ultimo_contacto, EXCLUDED.ultimo_contacto),
                     updated_at = NOW()`,
                [id, value.fecha]);
        }
        await client.query('COMMIT');
        return formatInteraccion(row);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** GET clientes/:id/interacciones, de la más nueva a la más vieja. */
async function listarInteracciones(id, { page, limit, offset }) {
    await exigirCliente(id);
    const { rows: [count] } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM crm_bot_interacciones WHERE odoo_partner_id = $1', [id]);
    const { rows } = await pool.query(
        `SELECT * FROM crm_bot_interacciones WHERE odoo_partner_id = $1
         ORDER BY fecha DESC, id DESC LIMIT $2 OFFSET $3`, [id, limit, offset]);
    return { data: rows.map(formatInteraccion), total: count.total, page, limit };
}

// =============================================
// Productos
// =============================================

// website_url e is_published por plantilla, leídos de Odoo solo para la página pedida
const templateCache = new Map();
let webDeshabilitada = false;

async function datosWeb(templateIds) {
    const out = new Map();
    if (webDeshabilitada) return out;
    const faltan = [];
    for (const id of templateIds) {
        const hit = templateCache.get(id);
        if (hit && Date.now() - hit.at < TEMPLATE_TTL_MS) out.set(id, hit);
        else faltan.push(id);
    }
    if (!faltan.length) return out;
    const { context } = await neggoContext();
    let rows;
    try {
        rows = await callOdoo('product.template', 'read', [faltan], {
            fields: ['id', 'website_url', 'is_published'],
            context: { ...context, active_test: false },
        });
    } catch (err) {
        if (/is_published|website_url|Invalid field/i.test(err.message)) {
            webDeshabilitada = true;
            console.warn('⚠️ Agente: Odoo no tiene el módulo web (is_published): productos sin url ni imagen');
            return out;
        }
        throw err;
    }
    for (const r of rows) {
        const dato = { at: Date.now(), website_url: r.website_url || null, is_published: Boolean(r.is_published) };
        templateCache.set(r.id, dato);
        out.set(r.id, dato);
    }
    return out;
}

function urlImagen(templateId) {
    const base = String(process.env.ODOO_URL || '').replace(/\/+$/, '');
    return base && templateId ? `${base}/web/image/product.template/${templateId}/image_512` : null;
}

/**
 * GET productos. Neggo no lleva stock en Odoo: archivar = agotado. Por eso "con stock" es
 * activo y no archivado en la app; stock=false devuelve los agotados.
 */
async function listarProductos({ rubro, stock, q, page, limit, offset }) {
    const { rows: cats } = await pool.query(
        `SELECT DISTINCT categ_name FROM odoo_products_cache
         WHERE company = $1 AND NULLIF(TRIM(categ_name), '') IS NOT NULL`, [COMPANY]);
    const nombres = cats.map((c) => c.categ_name);
    const labels = health.rubroLabels(nombres);

    const where = ['company = $1', 'list_price > 0'];
    const params = [COMPANY];
    where.push(stock === false
        ? '(active = false OR locally_archived = true)'
        : '(active = true AND locally_archived = false)');
    if (rubro) {
        const key = health.rubroKey(rubro);
        const match = key ? nombres.filter((n) => health.rubroKey(n) === key) : [];
        if (!match.length) return { data: [], total: 0, page, limit };
        params.push(match);
        where.push(`categ_name = ANY($${params.length}::text[])`);
    }
    if (q) {
        params.push(`%${q}%`);
        where.push(`name ILIKE $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const { rows: [count] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM odoo_products_cache WHERE ${whereSql}`, params);
    const { rows } = await pool.query(
        `SELECT odoo_id, name, list_price, categ_name, template_id, is_published,
                (active = true AND locally_archived = false) AS stock
         FROM odoo_products_cache WHERE ${whereSql}
         ORDER BY (active = true AND locally_archived = false) DESC, name ASC, odoo_id ASC
         LIMIT ${limit} OFFSET ${offset}`, params);

    let web = new Map();
    let webCaida = false;
    try {
        web = await datosWeb([...new Set(rows.map((r) => r.template_id).filter(Boolean))]);
    } catch (err) {
        // Sin Odoo se responde igual: imagen según la caché, sin link
        webCaida = true;
        console.warn(`⚠️ Agente: no pude leer los links de Odoo: ${err.message}`);
    }
    const data = rows.map((r) => {
        const w = web.get(r.template_id);
        const publicado = w ? w.is_published : (webCaida && !webDeshabilitada ? Boolean(r.is_published) : false);
        return {
            id: r.odoo_id,
            nombre: String(r.name || '').trim(),
            precio: Number(r.list_price),
            rubro: labels.get(r.categ_name) || null,
            categoria: r.categ_name || null,
            stock: r.stock,
            url: w && w.is_published ? productLink(w.website_url) : null,
            imagen: publicado ? urlImagen(r.template_id) : null,
        };
    });
    return { data, total: count.total, page, limit };
}

// =============================================
// Feedback del agente sobre la API
// =============================================

async function registrarFeedback({ tipo, endpoint, mensaje }) {
    await ensureSchema();
    const { rows: [r] } = await pool.query(
        'INSERT INTO crm_bot_feedback (tipo, endpoint, mensaje) VALUES ($1, $2, $3) RETURNING *',
        [tipo, endpoint, mensaje]);
    console.log(`📦 Agente: feedback nuevo (${tipo}) ${endpoint || ''}`);
    return { id: r.id, tipo: r.tipo, endpoint: r.endpoint, mensaje: r.mensaje, fecha: nuevos.toArIso(r.created_at) };
}

async function listarFeedback({ page, limit, offset }) {
    await ensureSchema();
    const { rows: [count] } = await pool.query('SELECT COUNT(*)::int AS total FROM crm_bot_feedback');
    const { rows } = await pool.query(
        'SELECT * FROM crm_bot_feedback ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return {
        data: rows.map((r) => ({ id: r.id, tipo: r.tipo, endpoint: r.endpoint, mensaje: r.mensaje, fecha: nuevos.toArIso(r.created_at) })),
        total: count.total,
        page,
        limit,
    };
}

module.exports = {
    AgenteError,
    listarNuevos,
    actualizarSeguimiento,
    actualizarCliente,
    registrarInteraccion,
    listarInteracciones,
    listarProductos,
    registrarFeedback,
    listarFeedback,
};
