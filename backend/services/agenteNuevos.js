// API del agente (Grok Bot): cálculo de clientes nuevos a partir de los tickets del POS.
// Lógica pura, sin base ni Odoo. Tests en agenteNuevos.test.js.
// Compra = ticket del POS de Neggo en paid/done/invoiced (misma definición que el CRM).
// Los tickets que cobran un mismo pedido de venta (seña y saldo) son una sola compra.

const health = require('./clientHealth');

const ETAPAS = ['pendiente', 'dia_1', 'dia_7', 'dia_15', 'finalizado'];
const POS_STATES = ['paid', 'done', 'invoiced'];
const DIAS_DEFAULT = 15;
const DIAS_MAX = 90;
// No son clientes: mismas cuentas que excluye el CRM (EXCLUDED_NAMES y GENERIC_NAMES)
const NOMBRES_EXCLUIDOS = ['rma', 'consumidor final'];

const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

function m2oId(value) {
    return Array.isArray(value) ? value[0] : value || null;
}

function m2oName(value) {
    return Array.isArray(value) ? value[1] : null;
}

function normName(name) {
    return String(name || '').trim().toLowerCase();
}

/** Milisegundos UTC de un datetime de Odoo ("2026-10-20 20:41:28", en UTC) o de un Date. */
function odooMs(value) {
    if (!value) return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    return Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
}

/** Datetime en ISO 8601 con el offset de Argentina: 2026-10-10T16:20:00-03:00. */
function toArIso(value) {
    const ms = odooMs(value);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 19) + '-03:00';
}

/** Primer día de la ventana (inclusive): hoy y los dias - 1 anteriores. */
function desdeVentana(hoy, dias) {
    return health.addDays(hoy, -(dias - 1));
}

/** El mismo día a las 00:00 de Argentina, en UTC y con el formato de Odoo. */
function inicioDiaUtc(fecha) {
    return `${fecha} 03:00:00`;
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function esExcluido(nombre) {
    return NOMBRES_EXCLUIDOS.includes(normName(nombre));
}

/**
 * Tickets de los clientes cuya primera compra cae en la ventana. Sirve para leer
 * las líneas solo de esos tickets y no de toda la historia de los clientes viejos.
 */
function ticketsDeNuevos({ tickets, hoy, dias }) {
    const desde = desdeVentana(hoy, dias);
    const primera = new Map();
    for (const t of tickets) {
        const pid = m2oId(t.partner_id);
        const fecha = health.toArDate(t.date_order);
        if (!pid || !fecha) continue;
        if (!primera.has(pid) || fecha < primera.get(pid)) primera.set(pid, fecha);
    }
    return tickets.filter((t) => {
        const pid = m2oId(t.partner_id);
        return pid && primera.get(pid) >= desde && !esExcluido(m2oName(t.partner_id));
    });
}

/** Productos de una compra: mismas líneas de producto y precio se juntan en una. */
function armarProductos(lineas) {
    const porClave = new Map();
    for (const l of lineas) {
        const id = m2oId(l.product_id);
        const qty = Number(l.qty) || 0;
        if (!id || !qty) continue;
        const total = Number(l.price_subtotal_incl) || 0;
        const precio = round2(total / qty);
        const clave = `${id}|${precio}`;
        const prev = porClave.get(clave) || { id, nombre: m2oName(l.product_id), cantidad: 0, precio };
        prev.cantidad += qty;
        porClave.set(clave, prev);
    }
    return [...porClave.values()].map((p) => ({ ...p, cantidad: round2(p.cantidad) }));
}

const ESTADOS = { paid: 'pagado', done: 'pagado', invoiced: 'facturado' };

/**
 * Clientes nuevos: primera compra válida (en toda la historia) dentro de los últimos `dias` días.
 * @param {{ tickets: object[], lineas: object[], hoy: string, dias: number }} input
 *   tickets: pos.order con id, name, pos_reference, partner_id, date_order, amount_total, state
 *            y sale_order_origin_id (m2o del pedido que cobra, o false).
 *   lineas: como las arma readPosLines (las del pedido van en el primer ticket que lo cobra).
 * @returns {object[]} un elemento por cliente, ordenado por fecha_primera_compra desc y id
 */
function calcularClientesNuevos({ tickets, lineas = [], hoy, dias = DIAS_DEFAULT }) {
    const desde = desdeVentana(hoy, dias);
    const lineasPorTicket = new Map();
    for (const l of lineas) {
        const tid = m2oId(l.order_id);
        if (!lineasPorTicket.has(tid)) lineasPorTicket.set(tid, []);
        lineasPorTicket.get(tid).push(l);
    }

    // Agrupa los tickets en compras: los que cobran el mismo pedido son una sola
    const comprasPorCliente = new Map();
    const nombres = new Map();
    for (const t of tickets) {
        const pid = m2oId(t.partner_id);
        const ms = odooMs(t.date_order);
        if (!pid || Number.isNaN(ms) || !POS_STATES.includes(t.state || 'paid')) continue;
        nombres.set(pid, m2oName(t.partner_id));
        const saleId = m2oId(t.sale_order_origin_id);
        const clave = saleId ? `venta-${saleId}` : `pos-${t.id}`;
        if (!comprasPorCliente.has(pid)) comprasPorCliente.set(pid, new Map());
        const compras = comprasPorCliente.get(pid);
        if (!compras.has(clave)) {
            compras.set(clave, { clave, saleId, saleName: m2oName(t.sale_order_origin_id), tickets: [] });
        }
        compras.get(clave).tickets.push({ ...t, ms });
    }

    const out = [];
    for (const [pid, compras] of comprasPorCliente) {
        if (esExcluido(nombres.get(pid))) continue;
        const lista = [...compras.values()].map((c) => {
            const ts = c.tickets.sort((a, b) => a.ms - b.ms || a.id - b.id);
            const primero = ts[0];
            const ultimo = ts[ts.length - 1];
            const agrupada = ts.length > 1;
            return {
                id: agrupada ? `venta-${c.saleId}` : `pos-${primero.id}`,
                referencia: agrupada ? (c.saleName || `Pedido ${c.saleId}`) : (primero.pos_reference || primero.name || `Ticket ${primero.id}`),
                fecha: toArIso(primero.ms),
                monto: round2(ts.reduce((s, t) => s + (Number(t.amount_total) || 0), 0)),
                estado: ESTADOS[ultimo.state] || 'pagado',
                productos: armarProductos(ts.flatMap((t) => lineasPorTicket.get(t.id) || [])),
                _ms: primero.ms,
            };
        });
        lista.sort((a, b) => b._ms - a._ms);
        const primeraFecha = health.toArDate(new Date(lista[lista.length - 1]._ms));
        if (primeraFecha < desde) continue;
        out.push({
            id: pid,
            nombre: nombres.get(pid) || `Cliente ${pid}`,
            fecha_primera_compra: primeraFecha,
            cantidad_compras: lista.length,
            compras: lista.map(({ _ms, ...c }) => c),
        });
    }
    out.sort((a, b) => b.fecha_primera_compra.localeCompare(a.fecha_primera_compra) || a.id - b.id);
    return out;
}

module.exports = {
    ETAPAS,
    POS_STATES,
    DIAS_DEFAULT,
    DIAS_MAX,
    NOMBRES_EXCLUIDOS,
    m2oId,
    m2oName,
    toArIso,
    desdeVentana,
    inicioDiaUtc,
    ticketsDeNuevos,
    armarProductos,
    calcularClientesNuevos,
};
