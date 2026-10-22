// API del agente (Grok Bot): lectura de Odoo y de la base, y armado de las respuestas.
// Regla dura: no escribe nada en Odoo. Solo escribe en las tablas crm_bot_* y en crm_events.
// El cálculo de clientes nuevos y la cadencia están en agenteNuevos.js (lógica pura).

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
const VENDIDOS_TTL_MS = 6 * 60 * 60 * 1000;
const VENDIDOS_DIAS = 90;
// Para leer toda la historia de un cliente con calcularClientesNuevos
const TODA_LA_HISTORIA = 100000;
const TEXTO_NO_CONTACTAR = 'Pidió por WhatsApp que no le escriban más (Grok Bot)';
const TICKET_FIELDS = ['id', 'name', 'pos_reference', 'partner_id', 'date_order', 'amount_total', 'state', 'user_id', 'payment_ids'];

// Cada error lleva un código estable para que el agente decida si reintenta, cierra o avisa
class AgenteError extends Error {
    constructor(status, message, codigo, details) {
        super(message);
        this.name = 'AgenteError';
        this.status = status;
        this.codigo = codigo;
        this.details = details;
    }
}

/** Cualquier falla leyendo Odoo sale como 502, con el detalle solo en el log. */
async function odoo(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof AgenteError) throw err;
        console.error('❌ Agente: error leyendo Odoo:', err.message);
        throw new AgenteError(502, 'No pude leer Odoo', 'odoo_caido');
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

async function enTransaccion(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// =============================================
// Lectura de Odoo
// =============================================

/** Agrega a cada ticket los nombres de sus medios de pago (formas_pago). */
async function agregarFormasPago(tickets, context) {
    const ids = tickets.flatMap((t) => t.payment_ids || []);
    const metodo = new Map();
    for (let i = 0; i < ids.length; i += 500) {
        const rows = await callOdoo('pos.payment', 'read', [ids.slice(i, i + 500)], { fields: ['id', 'payment_method_id'], context });
        for (const r of rows) metodo.set(r.id, nuevos.m2oName(r.payment_method_id));
    }
    for (const t of tickets) t.formas_pago = (t.payment_ids || []).map((id) => metodo.get(id)).filter(Boolean);
}

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

/** Tickets → compras agrupadas, con medios de pago y productos. */
async function comprasDeTickets(tickets, hoy, dias, context) {
    if (!tickets.length) return [];
    await agregarFormasPago(tickets, context);
    const { lineas, ventaPorTicket } = await readLineas(tickets.map((t) => t.id), context);
    for (const t of tickets) t.sale_order_origin_id = ventaPorTicket.get(t.id) || false;
    return nuevos.calcularClientesNuevos({ tickets, lineas, hoy, dias });
}

/** Partners con nombre, teléfono, ciudad y el primer contacto hijo. */
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

async function categoriasDeProductos() {
    const { rows } = await pool.query(
        `SELECT DISTINCT categ_name FROM odoo_products_cache
         WHERE company = $1 AND NULLIF(TRIM(categ_name), '') IS NOT NULL`, [COMPANY]);
    return rows.map((r) => r.categ_name);
}

/** Rubro del módulo comercial (Clientes): la categoría en la que más compró, calculada una vez por día. */
async function rubrosComerciales(ids) {
    const { rows } = await pool.query(
        'SELECT odoo_partner_id, rubro FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = ANY($2::int[])',
        [COMPANY, [...ids]]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r.rubro || null]));
}

/**
 * Completa las compras con los datos del partner, el rubro y lo que compró por rubro.
 * El rubro es el del módulo comercial; si el cliente todavía no está ahí (compró por primera
 * vez hoy y el cálculo diario no corrió), se calcula con la misma regla sobre sus compras.
 */
async function enriquecer(clientes, partnerIds, context) {
    const partners = await readPartners(partnerIds);
    const productIds = new Set(clientes.flatMap((c) => c.compras.flatMap((k) => k.productos.map((p) => p.id))));
    const categorias = await readCategorias(productIds, context);
    const nombresCategorias = await categoriasDeProductos();
    const labels = health.rubroLabels([...nombresCategorias, ...categorias.values()]);
    const rubroPorProducto = new Map([...categorias].map(([pid, cat]) => [pid, labels.get(cat) || null]));
    const comerciales = await rubrosComerciales(partnerIds);
    const porId = new Map(clientes.map((c) => [c.id, c]));
    return [...partnerIds].map((id) => {
        const c = porId.get(id) || { id, nombre: null, fecha_primera_compra: null, cantidad_compras: 0, compras: [] };
        const p = partners.get(id) || {};
        return {
            id,
            nombre: p.name || c.nombre || `Cliente ${id}`,
            contacto_odoo: p.contacto_odoo || null,
            telefono: phoneDisplay(phoneKey(p.phone)),
            ciudad: p.city ? String(p.city).trim() : null,
            rubro: comerciales.has(id) ? comerciales.get(id) : nuevos.rubroDeCompras(c.compras, rubroPorProducto),
            categorias_compradas: nuevos.categoriasCompradas(c.compras, rubroPorProducto),
            fecha_primera_compra: c.fecha_primera_compra,
            cantidad_compras: c.cantidad_compras,
            compras: c.compras,
        };
    });
}

// =============================================
// Clientes nuevos y ficha
// =============================================

// Caché en memoria de la parte que viene de Odoo, por cantidad de días. Lo local (etapa,
// no_contactar, contacto) se lee en cada pedido porque cambia con los PATCH y los envíos.
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
        TICKET_FIELDS, context);
    const tickets = nuevos.ticketsDeNuevos({ tickets: todos, hoy, dias });
    const clientes = await comprasDeTickets(tickets, hoy, dias, context);
    if (!clientes.length) return [];
    return enriquecer(clientes, clientes.map((c) => c.id), context);
}

async function nuevosDesdeOdoo(dias, refresh) {
    const hoy = hoyAr();
    const hit = nuevosCache.get(dias);
    if (!refresh && hit && hit.hoy === hoy && Date.now() - hit.at < NUEVOS_TTL_MS) return hit.data;
    const data = await odoo(() => calcularNuevosOdoo(dias, hoy));
    nuevosCache.set(dias, { at: Date.now(), hoy, data });
    return data;
}

/** Toda la historia de compras de un cliente, en vivo y sin caché. */
async function fichaOdoo(id) {
    const { companyId, context } = await neggoContext();
    const tickets = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES], ['partner_id', '=', id]],
        TICKET_FIELDS, context);
    const clientes = await comprasDeTickets(tickets, hoyAr(), TODA_LA_HISTORIA, context);
    const [ficha] = await enriquecer(clientes, [id], context);
    return ficha;
}

function formatSeguimiento(row) {
    return {
        etapa: row ? row.etapa : 'pendiente',
        ultimo_contacto: row && row.ultimo_contacto ? nuevos.toArIso(row.ultimo_contacto) : null,
        proxima_accion: row ? row.proxima_accion || null : null,
        actualizado: row && row.updated_at ? nuevos.toArIso(row.updated_at) : null,
    };
}

const SEG_SELECT = `SELECT odoo_partner_id, etapa, ultimo_contacto, proxima_accion::text AS proxima_accion,
                           no_contactar, no_contactar_at, contacto, revisado_hasta, updated_at
                    FROM crm_bot_seguimiento`;

async function seguimientos(ids, db = pool) {
    const { rows } = await db.query(`${SEG_SELECT} WHERE odoo_partner_id = ANY($1::int[])`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r]));
}

/** Reserva activa (no vencida) de cada cliente: { id_externo, etapa, reservado_hasta }. */
async function reservasActivas(ids, db = pool) {
    const { rows } = await db.query(
        `SELECT DISTINCT ON (odoo_partner_id) odoo_partner_id, id_externo, etapa, reservado_hasta
         FROM crm_bot_interacciones
         WHERE odoo_partner_id = ANY($1::int[]) AND envio_etapa AND estado = 'reservado' AND reservado_hasta >= NOW()
         ORDER BY odoo_partner_id, reservado_hasta DESC`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, {
        id_externo: r.id_externo, etapa: r.etapa, reservado_hasta: nuevos.toArIso(r.reservado_hasta),
    }]));
}

/** Último mensaje recibido y último enviado (confirmado) de cada cliente. */
async function conversaciones(ids, db = pool) {
    const { rows } = await db.query(
        `SELECT odoo_partner_id,
                MAX(fecha) FILTER (WHERE tipo = 'recibido') AS ultimo_recibido,
                MAX(fecha) FILTER (WHERE tipo = 'enviado' AND estado = 'enviado') AS ultimo_enviado
         FROM crm_bot_interacciones WHERE odoo_partner_id = ANY($1::int[])
         GROUP BY odoo_partner_id`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r]));
}

function hayRespuestaPendiente(row, conv) {
    return nuevos.respuestaPendiente({
        ultimoRecibido: conv && conv.ultimo_recibido,
        ultimoEnviado: conv && conv.ultimo_enviado,
        revisadoHasta: row && row.revisado_hasta,
    });
}

/** Cliente completo: lo de Odoo + lo local + qué le toca hoy. Mismo formato en la lista y en la ficha. */
function armarCliente(base, row, hoy, ventanaAbierta, conv, reserva = null) {
    const noContactar = Boolean(row && row.no_contactar);
    const seguimiento = formatSeguimiento(row);
    const toca = nuevos.tocaHoy({ fechaPrimeraCompra: base.fecha_primera_compra, hoy, etapa: seguimiento.etapa, noContactar });
    const pendiente = hayRespuestaPendiente(row, conv);
    return {
        id: base.id,
        nombre: base.nombre,
        contacto: (row && row.contacto) || base.contacto_odoo || null,
        telefono: base.telefono,
        ciudad: base.ciudad,
        rubro: base.rubro,
        categorias_compradas: base.categorias_compradas,
        no_contactar: noContactar,
        no_contactar_at: row && row.no_contactar_at ? nuevos.toArIso(row.no_contactar_at) : null,
        fecha_primera_compra: base.fecha_primera_compra,
        dias_desde_compra: base.fecha_primera_compra ? health.daysBetween(base.fecha_primera_compra, hoy) : null,
        toca_hoy: toca,
        vence: toca ? nuevos.vence(base.fecha_primera_compra, toca) : null,
        respuesta_pendiente: pendiente,
        ultimo_recibido: conv && conv.ultimo_recibido ? nuevos.toArIso(conv.ultimo_recibido) : null,
        reserva_activa: reserva,
        puede_enviar_ahora: Boolean(toca && base.telefono && ventanaAbierta && !pendiente && !reserva),
        cantidad_compras: base.cantidad_compras,
        compras: base.compras,
        seguimiento,
    };
}

function meta(hoy, ahora = new Date()) {
    return {
        hoy,
        ahora: nuevos.toArIso(ahora),
        ventana_envio: nuevos.VENTANA_ENVIO.texto,
        ventana_abierta: nuevos.ventanaAbierta(ahora),
        abre_a: nuevos.abreA(ahora),
    };
}

/** GET clientes/nuevos. */
async function listarNuevos({ dias, etapa, no_contactar: noContactar, para_hoy: paraHoy, con_respuesta_pendiente: conRespuesta, page, limit, offset, refresh }) {
    await ensureSchema();
    const base = await nuevosDesdeOdoo(dias, refresh);
    const ids = base.map((c) => c.id);
    const segs = await seguimientos(ids);
    const convs = await conversaciones(ids);
    const reservas = await reservasActivas(ids);
    const hoy = hoyAr();
    const info = meta(hoy);
    let lista = base.map((c) => armarCliente(c, segs.get(c.id), hoy, info.ventana_abierta, convs.get(c.id), reservas.get(c.id) || null));
    if (etapa) lista = lista.filter((c) => c.seguimiento.etapa === etapa);
    if (noContactar !== null && noContactar !== undefined) lista = lista.filter((c) => c.no_contactar === noContactar);
    if (paraHoy !== undefined) lista = lista.filter((c) => Boolean(c.toca_hoy) === paraHoy);
    if (conRespuesta !== undefined) lista = lista.filter((c) => c.respuesta_pendiente === conRespuesta);
    return { data: lista.slice(offset, offset + limit), total: lista.length, page, limit, meta: info };
}

/** GET clientes/:id: en vivo y sin caché, para chequear justo antes de mandar. */
async function obtenerCliente(id) {
    await exigirCliente(id);
    const ficha = await odoo(() => fichaOdoo(id));
    const row = (await seguimientos([id])).get(id);
    const conv = (await conversaciones([id])).get(id);
    const reserva = (await reservasActivas([id])).get(id) || null;
    const hoy = hoyAr();
    const info = meta(hoy);
    return { data: armarCliente(ficha, row, hoy, info.ventana_abierta, conv, reserva), meta: info };
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
    if (!cliente) throw new AgenteError(404, 'Cliente inexistente', 'no_encontrado');
    return cliente;
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

/** Respuesta de los PATCH y envíos: el estado local del cliente (sin las compras, que vienen de Odoo). */
async function estadoCliente(cliente, row) {
    return {
        id: cliente.id,
        nombre: cliente.nombre,
        contacto: (row && row.contacto) || await contactoOdoo(cliente.id),
        no_contactar: Boolean(row && row.no_contactar),
        no_contactar_at: row && row.no_contactar_at ? nuevos.toArIso(row.no_contactar_at) : null,
        seguimiento: formatSeguimiento(row),
    };
}

async function lockSeguimiento(db, id) {
    await db.query('INSERT INTO crm_bot_seguimiento (odoo_partner_id) VALUES ($1) ON CONFLICT (odoo_partner_id) DO NOTHING', [id]);
    const { rows: [row] } = await db.query(`${SEG_SELECT} WHERE odoo_partner_id = $1 FOR UPDATE`, [id]);
    return row;
}

/**
 * PATCH clientes/:id/seguimiento. Solo toca los campos que vinieron. La etapa solo avanza,
 * nunca sale de finalizado y, con no contactar, solo puede quedar en finalizado y sin próxima acción.
 * ultimo_contacto nunca retrocede.
 */
async function actualizarSeguimiento(id, value) {
    const cliente = await exigirCliente(id);
    const row = await enTransaccion(async (db) => {
        const prev = await lockSeguimiento(db, id);
        const error = nuevos.errorTransicion({ actual: prev.etapa, nueva: value.etapa, noContactar: prev.no_contactar });
        if (error) throw new AgenteError(409, error, prev.no_contactar ? 'no_contactar' : 'transicion_invalida');
        const etapa = value.etapa || prev.etapa;
        if ((prev.no_contactar || etapa === 'finalizado') && value.proxima_accion) {
            throw new AgenteError(409, 'Un cliente finalizado o que pidió no recibir mensajes no lleva próxima acción', 'transicion_invalida');
        }
        const sets = ['updated_at = NOW()'];
        const params = [id];
        if (value.etapa) {
            params.push(value.etapa);
            sets.push(`etapa = $${params.length}`);
        }
        if (value.ultimo_contacto) {
            params.push(value.ultimo_contacto);
            sets.push(`ultimo_contacto = GREATEST(ultimo_contacto, $${params.length})`);
        }
        if (etapa === 'finalizado') sets.push('proxima_accion = NULL');
        else if ('proxima_accion' in value) {
            params.push(value.proxima_accion);
            sets.push(`proxima_accion = $${params.length}`);
        }
        await db.query(`UPDATE crm_bot_seguimiento SET ${sets.join(', ')} WHERE odoo_partner_id = $1`, params);
        return (await seguimientos([id], db)).get(id);
    });
    return estadoCliente(cliente, row);
}

/**
 * PATCH clientes/:id: no_contactar y contacto. El agente puede marcar no contactar pero no
 * desmarcarlo: eso lo decide el equipo.
 */
async function actualizarCliente(id, value) {
    const cliente = await exigirCliente(id);
    const row = await enTransaccion(async (db) => {
        const prev = await lockSeguimiento(db, id);
        if (value.no_contactar === false && prev.no_contactar) {
            throw new AgenteError(409, 'El cliente pidió no recibir mensajes: solo lo puede desmarcar el equipo de Neggo', 'no_contactar');
        }
        const sets = ['updated_at = NOW()'];
        const params = [id];
        if ('contacto' in value) {
            params.push(value.contacto);
            sets.push(`contacto = $${params.length}`);
        }
        if (value.no_contactar === true && !prev.no_contactar) {
            sets.push('no_contactar = true', 'no_contactar_at = NOW()', "etapa = 'finalizado'", 'proxima_accion = NULL');
            // Lo que estaba reservado y todavía no salió ya no se manda
            await db.query(
                `UPDATE crm_bot_interacciones SET estado = 'cancelado', motivo_cancelacion = 'no_contactar', reservado_hasta = NULL
                 WHERE odoo_partner_id = $1 AND estado IN ('reservado', 'vencido')`, [id]);
            // Queda en la ficha del cliente para que lo vea el equipo
            await db.query(
                `INSERT INTO crm_events (odoo_partner_id, kind, text, meta, user_id) VALUES ($1, 'nota', $2, $3, NULL)`,
                [id, TEXTO_NO_CONTACTAR, JSON.stringify({ origen: 'agente' })]);
        }
        await db.query(`UPDATE crm_bot_seguimiento SET ${sets.join(', ')} WHERE odoo_partner_id = $1`, params);
        return (await seguimientos([id], db)).get(id);
    });
    if (value.no_contactar === true) console.log(`✅ Agente: cliente ${id} marcado como no contactar`);
    return estadoCliente(cliente, row);
}

// =============================================
// Interacciones y envíos
// =============================================

function formatInteraccion(r) {
    return {
        id: r.id,
        cliente_id: r.odoo_partner_id,
        fecha: nuevos.toArIso(r.fecha),
        tipo: r.tipo,
        etapa: r.etapa,
        envio_de_etapa: r.envio_etapa,
        estado: r.envio_etapa ? r.estado : null,
        reservado_hasta: r.estado === 'reservado' && r.reservado_hasta ? nuevos.toArIso(r.reservado_hasta) : null,
        motivo_cancelacion: r.estado === 'cancelado' ? r.motivo_cancelacion || 'agente' : null,
        mensaje: r.mensaje,
        productos_recomendados: r.productos_recomendados || [],
        id_externo: r.id_externo,
    };
}

/**
 * Si ya se registró algo con ese id_externo, lo devuelve (reintento: no se duplica).
 * Si el id_externo es de otro cliente, 409.
 */
async function porIdExterno(db, id, idExterno) {
    if (!idExterno) return null;
    const { rows: [r] } = await db.query('SELECT * FROM crm_bot_interacciones WHERE id_externo = $1', [idExterno]);
    if (!r) return null;
    if (id !== null && r.odoo_partner_id !== id) throw new AgenteError(409, 'Ese id_externo ya se usó con otro cliente', 'id_externo_usado');
    return r;
}

/** El reintento tiene que ser igual al original: si cambió el texto, la etapa o los productos, es otro envío. */
function exigirMismoContenido(previa, value) {
    const productos = (x) => [...(x || [])].map(Number).sort((a, b) => a - b).join(',');
    const distinto = previa.mensaje !== value.mensaje
        || (value.etapa !== undefined && (previa.etapa || null) !== (value.etapa || null))
        || (value.tipo !== undefined && previa.tipo !== value.tipo)
        || (value.productos_recomendados !== undefined && productos(previa.productos_recomendados) !== productos(value.productos_recomendados));
    if (distinto) {
        throw new AgenteError(409, 'Ese id_externo ya se usó con otro contenido (mensaje, etapa o productos). Usá un id_externo nuevo', 'id_externo_distinto');
    }
}

function esDuplicado(err) {
    return err && err.code === '23505';
}

async function sumarContacto(db, id, fecha) {
    // Un mensaje cargado tarde (más viejo) no pisa un contacto más nuevo
    await db.query(
        `UPDATE crm_bot_seguimiento
         SET ultimo_contacto = GREATEST(ultimo_contacto, $2), updated_at = NOW()
         WHERE odoo_partner_id = $1`, [id, fecha]);
}

/**
 * POST clientes/:id/interacciones. Mensajes sueltos de la conversación (respuestas del cliente
 * y lo que Grok contesta). Para los mensajes de la cadencia se usa POST envios.
 * Un 'enviado' a quien pidió no recibir mensajes → 409.
 */
async function registrarInteraccion(id, value) {
    await exigirCliente(id);
    try {
        return await enTransaccion(async (db) => {
            const repetida = await porIdExterno(db, id, value.id_externo);
            if (repetida) {
                exigirMismoContenido(repetida, value);
                return { data: formatInteraccion(repetida), repetida: true };
            }
            const seg = await lockSeguimiento(db, id);
            if (value.tipo === 'enviado' && seg.no_contactar) throw new AgenteError(409, 'El cliente pidió no recibir mensajes', 'no_contactar');
            const { rows: [row] } = await db.query(
                `INSERT INTO crm_bot_interacciones (odoo_partner_id, fecha, tipo, etapa, mensaje, id_externo)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [id, value.fecha, value.tipo, value.etapa, value.mensaje, value.id_externo]);
            if (value.tipo === 'enviado') await sumarContacto(db, id, value.fecha);
            return { data: formatInteraccion(row), repetida: false };
        });
    } catch (err) {
        // Dos pedidos con el mismo id_externo al mismo tiempo: gana uno y el otro devuelve el guardado
        if (esDuplicado(err) && value.id_externo) {
            const r = await porIdExterno(pool, id, value.id_externo);
            if (r) return { data: formatInteraccion(r), repetida: true };
        }
        throw err;
    }
}

/** Marca como vencidas las reservas del cliente que pasaron su tiempo sin confirmarse. */
async function vencerReservas(db, id) {
    await db.query(
        `UPDATE crm_bot_interacciones SET estado = 'vencido'
         WHERE odoo_partner_id = $1 AND estado = 'reservado' AND reservado_hasta < NOW()`, [id]);
}

async function respuestaEnvio(cliente, r, repetida) {
    const row = (await seguimientos([cliente.id])).get(cliente.id);
    return { data: { envio: formatInteraccion(r), cliente: await estadoCliente(cliente, row) }, repetida };
}

/**
 * POST clientes/:id/envios: RESERVA el mensaje de una etapa de la cadencia, antes de mandarlo.
 * Chequea todo con la hora del servidor (horario, no contactar, teléfono, respuesta pendiente,
 * etapa que toca, ya enviada o reservada) y bloquea la etapa por RESERVA_SEGUNDOS. Después de
 * mandar el WhatsApp se confirma con POST envios/:idExterno/confirmar; si no salió, se cancela.
 * Con el mismo id_externo devuelve la reserva ya hecha (200, repetido).
 */
async function reservarEnvio(id, value) {
    const cliente = await exigirCliente(id);
    await vencerReservas(pool, id);
    const repetida = await porIdExterno(pool, id, value.id_externo);
    if (repetida) {
        exigirMismoContenido(repetida, value);
        if (repetida.estado === 'cancelado') {
            throw new AgenteError(409, 'Esa reserva se canceló: reservá con un id_externo nuevo', 'reserva_cancelada');
        }
        if (repetida.estado === 'vencido') {
            throw new AgenteError(409, 'Esa reserva venció: reservá con un id_externo nuevo', 'reserva_vencida');
        }
        return respuestaEnvio(cliente, repetida, true);
    }
    const ahora = new Date();
    if (!nuevos.ventanaAbierta(ahora)) {
        throw new AgenteError(409, `Fuera del horario de envío: ${nuevos.VENTANA_ENVIO.texto}. Abre: ${nuevos.abreA(ahora)}`, 'fuera_de_horario');
    }
    const ficha = await odoo(() => fichaOdoo(id));
    if (!ficha.telefono) throw new AgenteError(409, 'El cliente no tiene un celular válido en Odoo', 'sin_telefono');
    const hoy = hoyAr();
    try {
        const r = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, id);
            if (seg.no_contactar) throw new AgenteError(409, 'El cliente pidió no recibir mensajes', 'no_contactar');
            await vencerReservas(db, id);
            const { rows: previas } = await db.query(
                `SELECT estado, id_externo FROM crm_bot_interacciones
                 WHERE odoo_partner_id = $1 AND envio_etapa AND etapa = $2 AND estado IN ('reservado', 'enviado')`, [id, value.etapa]);
            if (previas.some((x) => x.estado === 'enviado')) {
                throw new AgenteError(409, `La etapa ${value.etapa} ya se envió a este cliente`, 'ya_enviado');
            }
            if (previas.length) {
                throw new AgenteError(409, `La etapa ${value.etapa} está reservada por otro envío (${previas[0].id_externo})`, 'etapa_reservada');
            }
            const conv = (await conversaciones([id], db)).get(id);
            if (hayRespuestaPendiente(seg, conv)) {
                throw new AgenteError(409, 'El cliente contestó y todavía no se revisó su respuesta', 'respuesta_pendiente');
            }
            const toca = nuevos.tocaHoy({ fechaPrimeraCompra: ficha.fecha_primera_compra, hoy, etapa: seg.etapa, noContactar: false });
            if (value.etapa !== toca) {
                const dia = ficha.fecha_primera_compra ? health.daysBetween(ficha.fecha_primera_compra, hoy) : '-';
                throw new AgenteError(409, toca
                    ? `Hoy no le toca ${value.etapa}: le toca ${toca}`
                    : `Hoy no le toca ningún mensaje de la cadencia (etapa ${seg.etapa}, día ${dia})`, 'etapa_no_corresponde');
            }
            const { rows: [row] } = await db.query(
                `INSERT INTO crm_bot_interacciones
                    (odoo_partner_id, fecha, tipo, etapa, mensaje, id_externo, envio_etapa, estado, reservado_hasta, productos_recomendados)
                 VALUES ($1, NOW(), 'enviado', $2, $3, $4, true, 'reservado', NOW() + ($5::int * INTERVAL '1 second'), $6)
                 RETURNING *`,
                [id, value.etapa, value.mensaje, value.id_externo, nuevos.RESERVA_SEGUNDOS, value.productos_recomendados]);
            return row;
        });
        console.log(`📦 Agente: reserva ${value.etapa} para ${id} (${value.id_externo})`);
        return respuestaEnvio(cliente, r, false);
    } catch (err) {
        if (!esDuplicado(err)) throw err;
        // Mismo id_externo en paralelo: devuelve el que se guardó. Si no, otro proceso tomó la etapa
        const r = await porIdExterno(pool, id, value.id_externo);
        if (r) return respuestaEnvio(cliente, r, true);
        throw new AgenteError(409, `La etapa ${value.etapa} ya está reservada o enviada`, 'etapa_reservada');
    }
}

async function exigirEnvio(db, idExterno) {
    const r = await porIdExterno(db, null, idExterno);
    if (!r || !r.envio_etapa) throw new AgenteError(404, 'No hay un envío con ese id_externo', 'no_encontrado');
    return r;
}

/**
 * POST envios/:idExterno/confirmar: el WhatsApp ya salió. Registra el envío con la hora del
 * servidor, avanza la etapa y calcula la próxima acción. Se confirma aunque la reserva haya
 * vencido o el cliente haya pedido no contactar después: el mensaje salió y tiene que quedar.
 * Solo falla si la reserva se canceló o si otro envío ya ocupó la etapa.
 */
async function confirmarEnvio(idExterno) {
    const previa = await exigirEnvio(pool, idExterno);
    const cliente = await exigirCliente(previa.odoo_partner_id);
    if (previa.estado === 'enviado') return respuestaEnvio(cliente, previa, true);
    // Si se canceló porque el cliente pidió no contactar, pero el bot ya lo había mandado, igual se registra.
    // Si lo canceló el agente (no salió), no se confirma
    if (previa.estado === 'cancelado' && previa.motivo_cancelacion !== 'no_contactar') {
        throw new AgenteError(409, 'Ese envío se canceló: no se puede confirmar', 'reserva_cancelada');
    }
    const ficha = await odoo(() => fichaOdoo(cliente.id));
    try {
        const r = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, cliente.id);
            const { rows: [row] } = await db.query(
                `UPDATE crm_bot_interacciones SET estado = 'enviado', fecha = NOW(), reservado_hasta = NULL, motivo_cancelacion = NULL
                 WHERE id = $1 AND (estado IN ('reservado', 'vencido') OR (estado = 'cancelado' AND motivo_cancelacion = 'no_contactar'))
                 RETURNING *`, [previa.id]);
            if (!row) throw new AgenteError(409, 'El envío cambió de estado mientras se confirmaba', 'reserva_cancelada');
            // La etapa solo avanza: si ya estaba más adelante (o finalizado), queda como está
            const avanza = !nuevos.errorTransicion({ actual: seg.etapa, nueva: row.etapa, noContactar: seg.no_contactar });
            await db.query(
                `UPDATE crm_bot_seguimiento
                 SET ultimo_contacto = GREATEST(ultimo_contacto, NOW()), updated_at = NOW()
                     ${avanza ? ', etapa = $2, proxima_accion = $3' : ''}
                 WHERE odoo_partner_id = $1`,
                avanza ? [cliente.id, row.etapa, nuevos.proximaAccion(ficha.fecha_primera_compra, row.etapa)] : [cliente.id]);
            return row;
        });
        console.log(`✅ Agente: envío ${r.etapa} confirmado para ${cliente.id}`);
        return respuestaEnvio(cliente, r, false);
    } catch (err) {
        if (esDuplicado(err)) throw new AgenteError(409, `Otro envío ya ocupó la etapa ${previa.etapa}`, 'ya_enviado');
        throw err;
    }
}

/** POST envios/:idExterno/cancelar: el WhatsApp no salió. Libera la etapa. */
async function cancelarEnvio(idExterno) {
    const previa = await exigirEnvio(pool, idExterno);
    const cliente = await exigirCliente(previa.odoo_partner_id);
    if (previa.estado === 'cancelado') return respuestaEnvio(cliente, previa, true);
    if (previa.estado === 'enviado') throw new AgenteError(409, 'Ese envío ya se confirmó: no se puede cancelar', 'ya_enviado');
    const { rows: [r] } = await pool.query(
        `UPDATE crm_bot_interacciones SET estado = 'cancelado', motivo_cancelacion = 'agente', reservado_hasta = NULL
         WHERE id = $1 AND estado IN ('reservado', 'vencido') RETURNING *`, [previa.id]);
    if (!r) throw new AgenteError(409, 'Ese envío ya se confirmó: no se puede cancelar', 'ya_enviado');
    return respuestaEnvio(cliente, r, false);
}

/** GET envios/:idExterno: para que el bot de WhatsApp chequee antes de mandar (o reintentar). */
async function estadoEnvio(idExterno) {
    await ensureSchema();
    const previa = await exigirEnvio(pool, idExterno);
    await vencerReservas(pool, previa.odoo_partner_id);
    const r = await exigirEnvio(pool, idExterno);
    return formatInteraccion(r);
}

/** POST clientes/:id/revisado: el agente leyó las respuestas del cliente (no hace falta contestar). */
async function marcarRevisado(id) {
    const cliente = await exigirCliente(id);
    const row = await enTransaccion(async (db) => {
        await lockSeguimiento(db, id);
        await db.query('UPDATE crm_bot_seguimiento SET revisado_hasta = NOW(), updated_at = NOW() WHERE odoo_partner_id = $1', [id]);
        return (await seguimientos([id], db)).get(id);
    });
    return estadoCliente(cliente, row);
}

/** GET clientes/:id/interacciones, de la más nueva a la más vieja (a igual fecha, la última cargada primero). */
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

// Unidades y facturación por producto en los últimos 90 días (tickets del POS de Neggo), caché de 6 h
let vendidosCache = null;

async function vendidos90() {
    if (vendidosCache && Date.now() - vendidosCache.at < VENDIDOS_TTL_MS) return vendidosCache.data;
    const { companyId, context } = await neggoContext();
    const desde = health.addDays(hoyAr(), -(VENDIDOS_DIAS - 1));
    const tickets = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES], ['date_order', '>=', nuevos.inicioDiaUtc(desde)]],
        ['id'], context);
    const { lineas } = await readLineas(tickets.map((t) => t.id), context);
    const data = new Map();
    for (const l of lineas) {
        const pid = nuevos.m2oId(l.product_id);
        if (!pid) continue;
        const prev = data.get(pid) || { qty: 0, monto: 0 };
        prev.qty += Number(l.qty) || 0;
        prev.monto += Number(l.price_subtotal_incl) || 0;
        data.set(pid, prev);
    }
    vendidosCache = { at: Date.now(), data };
    console.log(`📦 Agente: ventas de ${VENDIDOS_DIAS} días cargadas (${data.size} productos)`);
    return data;
}

/**
 * GET productos. Neggo no lleva stock en Odoo: archivar = agotado. Por eso "con stock" es
 * activo y no archivado en la app; stock=false devuelve los agotados. El precio es el final.
 */
async function listarProductos({ rubros, stock, q, precio_min: precioMin, solo_publicados: soloPublicados, orden, excluir_compras_de: excluirDe, page, limit, offset }) {
    const nombres = await categoriasDeProductos();
    const labels = health.rubroLabels(nombres);

    const where = ['p.company = $1', 'p.list_price > 0'];
    const params = [COMPANY];
    where.push(stock === false
        ? '(p.active = false OR p.locally_archived = true)'
        : '(p.active = true AND p.locally_archived = false)');
    if (rubros && rubros.length) {
        const conocidos = new Set(nombres.map((n) => health.rubroKey(n)).filter(Boolean));
        const invalidos = rubros.filter((r) => !conocidos.has(health.rubroKey(r)));
        if (invalidos.length) {
            throw new AgenteError(422, 'Datos inválidos', 'datos_invalidos',
                invalidos.map((r) => ({ campo: 'rubro', error: `No existe el rubro "${r}". Rubros: ${[...new Set(labels.values())].sort().join(', ')}` })));
        }
        const keys = new Set(rubros.map((r) => health.rubroKey(r)));
        const match = nombres.filter((n) => keys.has(health.rubroKey(n)));
        params.push(match);
        where.push(`p.categ_name = ANY($${params.length}::text[])`);
    }
    if (precioMin !== undefined) {
        params.push(precioMin);
        where.push(`p.list_price >= $${params.length}`);
    }
    if (q) {
        params.push(`%${q}%`);
        where.push(`p.name ILIKE $${params.length}`);
    }
    if (soloPublicados) where.push('p.is_published = true AND p.template_id IS NOT NULL');
    if (excluirDe) {
        await exigirCliente(excluirDe);
        const ficha = await odoo(() => fichaOdoo(excluirDe));
        const comprados = [...new Set(ficha.compras.flatMap((c) => c.productos.map((p) => p.id)))];
        if (comprados.length) {
            params.push(comprados);
            where.push(`NOT (p.odoo_id = ANY($${params.length}::int[]))`);
        }
    }
    const whereSql = where.join(' AND ');
    const { rows: [count] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM odoo_products_cache p WHERE ${whereSql}`, params);

    // Más vendidos primero. Si Odoo no responde, se ordena por nombre y se avisa en el log
    let vendidos = new Map();
    if (orden !== 'nombre') {
        try {
            vendidos = await vendidos90();
        } catch (err) {
            console.warn(`⚠️ Agente: no pude leer las ventas para ordenar: ${err.message}`);
        }
    }
    const disponible = '(p.active = true AND p.locally_archived = false)';
    const ordenSql = {
        facturacion: `${disponible} DESC, COALESCE(v.monto, 0) DESC, p.name ASC, p.odoo_id ASC`,
        vendidos: `${disponible} DESC, COALESCE(v.qty, 0) DESC, p.name ASC, p.odoo_id ASC`,
        nombre: `${disponible} DESC, p.name ASC, p.odoo_id ASC`,
    }[orden];
    const qParams = [...params, [...vendidos.keys()], [...vendidos.values()].map((x) => x.qty), [...vendidos.values()].map((x) => x.monto)];
    const { rows } = await pool.query(
        `SELECT p.odoo_id, p.name, p.list_price, p.categ_name, p.template_id, p.is_published,
                ${disponible} AS stock, COALESCE(v.qty, 0) AS vendidos, COALESCE(v.monto, 0) AS facturado, p.synced_at
         FROM odoo_products_cache p
         LEFT JOIN unnest($${qParams.length - 2}::int[], $${qParams.length - 1}::numeric[], $${qParams.length}::numeric[]) AS v(pid, qty, monto)
           ON v.pid = p.odoo_id
         WHERE ${whereSql}
         ORDER BY ${ordenSql}
         LIMIT ${limit} OFFSET ${offset}`, qParams);

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
            product_id: r.odoo_id,
            template_id: r.template_id,
            nombre: nuevos.limpiarNombre(r.name),
            precio: Number(r.list_price),
            rubro: labels.get(r.categ_name) || null,
            categoria: r.categ_name || null,
            stock: r.stock,
            vendidos_90d: Math.round(Number(r.vendidos) * 100) / 100,
            facturado_90d: Math.round(Number(r.facturado) * 100) / 100,
            precio_actualizado: r.synced_at ? nuevos.toArIso(r.synced_at) : null,
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
    obtenerCliente,
    actualizarSeguimiento,
    actualizarCliente,
    registrarInteraccion,
    reservarEnvio,
    confirmarEnvio,
    cancelarEnvio,
    estadoEnvio,
    marcarRevisado,
    listarInteracciones,
    listarProductos,
    registrarFeedback,
    listarFeedback,
};
