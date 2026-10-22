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
        if (err instanceof AgenteError) throw err;
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
                           no_contactar, no_contactar_at, contacto, updated_at
                    FROM crm_bot_seguimiento`;

async function seguimientos(ids, db = pool) {
    const { rows } = await db.query(`${SEG_SELECT} WHERE odoo_partner_id = ANY($1::int[])`, [ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, r]));
}

/** Cliente completo: lo de Odoo + lo local + qué le toca hoy. Mismo formato en la lista y en la ficha. */
function armarCliente(base, row, hoy, ventanaAbierta) {
    const noContactar = Boolean(row && row.no_contactar);
    const seguimiento = formatSeguimiento(row);
    const toca = nuevos.tocaHoy({ fechaPrimeraCompra: base.fecha_primera_compra, hoy, etapa: seguimiento.etapa, noContactar });
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
        puede_enviar_ahora: Boolean(toca && base.telefono && ventanaAbierta),
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
    };
}

/** GET clientes/nuevos. */
async function listarNuevos({ dias, etapa, no_contactar: noContactar, para_hoy: paraHoy, page, limit, offset, refresh }) {
    await ensureSchema();
    const base = await nuevosDesdeOdoo(dias, refresh);
    const segs = await seguimientos(base.map((c) => c.id));
    const hoy = hoyAr();
    const info = meta(hoy);
    let lista = base.map((c) => armarCliente(c, segs.get(c.id), hoy, info.ventana_abierta));
    if (etapa) lista = lista.filter((c) => c.seguimiento.etapa === etapa);
    if (noContactar !== null && noContactar !== undefined) lista = lista.filter((c) => c.no_contactar === noContactar);
    if (paraHoy !== undefined) lista = lista.filter((c) => Boolean(c.toca_hoy) === paraHoy);
    return { data: lista.slice(offset, offset + limit), total: lista.length, page, limit, meta: info };
}

/** GET clientes/:id: en vivo y sin caché, para chequear justo antes de mandar. */
async function obtenerCliente(id) {
    await exigirCliente(id);
    const ficha = await odoo(() => fichaOdoo(id));
    const row = (await seguimientos([id])).get(id);
    const hoy = hoyAr();
    const info = meta(hoy);
    return { data: armarCliente(ficha, row, hoy, info.ventana_abierta), meta: info };
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
        if (error) throw new AgenteError(409, error);
        const etapa = value.etapa || prev.etapa;
        if ((prev.no_contactar || etapa === 'finalizado') && value.proxima_accion) {
            throw new AgenteError(409, 'Un cliente finalizado o que pidió no recibir mensajes no lleva próxima acción');
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
            throw new AgenteError(409, 'El cliente pidió no recibir mensajes: solo lo puede desmarcar el equipo de Neggo');
        }
        const sets = ['updated_at = NOW()'];
        const params = [id];
        if ('contacto' in value) {
            params.push(value.contacto);
            sets.push(`contacto = $${params.length}`);
        }
        if (value.no_contactar === true && !prev.no_contactar) {
            sets.push('no_contactar = true', 'no_contactar_at = NOW()', "etapa = 'finalizado'", 'proxima_accion = NULL');
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
        mensaje: r.mensaje,
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
    if (r.odoo_partner_id !== id) throw new AgenteError(409, 'Ese id_externo ya se usó con otro cliente');
    return r;
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
            if (repetida) return { data: formatInteraccion(repetida), repetida: true };
            const seg = await lockSeguimiento(db, id);
            if (value.tipo === 'enviado' && seg.no_contactar) throw new AgenteError(409, 'El cliente pidió no recibir mensajes');
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

/**
 * POST clientes/:id/envios. Registra el mensaje de una etapa de la cadencia en una sola
 * transacción: chequea horario, no contactar y que esa etapa sea la que toca hoy, guarda el
 * mensaje, avanza la etapa y calcula la próxima acción. Con el mismo id_externo no se duplica.
 */
async function registrarEnvio(id, value) {
    const cliente = await exigirCliente(id);
    const repetida = await porIdExterno(pool, id, value.id_externo);
    if (repetida) {
        const row = (await seguimientos([id])).get(id);
        return { data: { envio: formatInteraccion(repetida), cliente: await estadoCliente(cliente, row) }, repetida: true };
    }
    if (!nuevos.ventanaAbierta(value.fecha)) {
        throw new AgenteError(409, `Fuera del horario de envío: ${nuevos.VENTANA_ENVIO.texto}`);
    }
    const ficha = await odoo(() => fichaOdoo(id));
    const hoy = hoyAr();
    try {
        const out = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, id);
            if (seg.no_contactar) throw new AgenteError(409, 'El cliente pidió no recibir mensajes');
            const toca = nuevos.tocaHoy({ fechaPrimeraCompra: ficha.fecha_primera_compra, hoy, etapa: seg.etapa, noContactar: false });
            if (value.etapa !== toca) {
                const dia = ficha.fecha_primera_compra ? health.daysBetween(ficha.fecha_primera_compra, hoy) : '-';
                throw new AgenteError(409, toca
                    ? `Hoy no le toca ${value.etapa}: le toca ${toca}`
                    : `Hoy no le toca ningún mensaje de la cadencia (etapa ${seg.etapa}, día ${dia})`);
            }
            const { rows: [row] } = await db.query(
                `INSERT INTO crm_bot_interacciones (odoo_partner_id, fecha, tipo, etapa, mensaje, id_externo, envio_etapa)
                 VALUES ($1, $2, 'enviado', $3, $4, $5, true) RETURNING *`,
                [id, value.fecha, value.etapa, value.mensaje, value.id_externo]);
            await db.query(
                `UPDATE crm_bot_seguimiento
                 SET etapa = $2, proxima_accion = $3, ultimo_contacto = GREATEST(ultimo_contacto, $4), updated_at = NOW()
                 WHERE odoo_partner_id = $1`,
                [id, value.etapa, nuevos.proximaAccion(ficha.fecha_primera_compra, value.etapa), value.fecha]);
            return { row, seg: (await seguimientos([id], db)).get(id) };
        });
        console.log(`📦 Agente: envío ${value.etapa} a ${id}`);
        return { data: { envio: formatInteraccion(out.row), cliente: await estadoCliente(cliente, out.seg) }, repetida: false };
    } catch (err) {
        if (!esDuplicado(err)) throw err;
        // Mismo id_externo en paralelo: devuelve el que se guardó. Si no, esa etapa ya se mandó
        const r = await porIdExterno(pool, id, value.id_externo);
        if (r) {
            const row = (await seguimientos([id])).get(id);
            return { data: { envio: formatInteraccion(r), cliente: await estadoCliente(cliente, row) }, repetida: true };
        }
        throw new AgenteError(409, `La etapa ${value.etapa} ya se envió a este cliente`);
    }
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

// Unidades vendidas por producto en los últimos 90 días (tickets del POS de Neggo), caché de 6 h
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
        if (pid) data.set(pid, (data.get(pid) || 0) + (Number(l.qty) || 0));
    }
    vendidosCache = { at: Date.now(), data };
    console.log(`📦 Agente: ventas de ${VENDIDOS_DIAS} días cargadas (${data.size} productos)`);
    return data;
}

/**
 * GET productos. Neggo no lleva stock en Odoo: archivar = agotado. Por eso "con stock" es
 * activo y no archivado en la app; stock=false devuelve los agotados. El precio es el final.
 */
async function listarProductos({ rubro, stock, q, solo_publicados: soloPublicados, orden, excluir_compras_de: excluirDe, page, limit, offset }) {
    const nombres = await categoriasDeProductos();
    const labels = health.rubroLabels(nombres);

    const where = ['p.company = $1', 'p.list_price > 0'];
    const params = [COMPANY];
    where.push(stock === false
        ? '(p.active = false OR p.locally_archived = true)'
        : '(p.active = true AND p.locally_archived = false)');
    if (rubro) {
        const key = health.rubroKey(rubro);
        const match = key ? nombres.filter((n) => health.rubroKey(n) === key) : [];
        if (!match.length) return { data: [], total: 0, page, limit };
        params.push(match);
        where.push(`p.categ_name = ANY($${params.length}::text[])`);
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
    if (orden === 'vendidos') {
        try {
            vendidos = await vendidos90();
        } catch (err) {
            console.warn(`⚠️ Agente: no pude leer las ventas para ordenar: ${err.message}`);
        }
    }
    const disponible = '(p.active = true AND p.locally_archived = false)';
    const ordenSql = orden === 'vendidos'
        ? `${disponible} DESC, COALESCE(v.qty, 0) DESC, p.name ASC, p.odoo_id ASC`
        : `${disponible} DESC, p.name ASC, p.odoo_id ASC`;
    const qParams = [...params, [...vendidos.keys()], [...vendidos.values()]];
    const { rows } = await pool.query(
        `SELECT p.odoo_id, p.name, p.list_price, p.categ_name, p.template_id, p.is_published,
                ${disponible} AS stock, COALESCE(v.qty, 0) AS vendidos
         FROM odoo_products_cache p
         LEFT JOIN unnest($${qParams.length - 1}::int[], $${qParams.length}::numeric[]) AS v(pid, qty) ON v.pid = p.odoo_id
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
    registrarEnvio,
    listarInteracciones,
    listarProductos,
    registrarFeedback,
    listarFeedback,
};
