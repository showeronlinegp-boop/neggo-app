// API del agente (Grok Bot): lectura de Odoo y de la base, y armado de las respuestas.
// Regla dura: no escribe nada en Odoo. Solo escribe en las tablas crm_bot_* y en crm_events
// (y el feedback, además, como nota de prueba).
// El cálculo de clientes nuevos y la cadencia están en agenteNuevos.js (lógica pura); el de las
// cotizaciones web sin confirmar, en agenteCotizacionesWeb.js.

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const health = require('./clientHealth');
const { ensureSchema } = require('./crmSchema');
const { phoneKey, phoneDisplay } = require('./crmContacts');
const { productLink } = require('./whatsappMessage');
const nuevos = require('./agenteNuevos');
const importantes = require('./agenteImportantes');
const inactivos = require('./agenteInactivos');
const cotWeb = require('./agenteCotizacionesWeb');
const testNotes = require('./testNotesService');

const COMPANY = 'neggo';
const PAGE = 2000;
const LINE_BATCH = 300;
const NUEVOS_TTL_MS = 5 * 60 * 1000;
const IMPORTANTES_TTL_MS = 5 * 60 * 1000;
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

/** Reserva activa (no vencida) de cada cliente, de cualquier flujo: { id_externo, flujo, etapa, tipo_inactivo, reservado_hasta }. */
async function reservasActivas(ids, db = pool) {
    const { rows } = await db.query(
        `SELECT DISTINCT ON (odoo_partner_id) odoo_partner_id, id_externo, flujo, etapa, tipo_inactivo, reservado_hasta
         FROM crm_bot_interacciones
         WHERE odoo_partner_id = ANY($1::int[]) AND envio_etapa AND estado = 'reservado' AND reservado_hasta >= NOW()
         ORDER BY odoo_partner_id, reservado_hasta DESC`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, {
        id_externo: r.id_externo, flujo: r.flujo, etapa: r.etapa, tipo_inactivo: r.tipo_inactivo,
        reservado_hasta: nuevos.toArIso(r.reservado_hasta),
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
    const data = armarCliente(ficha, row, hoy, info.ventana_abierta, conv, reserva);
    // Fase 1: bloque importante con los defaults de config (sin marcas manuales)
    data.importante = importantes.resumenImportante(ficha, importantes.cargarConfig(), hoy, null);
    const pedidosMap = await odoo(() => pedidosActivosOdoo([id], hoy));
    data.pedido_activo = pedidosMap.get(id) || null;
    if (data.importante) data.importante.pedido_activo = data.pedido_activo;
    // Bloque inactivo con los defaults de config/inactivos.json
    const si = (await segInactivos([id])).get(id) || null;
    const enFlujoNuevos = enCadenciaNuevos(ficha.fecha_primera_compra, row, hoy);
    const ev = evaluarInactivo(ficha, {
        regla: inactivos.cargarConfig(),
        hoy,
        si,
        pedidoActivo: Boolean(data.pedido_activo),
        enFlujoNuevos,
        esImportante: Boolean(data.importante && data.importante.es_importante),
    });
    const { _codigo, ...estado } = estadoInactivo({ base: ficha, m: ev.m, row, conv, reserva, si, hoy, ventanaAbierta: info.ventana_abierta, esInactivo: ev.es_inactivo });
    if (!ev.es_inactivo) estado.motivo_toca_hoy = motivoNoInactivo(ev, inactivos.cargarConfig());
    data.inactivo = {
        es_inactivo: ev.es_inactivo,
        motivo_exclusion: ev.motivo_exclusion,
        dias_sin_comprar: ev.m.dias_sin_comprar,
        ultima_compra: ev.m.ultima_compra,
        monto_ultima_compra: ev.m.monto_ultima_compra,
        primera_compra: ev.m.primera_compra,
        cantidad_compras: ev.m.cantidad_compras,
        total_historico: ev.m.total_historico,
        ticket_promedio: ev.m.ticket_promedio,
        intervalo_habitual_dias: ev.m.intervalo_habitual_dias,
        top_productos: ev.m.top_productos,
        marca_manual: formatMarca(si),
        ...estado,
    };
    return { data, meta: info };
}

// =============================================
// Clientes importantes (fase 1: solo lectura)
// =============================================

// Caché de la parte de Odoo por combinación de parámetros de ventana/montos.
const importantesCache = new Map();

function claveImportantes({ dias, dias_pedido, monto_minimo, monto_pedido_minimo, top }) {
    return [dias, dias_pedido, monto_minimo, monto_pedido_minimo, top == null ? '-' : top].join('|');
}

// Historia mínima que se lee: un año y un día, para que importantes (365) e inactivos
// (dias_max 365 + el día de hoy) compartan la misma lectura de Odoo con los defaults
const HISTORIA_DIAS_MIN = 366;
const HISTORIA_TTL_MS = 5 * 60 * 1000;

/**
 * Cuántos días de historia hay que leer para armar totales, tendencia, pedido grande
 * e intervalo habitual. La última y la primera compra salen de toda la historia del partner.
 */
function lookbackImportantes(dias, diasPedido) {
    return Math.max(dias * 2, diasPedido, HISTORIA_DIAS_MIN);
}

/**
 * Clientes que compraron en los últimos `lookback` días, con TODA su historia de compras,
 * enriquecidos (partner, rubro, categorías) y el rubro de cada producto. Es la lectura pesada
 * de Odoo que comparten importantes e inactivos.
 */
async function calcularHistoriaOdoo(lookback, hoy) {
    const { companyId, context } = await neggoContext();
    const desdeLookback = nuevos.desdeVentana(hoy, lookback);
    const recientes = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES],
            ['date_order', '>=', nuevos.inicioDiaUtc(desdeLookback)]],
        ['partner_id'], context);
    const candidatos = [...new Set(recientes.map((t) => nuevos.m2oId(t.partner_id)).filter(Boolean))];
    if (!candidatos.length) return { base: [], rubroPorProducto: new Map() };

    // Toda la historia de esos partners: hace falta para ultima_compra, primera compra y el intervalo
    const todos = await readAll('pos.order',
        [['company_id', '=', companyId], ['state', 'in', nuevos.POS_STATES], ['partner_id', 'in', candidatos]],
        TICKET_FIELDS, context);
    const clientes = await comprasDeTickets(todos, hoy, TODA_LA_HISTORIA, context);
    if (!clientes.length) return { base: [], rubroPorProducto: new Map() };
    const base = await enriquecer(clientes, clientes.map((c) => c.id), context);

    // categorias_compradas de importantes salen solo de la ventana (las recalcula calcularImportantes
    // con rubroPorProducto; las de enriquecer son de toda la historia, que es lo que usa inactivos).
    const productIds = new Set(base.flatMap((c) => c.compras.flatMap((k) => k.productos.map((p) => p.id))));
    const categorias = await readCategorias([...productIds], context);
    const nombresCategorias = await categoriasDeProductos();
    const labels = health.rubroLabels([...nombresCategorias, ...categorias.values()]);
    const rubroPorProducto = new Map([...categorias].map(([pid, cat]) => [pid, labels.get(cat) || null]));
    return { base, rubroPorProducto };
}

// Caché por lookback. Guarda la promesa: dos pedidos a la vez hacen una sola lectura
const historiaCache = new Map();

async function historiaDesdeOdoo(lookback, refresh) {
    const hoy = hoyAr();
    const hit = historiaCache.get(lookback);
    if (!refresh && hit && hit.hoy === hoy && Date.now() - hit.at < HISTORIA_TTL_MS) return hit.promise;
    const promise = odoo(() => calcularHistoriaOdoo(lookback, hoy));
    historiaCache.set(lookback, { at: Date.now(), hoy, promise });
    try {
        return await promise;
    } catch (err) {
        if (historiaCache.get(lookback)?.promise === promise) historiaCache.delete(lookback);
        throw err;
    }
}

async function calcularImportantesOdoo({ dias, dias_pedido: diasPedido, monto_minimo, monto_pedido_minimo, top }, hoy, refresh = false) {
    const { base, rubroPorProducto } = await historiaDesdeOdoo(lookbackImportantes(dias, diasPedido), refresh);
    if (!base.length) return [];

    const cfg = importantes.cargarConfig();
    return importantes.calcularImportantes({
        clientes: base,
        hoy,
        dias,
        monto_minimo,
        monto_pedido_minimo,
        dias_pedido: diasPedido,
        min_compras_intervalo: cfg.min_compras_intervalo,
        top,
        marcas: null, // fase 1: sin marcas
        rubroPorProducto,
    }).map((ev) => {
        const b = base.find((c) => c.id === ev.id) || {};
        return {
            ...ev,
            contacto_odoo: b.contacto_odoo || null,
            telefono: b.telefono || null,
            ciudad: b.ciudad || null,
            rubro: b.rubro || null,
        };
    });
}

async function importantesDesdeOdoo(params, refresh) {
    const hoy = hoyAr();
    const clave = claveImportantes(params);
    const hit = importantesCache.get(clave);
    if (!refresh && hit && hit.hoy === hoy && Date.now() - hit.at < IMPORTANTES_TTL_MS) return hit.data;
    const data = await odoo(() => calcularImportantesOdoo(params, hoy, refresh));
    importantesCache.set(clave, { at: Date.now(), hoy, data });
    return data;
}

function armarClienteImportante(base, row, conv, reserva = null, pedidoActivo = null) {
    const noContactar = Boolean(row && row.no_contactar);
    const etapa = row ? row.etapa : 'pendiente';
    const pendiente = hayRespuestaPendiente(row, conv);
    const enFlujoNuevos = Boolean(base.en_ventana_nuevos && etapa !== 'finalizado');
    return {
        id: base.id,
        nombre: base.nombre,
        contacto: (row && row.contacto) || base.contacto_odoo || null,
        telefono: base.telefono,
        ciudad: base.ciudad,
        rubro: base.rubro,
        categorias_compradas: base.categorias_compradas,
        motivo_importante: base.motivo_importante,
        pedidos_grandes: base.pedidos_grandes,
        marca_manual: base.marca_manual,
        total_comprado: base.total_comprado,
        cantidad_compras: base.cantidad_compras,
        ticket_promedio: base.ticket_promedio,
        ultima_compra: base.ultima_compra,
        dias_sin_comprar: base.dias_sin_comprar,
        intervalo_habitual_dias: base.intervalo_habitual_dias,
        tendencia: base.tendencia,
        no_contactar: noContactar,
        respuesta_pendiente: pendiente,
        reserva_activa: reserva,
        en_flujo_nuevos: enFlujoNuevos,
        pedido_activo: pedidoActivo || null,
    };
}

const PEDIDO_ACTIVO_FIELDS = [
    'id', 'name', 'state', 'date_order', 'amount_total', 'amount_unpaid', 'partner_id', 'validity_date', 'company_id',
];

/**
 * Pedidos activos (cotización enviada / orden abierta / borrador) leídos en vivo de Odoo.
 * Devuelve Map idClienteLista -> bloque pedido_activo. No usa el caché de importantes.
 */
async function pedidosActivosOdoo(ids, hoy) {
    const listIds = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!listIds.length) return new Map();
    const pa = importantes.cargarConfig().pedido_activo;
    const companies = await getCompanyIds();
    if (!companies.neggo) throw new Error('No se pudo resolver company_id de Neggo');
    // Las órdenes de Preventas (seña + saldo al llegar la mercadería) viven en la company Preventas
    const companyIds = [companies.neggo];
    if (pa.incluir_preventas && companies.preventas) companyIds.push(companies.preventas);
    const context = { allowed_company_ids: companyIds };
    const lookback = Math.max(pa.dias_cotizacion, pa.dias_orden);
    const desde = nuevos.desdeVentana(hoy, lookback);
    const states = ['sent', 'sale'];
    if (pa.incluir_borradores) states.push('draft');

    const ordenes = await readAll('sale.order',
        [['company_id', 'in', companyIds], ['partner_id', 'child_of', listIds],
            ['state', 'in', states], ['date_order', '>=', nuevos.inicioDiaUtc(desde)]],
        PEDIDO_ACTIVO_FIELDS, context);
    if (!ordenes.length) return new Map();

    const idSet = new Set(listIds);
    const partnerIds = [...new Set(ordenes.map((o) => nuevos.m2oId(o.partner_id)).filter(Boolean))];
    const ancestro = new Map();
    for (const id of listIds) ancestro.set(id, id);

    const faltan = partnerIds.filter((pid) => !idSet.has(pid));
    if (faltan.length) {
        for (let i = 0; i < faltan.length; i += 500) {
            const rows = await callOdoo('res.partner', 'read', [faltan.slice(i, i + 500)], {
                fields: ['id', 'commercial_partner_id', 'parent_id'],
                context: { active_test: false },
            });
            for (const r of rows) {
                const commercial = nuevos.m2oId(r.commercial_partner_id);
                const parent = nuevos.m2oId(r.parent_id);
                if (idSet.has(commercial)) ancestro.set(r.id, commercial);
                else if (idSet.has(parent)) ancestro.set(r.id, parent);
            }
        }
    }

    const mapped = [];
    for (const o of ordenes) {
        const pid = nuevos.m2oId(o.partner_id);
        const listId = ancestro.get(pid);
        if (!listId) continue;
        mapped.push({
            id: o.id,
            name: o.name,
            state: o.state,
            date_order: o.date_order,
            amount_total: o.amount_total,
            amount_unpaid: o.amount_unpaid,
            partner: listId,
            compania: nuevos.m2oId(o.company_id) === companies.preventas ? 'preventas' : 'neggo',
        });
    }
    return importantes.clasificarPedidosActivos(mapped, pa, hoy);
}

/** GET clientes/importantes (fase 1). */
async function listarImportantes(query) {
    await ensureSchema();
    const {
        dias, dias_pedido, monto_minimo, monto_pedido_minimo, top, motivo, orden,
        no_contactar: noContactar, con_respuesta_pendiente: conRespuesta,
        incluir_pedido_activo: incluirPedidoActivo = false,
        page, limit, offset, refresh,
    } = query;
    const base = await importantesDesdeOdoo(
        { dias, dias_pedido, monto_minimo, monto_pedido_minimo, top }, refresh);
    const ids = base.map((c) => c.id);
    const segs = await seguimientos(ids);
    const convs = await conversaciones(ids);
    const reservas = await reservasActivas(ids);
    const hoy = hoyAr();
    const { ventana, ventana_anterior } = importantes.ventanas(hoy, dias);
    const cfg = importantes.cargarConfig();

    let lista = base.map((c) => armarClienteImportante(
        c, segs.get(c.id), convs.get(c.id), reservas.get(c.id) || null, null));

    if (motivo) lista = lista.filter((c) => c.motivo_importante.includes(motivo));
    if (noContactar !== null && noContactar !== undefined) {
        lista = lista.filter((c) => c.no_contactar === noContactar);
    }
    if (conRespuesta !== undefined) lista = lista.filter((c) => c.respuesta_pendiente === conRespuesta);

    // Pedidos activos en vivo (fuera del caché de 5 min): después de los otros filtros
    const pedidosMap = await odoo(() => pedidosActivosOdoo(lista.map((c) => c.id), hoy));
    let excluidosPedidoActivo = 0;
    if (!incluirPedidoActivo && cfg.pedido_activo.excluir_por_defecto) {
        const antes = lista.length;
        lista = lista.filter((c) => !pedidosMap.has(c.id));
        excluidosPedidoActivo = antes - lista.length;
    }
    lista = lista.map((c) => ({ ...c, pedido_activo: pedidosMap.get(c.id) || null }));

    lista = importantes.ordenarImportantes(lista, orden);

    const filtros = {
        dias, monto_pedido_minimo, dias_pedido,
        incluir_pedido_activo: Boolean(incluirPedidoActivo),
    };
    if (top != null) filtros.top = top;
    else filtros.monto_minimo = monto_minimo;

    return {
        data: lista.slice(offset, offset + limit),
        total: lista.length,
        page,
        limit,
        meta: {
            ...meta(hoy),
            filtros,
            ventana,
            ventana_anterior,
            excluidos_pedido_activo: excluidosPedidoActivo,
        },
    };
}

// =============================================
// Cotizaciones de la web sin confirmar
// =============================================

const COTIZACION_FIELDS = ['id', 'name', 'state', 'partner_id', 'date_order', 'write_date', 'amount_total', 'website_id', 'is_abandoned_cart'];

/** Partners que no son clientes: el usuario público de cada tienda y los usuarios internos (pruebas del equipo). */
async function partnersNoClientes() {
    const webs = await callOdoo('website', 'search_read', [[]], { fields: ['user_id'] });
    const publicos = webs.map((w) => nuevos.m2oId(w.user_id)).filter(Boolean);
    const usuarios = await callOdoo('res.users', 'search_read',
        [['|', ['share', '=', false], ['id', 'in', publicos]]],
        { fields: ['partner_id'], context: { active_test: false } });
    return usuarios.map((u) => nuevos.m2oId(u.partner_id)).filter(Boolean);
}

/** Última compra cerrada de cada partner (ticket del POS o pedido confirmado), en toda la historia. */
async function ultimasCompras(partnerIds, companyId, context) {
    const out = [];
    const grupos = [
        ['pos.order', ['state', 'in', nuevos.POS_STATES]],
        ['sale.order', ['state', '=', 'sale']],
    ];
    for (const [model, estado] of grupos) {
        const rows = await callOdoo(model, 'read_group',
            [[['company_id', '=', companyId], estado, ['partner_id', 'in', partnerIds]], ['date_order:max'], ['partner_id']],
            { lazy: false, context });
        for (const r of rows) out.push({ partner_id: r.partner_id, date_order: r.date_order });
    }
    return out;
}

async function cotizacionesWebOdoo(dias) {
    const { companyId, context } = await neggoContext();
    const desde = nuevos.desdeVentana(hoyAr(), dias);
    const fuera = new Set(await partnersNoClientes());
    const cotizaciones = (await readAll('sale.order',
        [['company_id', '=', companyId], ['state', 'in', cotWeb.ESTADOS_ABIERTOS], ['website_id', '!=', false],
            ['partner_id', '!=', false], ['date_order', '>=', nuevos.inicioDiaUtc(desde)]],
        COTIZACION_FIELDS, context)).filter((o) => !fuera.has(nuevos.m2oId(o.partner_id)));
    if (!cotizaciones.length) return [];

    const lineas = [];
    const ids = cotizaciones.map((o) => o.id);
    for (let i = 0; i < ids.length; i += LINE_BATCH) {
        const rows = await callOdoo('sale.order.line', 'search_read',
            [[['order_id', 'in', ids.slice(i, i + LINE_BATCH)], ['display_type', '=', false], ['product_id.type', '=', 'consu']]],
            { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_total'], context });
        lineas.push(...rows);
    }
    const partnerIds = [...new Set(cotizaciones.map((o) => nuevos.m2oId(o.partner_id)))];
    const compras = await ultimasCompras(partnerIds, companyId, context);
    const clientes = cotWeb.agruparCotizacionesWeb({ cotizaciones, lineas, compras, excluidos: fuera });
    if (!clientes.length) return [];
    const partners = await readPartners(clientes.map((c) => c.id));
    return clientes.map((c) => {
        const p = partners.get(c.id) || {};
        return {
            ...c,
            nombre: p.name || c.nombre,
            contacto_odoo: p.contacto_odoo || null,
            telefono: phoneDisplay(phoneKey(p.phone)),
            ciudad: p.city ? String(p.city).trim() : null,
        };
    });
}

function armarClienteCotizaciones(base, row, conv) {
    return {
        id: base.id,
        nombre: base.nombre,
        contacto: (row && row.contacto) || base.contacto_odoo || null,
        telefono: base.telefono,
        ciudad: base.ciudad,
        no_contactar: Boolean(row && row.no_contactar),
        no_contactar_at: row && row.no_contactar_at ? nuevos.toArIso(row.no_contactar_at) : null,
        respuesta_pendiente: hayRespuestaPendiente(row, conv),
        ultimo_recibido: conv && conv.ultimo_recibido ? nuevos.toArIso(conv.ultimo_recibido) : null,
        ultimo_enviado: conv && conv.ultimo_enviado ? nuevos.toArIso(conv.ultimo_enviado) : null,
        ultima_compra: base.ultima_compra,
        compro_despues: base.compro_despues,
        cantidad_cotizaciones: base.cotizaciones.length,
        cotizaciones: base.cotizaciones,
    };
}

/** GET clientes/cotizaciones-web: en vivo y sin caché. Solo lectura. */
async function listarCotizacionesWeb({ dias, no_contactar: noContactar, compro_despues: comproDespues, page, limit, offset }) {
    await ensureSchema();
    const base = await odoo(() => cotizacionesWebOdoo(dias));
    const ids = base.map((c) => c.id);
    const segs = await seguimientos(ids);
    const convs = await conversaciones(ids);
    let lista = base.map((c) => armarClienteCotizaciones(c, segs.get(c.id), convs.get(c.id)));
    if (noContactar !== null && noContactar !== undefined) lista = lista.filter((c) => c.no_contactar === noContactar);
    if (comproDespues !== undefined) lista = lista.filter((c) => c.compro_despues === comproDespues);
    return { data: lista.slice(offset, offset + limit), total: lista.length, page, limit, meta: meta(hoyAr()) };
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
        flujo: r.flujo || 'nuevos',
        etapa: r.etapa,
        tipo_inactivo: r.tipo_inactivo || null,
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
        || (value.tipo_inactivo !== undefined && (previa.tipo_inactivo || null) !== (value.tipo_inactivo || null))
        || (value.tipo_inactivo === undefined && value.etapa !== undefined && previa.flujo === 'inactivos')
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
    const estado = await estadoCliente(cliente, row);
    if (r.flujo === 'inactivos') {
        estado.seguimiento_inactivo = formatSeguimientoInactivoRow((await segInactivos([cliente.id])).get(cliente.id) || null);
    }
    return { data: { envio: formatInteraccion(r), cliente: estado }, repetida };
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
    if (value.tipo_inactivo) return reservarEnvioInactivo(cliente, value);
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
            // Una sola reserva activa por cliente, sin importar el flujo
            await exigirSinReservaActiva(db, id);
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
async function confirmarEnvio(idExterno, { enviado_at: enviadoAt = null } = {}) {
    const previa = await exigirEnvio(pool, idExterno);
    const cliente = await exigirCliente(previa.odoo_partner_id);
    if (previa.estado === 'enviado') return respuestaEnvio(cliente, previa, true);
    // Si se canceló porque el cliente pidió no contactar, pero el bot ya lo había mandado, igual se registra.
    // Si lo canceló el agente (no salió), no se confirma
    if (previa.estado === 'cancelado' && previa.motivo_cancelacion !== 'no_contactar') {
        throw new AgenteError(409, 'Ese envío se canceló: no se puede confirmar', 'reserva_cancelada');
    }
    // enviado_at (opcional): cuándo salió de verdad. No puede ser anterior a la reserva (1 minuto de margen)
    if (enviadoAt && enviadoAt.getTime() < new Date(previa.fecha).getTime() - 60 * 1000) {
        throw new AgenteError(422, 'Datos inválidos', 'datos_invalidos',
            [{ campo: 'enviado_at', error: `No puede ser anterior a la reserva (${nuevos.toArIso(previa.fecha)})` }]);
    }
    if (previa.flujo === 'inactivos') return confirmarEnvioInactivo(cliente, previa, enviadoAt);
    const ficha = await odoo(() => fichaOdoo(cliente.id));
    try {
        const r = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, cliente.id);
            const { rows: [row] } = await db.query(
                `UPDATE crm_bot_interacciones SET estado = 'enviado', fecha = COALESCE($2, NOW()), reservado_hasta = NULL, motivo_cancelacion = NULL
                 WHERE id = $1 AND (estado IN ('reservado', 'vencido') OR (estado = 'cancelado' AND motivo_cancelacion = 'no_contactar'))
                 RETURNING *`, [previa.id, enviadoAt]);
            if (!row) throw new AgenteError(409, 'El envío cambió de estado mientras se confirmaba', 'reserva_cancelada');
            // La etapa solo avanza: si ya estaba más adelante (o finalizado), queda como está
            const avanza = !nuevos.errorTransicion({ actual: seg.etapa, nueva: row.etapa, noContactar: seg.no_contactar });
            await db.query(
                `UPDATE crm_bot_seguimiento
                 SET ultimo_contacto = GREATEST(ultimo_contacto, $2), updated_at = NOW()
                     ${avanza ? ', etapa = $3, proxima_accion = $4' : ''}
                 WHERE odoo_partner_id = $1`,
                avanza
                    ? [cliente.id, row.fecha, row.etapa, nuevos.proximaAccion(ficha.fecha_primera_compra, row.etapa)]
                    : [cliente.id, row.fecha]);
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
// Clientes inactivos (más de dias_min días sin comprar)
// =============================================
// Flujo aparte de nuevos e importantes. Prioridad: nuevos > importantes > inactivos.
// Estado propio en crm_bot_seguimiento_inactivo; los envíos van a crm_bot_interacciones con
// flujo = 'inactivos'. Todas las escrituras toman antes el lock de crm_bot_seguimiento del
// cliente, así que no se pisan con los envíos de los otros flujos.

const SEG_INACT_SELECT = `SELECT odoo_partner_id, ciclo_desde_compra::text AS ciclo_desde_compra, toques_enviados,
                                 ultimo_contacto, ultimo_tipo, proxima_accion::text AS proxima_accion, cerrado,
                                 marca, marca_nota, marca_at, updated_at
                          FROM crm_bot_seguimiento_inactivo`;

async function segInactivos(ids, db = pool) {
    const { rows } = await db.query(`${SEG_INACT_SELECT} WHERE odoo_partner_id = ANY($1::int[])`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r]));
}

async function lockSegInactivo(db, id) {
    await db.query('INSERT INTO crm_bot_seguimiento_inactivo (odoo_partner_id) VALUES ($1) ON CONFLICT (odoo_partner_id) DO NOTHING', [id]);
    const { rows: [row] } = await db.query(`${SEG_INACT_SELECT} WHERE odoo_partner_id = $1 FOR UPDATE`, [id]);
    return row;
}

function formatMarca(si) {
    return si && si.marca ? { marca: si.marca, nota: si.marca_nota || null, at: si.marca_at ? nuevos.toArIso(si.marca_at) : null } : null;
}

/** En la cadencia de nuevos: primera compra dentro de la ventana de nuevos y etapa distinta de finalizado (igual que importantes). */
function enCadenciaNuevos(fechaPrimeraCompra, row, hoy) {
    const etapa = row ? row.etapa : 'pendiente';
    return Boolean(fechaPrimeraCompra && fechaPrimeraCompra >= nuevos.desdeVentana(hoy, nuevos.DIAS_DEFAULT) && etapa !== 'finalizado');
}

/** Regla + exclusiones de un cliente (con toda su historia). */
function evaluarInactivo(cliente, { regla, hoy, si, pedidoActivo, enFlujoNuevos, esImportante }) {
    const m = inactivos.metricas(cliente, hoy);
    const cumple = inactivos.cumpleRegla(m, regla);
    const motivo = cumple ? inactivos.motivoExclusion({ marca: formatMarca(si), pedidoActivo, enFlujoNuevos, esImportante }) : null;
    return { m, cumple, motivo_exclusion: motivo, es_inactivo: cumple && !motivo };
}

/** Día (Argentina) del último mensaje que recibió el cliente, de cualquier flujo. */
function ultimoContactoDia(row, conv, si) {
    const fechas = [row && row.ultimo_contacto, conv && conv.ultimo_enviado, si && si.ultimo_contacto]
        .filter(Boolean).map((f) => new Date(f).getTime());
    return fechas.length ? health.toArDate(new Date(Math.max(...fechas))) : null;
}

/** toca_hoy, vigencia, bloqueos y seguimiento_inactivo. Mismo cálculo en la lista, la ficha y la reserva. */
function estadoInactivo({ base, m, row, conv, reserva, si, hoy, ventanaAbierta, esInactivo, cfg = inactivos.cargarConfig() }) {
    const noContactar = Boolean(row && row.no_contactar);
    const pendiente = hayRespuestaPendiente(row, conv);
    const ciclo = inactivos.cicloActual(si, m.ultima_fecha);
    const t = inactivos.tocaHoy({
        esInactivo,
        diasSinComprar: m.dias_sin_comprar,
        ciclo,
        hoy,
        cfg,
        noContactar,
        respuestaPendiente: pendiente,
        ultimoRecibido: conv && conv.ultimo_recibido,
        ultimoContactoDia: ultimoContactoDia(row, conv, si),
    });
    return {
        no_contactar: noContactar,
        respuesta_pendiente: pendiente,
        reserva_activa: reserva || null,
        toca_hoy: t.toca,
        motivo_toca_hoy: t.motivo,
        vence: t.vence,
        puede_enviar_ahora: Boolean(t.toca && base.telefono && ventanaAbierta && !pendiente && !reserva && !noContactar),
        seguimiento_inactivo: {
            ciclo_desde_compra: ciclo.ciclo_desde_compra,
            toques_enviados: ciclo.toques_enviados,
            ultimo_contacto: ciclo.ultimo_contacto ? nuevos.toArIso(ciclo.ultimo_contacto) : null,
            ultimo_tipo: ciclo.ultimo_tipo,
            proxima_accion: esInactivo ? (t.proxima_accion || ciclo.proxima_accion || null) : null,
            cerrado: ciclo.cerrado || t.cerrado,
            actualizado: ciclo.actualizado ? nuevos.toArIso(ciclo.actualizado) : null,
        },
        _codigo: t.codigo,
    };
}

function armarClienteInactivo(base, m, row, conv, reserva, si, hoy, ventanaAbierta, cfg) {
    const { _codigo, ...estado } = estadoInactivo({ base, m, row, conv, reserva, si, hoy, ventanaAbierta, esInactivo: true, cfg });
    return {
        id: base.id,
        nombre: base.nombre,
        contacto: (row && row.contacto) || base.contacto_odoo || null,
        telefono: base.telefono,
        ciudad: base.ciudad,
        rubro: base.rubro,
        categorias_compradas: base.categorias_compradas,
        ultima_compra: m.ultima_compra,
        dias_sin_comprar: m.dias_sin_comprar,
        monto_ultima_compra: m.monto_ultima_compra,
        primera_compra: m.primera_compra,
        cantidad_compras: m.cantidad_compras,
        total_historico: m.total_historico,
        ticket_promedio: m.ticket_promedio,
        intervalo_habitual_dias: m.intervalo_habitual_dias,
        top_productos: m.top_productos,
        marca_manual: formatMarca(si),
        ...estado,
    };
}

/**
 * Todos los inactivos de la regla (sin filtros de la query) y cuántos quedaron afuera por
 * cada exclusión. Lo comparten la lista y el resumen.
 */
async function evaluarInactivos(regla, refresh) {
    await ensureSchema();
    const cfg = inactivos.cargarConfig();
    const impCfg = importantes.cargarConfig();
    const hoy = hoyAr();
    const info = meta(hoy);
    const { base } = await historiaDesdeOdoo(Math.max(regla.dias_max + 1, HISTORIA_DIAS_MIN), refresh);

    const candidatos = [];
    for (const c of base) {
        const m = inactivos.metricas(c, hoy);
        if (inactivos.cumpleRegla(m, regla)) candidatos.push({ c, m });
    }
    const ids = candidatos.map((x) => x.c.id);
    const segs = await seguimientos(ids);
    const convs = await conversaciones(ids);
    const reservas = await reservasActivas(ids);
    const sis = await segInactivos(ids);
    // Pedidos activos en vivo (fuera de la caché), como en importantes
    const pedidosMap = await odoo(() => pedidosActivosOdoo(ids, hoy));

    const excluidos = { manual: 0, pedido_activo: 0, en_flujo_nuevos: 0, es_importante: 0 };
    const lista = [];
    for (const { c, m } of candidatos) {
        const row = segs.get(c.id);
        const si = sis.get(c.id) || null;
        const imp = importantes.evaluarCliente(c, {
            hoy,
            dias: impCfg.dias,
            monto_minimo: impCfg.monto_minimo,
            monto_pedido_minimo: impCfg.monto_pedido_minimo,
            dias_pedido: impCfg.dias_pedido,
            min_compras_intervalo: impCfg.min_compras_intervalo,
        }, null);
        const motivo = inactivos.motivoExclusion({
            marca: formatMarca(si),
            pedidoActivo: pedidosMap.has(c.id),
            enFlujoNuevos: enCadenciaNuevos(c.fecha_primera_compra, row, hoy),
            esImportante: imp.motivo_importante.length > 0,
        });
        if (motivo) {
            excluidos[motivo] += 1;
            continue;
        }
        lista.push(armarClienteInactivo(c, m, row, convs.get(c.id), reservas.get(c.id) || null, si, hoy, info.ventana_abierta, cfg));
    }
    return { lista, excluidos, base, hoy, info };
}

/** GET clientes/inactivos. */
async function listarInactivos(query) {
    const { dias_min, dias_max, monto_historico_min, compras_min, orden, page, limit, offset, refresh } = query;
    const regla = { dias_min, dias_max, monto_historico_min, compras_min };
    const { lista, excluidos, info } = await evaluarInactivos(regla, refresh);
    const filtrada = inactivos.ordenar(inactivos.filtrar(lista, query), orden);
    return {
        data: filtrada.slice(offset, offset + limit),
        total: filtrada.length,
        page,
        limit,
        meta: { ...info, filtros: regla, excluidos },
    };
}

/** GET clientes/inactivos/resumen: el tablero del día. */
async function resumenInactivos(query) {
    const { dias_min, dias_max, monto_historico_min, compras_min, refresh } = query;
    const regla = { dias_min, dias_max, monto_historico_min, compras_min };
    const { lista, excluidos, base, hoy, info } = await evaluarInactivos(regla, refresh);
    // Toques confirmados de los últimos 60 días: los que pueden tener una compra en los últimos 30
    const { rows } = await pool.query(
        `SELECT odoo_partner_id AS id, fecha FROM crm_bot_interacciones
         WHERE flujo = 'inactivos' AND envio_etapa AND estado = 'enviado' AND fecha >= NOW() - INTERVAL '60 days'`);
    const compras = new Map(base.map((c) => [c.id, c.compras]));
    const recuperados = inactivos.recuperados(rows, compras, hoy);
    return { data: inactivos.resumir(lista, excluidos, recuperados), meta: { ...info, filtros: regla } };
}

async function exigirSinReservaActiva(db, id) {
    const { rows: [r] } = await db.query(
        `SELECT id_externo FROM crm_bot_interacciones
         WHERE odoo_partner_id = $1 AND envio_etapa AND estado = 'reservado' AND reservado_hasta >= NOW() LIMIT 1`, [id]);
    if (r) throw new AgenteError(409, `El cliente ya tiene una reserva activa (${r.id_externo}): confirmala o cancelala primero`, 'etapa_reservada');
}

const MENSAJES_EXCLUSION = {
    manual: 'Está excluido a mano del seguimiento de inactivos',
    pedido_activo: 'Tiene un pedido activo (sin entregar o sin cobrar del todo)',
    en_flujo_nuevos: 'Está en la cadencia de clientes nuevos',
    es_importante: 'Hoy califica como cliente importante: ese flujo tiene prioridad',
};

/** Por qué un cliente no es inactivo, para leer. */
function motivoNoInactivo(ev, regla) {
    if (ev.motivo_exclusion) return MENSAJES_EXCLUSION[ev.motivo_exclusion];
    const dias = ev.m.dias_sin_comprar;
    if (dias === null) return 'El cliente no tiene compras';
    if (dias <= regla.dias_min || dias > regla.dias_max) {
        return `No es inactivo: ${dias} días sin comprar (tiene que ser más de ${regla.dias_min} y hasta ${regla.dias_max})`;
    }
    return `No es inactivo: no llega a ${regla.compras_min} compras o a $${regla.monto_historico_min} de total histórico`;
}

/** POST clientes/:id/envios con tipo_inactivo: reserva un toque de inactivos. */
async function reservarEnvioInactivo(cliente, value) {
    const { id } = cliente;
    const ahora = new Date();
    if (!nuevos.ventanaAbierta(ahora)) {
        throw new AgenteError(409, `Fuera del horario de envío: ${nuevos.VENTANA_ENVIO.texto}. Abre: ${nuevos.abreA(ahora)}`, 'fuera_de_horario');
    }
    const ficha = await odoo(() => fichaOdoo(id));
    if (!ficha.telefono) throw new AgenteError(409, 'El cliente no tiene un celular válido en Odoo', 'sin_telefono');
    const hoy = hoyAr();
    const cfg = inactivos.cargarConfig();
    const pedidosMap = await odoo(() => pedidosActivosOdoo([id], hoy));
    const esImportante = importantes.resumenImportante(ficha, importantes.cargarConfig(), hoy, null).es_importante;
    try {
        const r = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, id);
            if (seg.no_contactar) throw new AgenteError(409, 'El cliente pidió no recibir mensajes', 'no_contactar');
            await vencerReservas(db, id);
            await exigirSinReservaActiva(db, id);
            const si = (await segInactivos([id], db)).get(id) || null;
            const enFlujoNuevos = enCadenciaNuevos(ficha.fecha_primera_compra, seg, hoy);
            if (enFlujoNuevos) throw new AgenteError(409, MENSAJES_EXCLUSION.en_flujo_nuevos, 'en_flujo_nuevos');
            const ev = evaluarInactivo(ficha, { regla: cfg, hoy, si, pedidoActivo: pedidosMap.has(id), enFlujoNuevos, esImportante });
            if (!ev.es_inactivo) throw new AgenteError(409, motivoNoInactivo(ev, cfg), 'no_es_inactivo');
            const conv = (await conversaciones([id], db)).get(id);
            const estado = estadoInactivo({ base: ficha, m: ev.m, row: seg, conv, reserva: null, si, hoy, ventanaAbierta: true, esInactivo: true, cfg });
            if (estado._codigo && estado._codigo !== 'todavia_no') {
                throw new AgenteError(409, estado.motivo_toca_hoy, estado._codigo);
            }
            if (value.tipo_inactivo !== estado.toca_hoy) {
                throw new AgenteError(409, estado.toca_hoy
                    ? `Hoy no le toca ${value.tipo_inactivo}: le toca ${estado.toca_hoy}`
                    : `Hoy no le toca ningún toque de inactivos: ${estado.motivo_toca_hoy}`, 'tipo_no_corresponde');
            }
            const { rows: [row] } = await db.query(
                `INSERT INTO crm_bot_interacciones
                    (odoo_partner_id, fecha, tipo, etapa, mensaje, id_externo, envio_etapa, estado, reservado_hasta,
                     productos_recomendados, flujo, tipo_inactivo, ciclo_desde)
                 VALUES ($1, NOW(), 'enviado', NULL, $2, $3, true, 'reservado', NOW() + ($4::int * INTERVAL '1 second'),
                         $5, 'inactivos', $6, $7)
                 RETURNING *`,
                [id, value.mensaje, value.id_externo, nuevos.RESERVA_SEGUNDOS, value.productos_recomendados,
                    value.tipo_inactivo, ev.m.ultima_fecha]);
            return row;
        });
        console.log(`📦 Agente: reserva ${value.tipo_inactivo} (inactivos) para ${id} (${value.id_externo})`);
        return respuestaEnvio(cliente, r, false);
    } catch (err) {
        if (!esDuplicado(err)) throw err;
        const r = await porIdExterno(pool, id, value.id_externo);
        if (r) return respuestaEnvio(cliente, r, true);
        throw new AgenteError(409, `El ${value.tipo_inactivo} de este ciclo ya está reservado o enviado`, 'etapa_reservada');
    }
}

/**
 * Suma el toque confirmado al ciclo. Si el envío es de un ciclo viejo (el cliente volvió a
 * comprar en el medio), no toca el ciclo nuevo.
 */
async function avanzarCicloInactivo(db, id, { ciclo, tipo, fecha }) {
    const cfg = inactivos.cargarConfig();
    const prev = await lockSegInactivo(db, id);
    if (prev.ciclo_desde_compra && ciclo && prev.ciclo_desde_compra > ciclo) return;
    const mismo = prev.ciclo_desde_compra === ciclo;
    const n = inactivos.numeroToque(tipo);
    const toques = Math.max(mismo ? Number(prev.toques_enviados) || 0 : 0, n);
    const ultimo = mismo && prev.ultimo_contacto && new Date(prev.ultimo_contacto) > new Date(fecha) ? prev.ultimo_contacto : fecha;
    const cerrado = toques >= cfg.max_toques || (mismo && prev.cerrado);
    const proxima = cerrado ? null : health.addDays(health.toArDate(new Date(ultimo)), cfg.reintento_dias);
    await db.query(
        `UPDATE crm_bot_seguimiento_inactivo
         SET ciclo_desde_compra = $2, toques_enviados = $3, ultimo_contacto = $4, ultimo_tipo = $5,
             proxima_accion = $6, cerrado = $7, updated_at = NOW()
         WHERE odoo_partner_id = $1`,
        [id, ciclo, toques, ultimo, inactivos.TIPOS[toques - 1], proxima, cerrado]);
}

async function confirmarEnvioInactivo(cliente, previa, enviadoAt) {
    const r = await enTransaccion(async (db) => {
        await lockSeguimiento(db, cliente.id);
        const { rows: [row] } = await db.query(
            `UPDATE crm_bot_interacciones SET estado = 'enviado', fecha = COALESCE($2, NOW()), reservado_hasta = NULL, motivo_cancelacion = NULL
             WHERE id = $1 AND (estado IN ('reservado', 'vencido') OR (estado = 'cancelado' AND motivo_cancelacion = 'no_contactar'))
             RETURNING *, ciclo_desde::text AS ciclo_texto`, [previa.id, enviadoAt]);
        if (!row) throw new AgenteError(409, 'El envío cambió de estado mientras se confirmaba', 'reserva_cancelada');
        await db.query(
            `UPDATE crm_bot_seguimiento SET ultimo_contacto = GREATEST(ultimo_contacto, $2), updated_at = NOW()
             WHERE odoo_partner_id = $1`, [cliente.id, row.fecha]);
        await avanzarCicloInactivo(db, cliente.id, { ciclo: row.ciclo_texto, tipo: row.tipo_inactivo, fecha: row.fecha });
        return row;
    });
    console.log(`✅ Agente: ${r.tipo_inactivo} (inactivos) confirmado para ${cliente.id}`);
    return respuestaEnvio(cliente, r, false);
}

function formatSeguimientoInactivoRow(si) {
    return {
        ciclo_desde_compra: si ? si.ciclo_desde_compra || null : null,
        toques_enviados: si ? Number(si.toques_enviados) || 0 : 0,
        ultimo_contacto: si && si.ultimo_contacto ? nuevos.toArIso(si.ultimo_contacto) : null,
        ultimo_tipo: si ? si.ultimo_tipo || null : null,
        proxima_accion: si ? si.proxima_accion || null : null,
        cerrado: Boolean(si && si.cerrado),
        actualizado: si && si.updated_at ? nuevos.toArIso(si.updated_at) : null,
    };
}

/**
 * PATCH clientes/:id/inactivo: { marca: 'excluido' | null, nota }. Saca (o vuelve a meter) al
 * cliente de la lista. Queda en la ficha del cliente (crm_events). Misma marca y nota → repetido.
 */
async function marcarInactivo(id, { marca, nota }) {
    const cliente = await exigirCliente(id);
    const out = await enTransaccion(async (db) => {
        await lockSeguimiento(db, id);
        const prev = await lockSegInactivo(db, id);
        const igual = (prev.marca || null) === marca && (marca === null || (prev.marca_nota || null) === nota);
        if (igual) return { si: prev, repetido: true };
        await db.query(
            `UPDATE crm_bot_seguimiento_inactivo SET marca = $2, marca_nota = $3, marca_at = NOW(), updated_at = NOW()
             WHERE odoo_partner_id = $1`, [id, marca, marca ? nota : null]);
        const texto = marca
            ? `Excluido del seguimiento de inactivos (Grok Bot): ${nota}`
            : `Vuelve al seguimiento de inactivos (Grok Bot)${nota ? `: ${nota}` : ''}`;
        await db.query(
            `INSERT INTO crm_events (odoo_partner_id, kind, text, meta, user_id) VALUES ($1, 'nota', $2, $3, NULL)`,
            [id, texto, JSON.stringify({ origen: 'agente', flujo: 'inactivos', marca, nota })]);
        return { si: (await segInactivos([id], db)).get(id), repetido: false };
    });
    if (!out.repetido) console.log(`✅ Agente: cliente ${id} ${marca ? 'excluido de' : 'vuelve a'} inactivos`);
    return {
        data: { id, nombre: cliente.nombre, marca_manual: formatMarca(out.si), seguimiento_inactivo: formatSeguimientoInactivoRow(out.si) },
        repetido: out.repetido,
    };
}

/**
 * PATCH clientes/:id/seguimiento-inactivo: corrige a mano el ciclo actual. ultimo_contacto
 * nunca retrocede. Si el ciclo guardado es de una compra vieja, se arranca el de la última compra.
 */
async function actualizarSeguimientoInactivo(id, value) {
    const cliente = await exigirCliente(id);
    const ficha = await odoo(() => fichaOdoo(id));
    const m = inactivos.metricas(ficha, hoyAr());
    if (!m.ultima_fecha) throw new AgenteError(409, 'El cliente no tiene compras', 'no_es_inactivo');
    const si = await enTransaccion(async (db) => {
        await lockSeguimiento(db, id);
        const prev = await lockSegInactivo(db, id);
        const ciclo = inactivos.cicloActual(prev, m.ultima_fecha);
        const toques = 'toques_enviados' in value ? value.toques_enviados : ciclo.toques_enviados;
        let ultimo = ciclo.ultimo_contacto;
        if (value.ultimo_contacto && (!ultimo || value.ultimo_contacto > new Date(ultimo))) ultimo = value.ultimo_contacto;
        const tipo = toques === ciclo.toques_enviados && ciclo.ultimo_tipo ? ciclo.ultimo_tipo : (inactivos.TIPOS[toques - 1] || null);
        await db.query(
            `UPDATE crm_bot_seguimiento_inactivo
             SET ciclo_desde_compra = $2, toques_enviados = $3, ultimo_contacto = $4, ultimo_tipo = $5,
                 proxima_accion = $6, cerrado = $7, updated_at = NOW()
             WHERE odoo_partner_id = $1`,
            [id, m.ultima_fecha, toques, ultimo, tipo,
                'proxima_accion' in value ? value.proxima_accion : ciclo.proxima_accion,
                'cerrado' in value ? value.cerrado : ciclo.cerrado]);
        return (await segInactivos([id], db)).get(id);
    });
    return { id, nombre: cliente.nombre, marca_manual: formatMarca(si), seguimiento_inactivo: formatSeguimientoInactivoRow(si) };
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
            categoria: labels.get(r.categ_name) || r.categ_name || null,
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

// El feedback del bot también entra como nota de prueba de la pantalla del módulo, para
// verlo en el panel «Notas» y mandarlo a Claude. Entra en modo DEBATIR: una idea del bot
// no se implementa sin que el equipo la mire.
const FEEDBACK_NOTA = {
    clientes:   { ruta: '/clientes',   pantalla: 'Clientes · Bot de seguimiento', autor: 'Bot de seguimiento' },
    reposicion: { ruta: '/reposicion', pantalla: 'Reposición · Bot',              autor: 'Bot de reposición' },
};
const FEEDBACK_TIPO_NOTA = { error: 'error', falta: 'mejora', mejora: 'mejora', comentario: 'duda' };

function notaDeFeedback({ id, tipo, modulo, endpoint, mensaje }) {
    const destino = FEEDBACK_NOTA[modulo] || FEEDBACK_NOTA.clientes;
    return {
        tipo: FEEDBACK_TIPO_NOTA[tipo] || 'mejora',
        texto: `[Feedback del bot · ${tipo}${endpoint ? ` · ${endpoint}` : ''}]\n${mensaje}`,
        modo: ['debatir'],
        ruta: destino.ruta,
        pantalla: destino.pantalla,
        contexto: { origen: 'agente', autor: destino.autor, feedback: { id, tipo, modulo, endpoint } },
    };
}

async function registrarFeedback({ tipo, modulo = 'clientes', endpoint, mensaje }) {
    await ensureSchema();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [r] } = await client.query(
            'INSERT INTO crm_bot_feedback (tipo, endpoint, mensaje) VALUES ($1, $2, $3) RETURNING *',
            [tipo, endpoint, mensaje]);
        const nota = await testNotes.crear(client, notaDeFeedback({ id: r.id, tipo, modulo, endpoint, mensaje }), null);
        await client.query('COMMIT');
        console.log(`📦 Agente: feedback nuevo (${tipo}, ${modulo}) ${endpoint || ''} → nota #${nota.id}`);
        return { id: r.id, tipo: r.tipo, modulo, endpoint: r.endpoint, mensaje: r.mensaje, nota_id: nota.id, fecha: nuevos.toArIso(r.created_at) };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
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
    listarImportantes,
    listarInactivos,
    resumenInactivos,
    marcarInactivo,
    actualizarSeguimientoInactivo,
    obtenerCliente,
    listarCotizacionesWeb,
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
    // Puro, para tests
    notaDeFeedback,
};
