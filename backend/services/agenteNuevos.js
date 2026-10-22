// API del agente (Grok Bot): cálculo de clientes nuevos y de la cadencia de mensajes.
// Lógica pura, sin base ni Odoo. Tests en agenteNuevos.test.js.
// Compra = ticket del POS de Neggo en paid/done/invoiced (misma definición que el CRM).
// Los tickets que cobran un mismo pedido de venta (seña y saldo) son una sola compra.
//
// Cadencia: día N = fecha de la primera compra + N (en hora de Argentina). La etapa guardada
// es la ÚLTIMA ENVIADA: pendiente (nada todavía) → dia_1 → dia_7 → dia_15. finalizado = cerrado
// (no contactar o lo cerró el equipo). Si el cliente vuelve a comprar, la cadencia sigue igual.

const health = require('./clientHealth');

const ETAPAS = ['pendiente', 'dia_1', 'dia_7', 'dia_15', 'finalizado'];
const POS_STATES = ['paid', 'done', 'invoiced'];
// Cada etapa se puede mandar desde su día hasta el día anterior a la siguiente. El día 15 tiene
// margen hasta el 20 para cubrir fines de semana y feriados (solo se manda de lunes a viernes).
const CADENCIA = [
    { etapa: 'dia_1', desde: 1, hasta: 6 },
    { etapa: 'dia_7', desde: 7, hasta: 14 },
    { etapa: 'dia_15', desde: 15, hasta: 20 },
];
// Por defecto la ventana cubre hasta el último día en que se puede mandar el día 15
const DIAS_DEFAULT = 21;
const DIAS_MAX = 90;
// Horario de envío (Argentina): lunes a viernes de 9 a 18
const VENTANA_ENVIO = { dias: [1, 2, 3, 4, 5], desde: 9, hasta: 18, texto: 'lunes a viernes de 9 a 18 (hora de Argentina)' };
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

/** Nombre de producto sin el código interno que Odoo pone adelante: "[BB88150] Cable" → "Cable". */
function limpiarNombre(nombre) {
    return String(nombre || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
}

// =============================================
// Cadencia
// =============================================

function ordenEtapa(etapa) {
    return ETAPAS.indexOf(etapa);
}

/**
 * Qué mensaje le toca hoy al cliente: la última etapa de la cadencia cuyo rango de días
 * incluye hoy y que todavía no se mandó. Si entra tarde (por ejemplo, el día 9) le toca el
 * día 7 y el día 1 se saltea. Null si no le toca nada.
 */
function tocaHoy({ fechaPrimeraCompra, hoy, etapa = 'pendiente', noContactar = false }) {
    if (!fechaPrimeraCompra || noContactar || etapa === 'finalizado') return null;
    const dias = health.daysBetween(fechaPrimeraCompra, hoy);
    const paso = CADENCIA.find((p) => dias >= p.desde && dias <= p.hasta);
    if (!paso || ordenEtapa(paso.etapa) <= ordenEtapa(etapa)) return null;
    return paso.etapa;
}

/** Fecha en que se puede mandar el mensaje siguiente a `etapaEnviada`, o null si no hay más. */
function proximaAccion(fechaPrimeraCompra, etapaEnviada) {
    if (!fechaPrimeraCompra) return null;
    const i = CADENCIA.findIndex((p) => p.etapa === etapaEnviada);
    const siguiente = etapaEnviada === 'pendiente' ? CADENCIA[0] : (i >= 0 ? CADENCIA[i + 1] : null);
    return siguiente ? health.addDays(fechaPrimeraCompra, siguiente.desde) : null;
}

/** true si `fecha` cae en el horario de envío (lunes a viernes, 9 a 18, hora de Argentina). */
function ventanaAbierta(fecha = new Date()) {
    const ar = new Date(fecha.getTime() + AR_OFFSET_MS);
    const hora = ar.getUTCHours() + ar.getUTCMinutes() / 60;
    return VENTANA_ENVIO.dias.includes(ar.getUTCDay()) && hora >= VENTANA_ENVIO.desde && hora < VENTANA_ENVIO.hasta;
}

/**
 * Cambio de etapa pedido por PATCH seguimiento. Devuelve un mensaje de error (409) o null si vale.
 * Solo se avanza; nunca se sale de finalizado; con no contactar solo se puede finalizar.
 */
function errorTransicion({ actual = 'pendiente', nueva, noContactar = false }) {
    if (nueva === undefined || nueva === actual) return null;
    if (noContactar && nueva !== 'finalizado') return 'El cliente pidió no recibir mensajes: la etapa solo puede ser finalizado';
    if (actual === 'finalizado') return 'La cadencia ya está finalizada';
    if (ordenEtapa(nueva) < ordenEtapa(actual)) return `No se puede volver de ${actual} a ${nueva}`;
    return null;
}

// =============================================
// Rubro
// =============================================

/**
 * Rubro con la regla del módulo comercial (topRubro: la categoría en la que más gastó), para un
 * cliente que todavía no está en el cálculo diario.
 */
function rubroDeCompras(compras, rubroPorProducto) {
    return health.topRubro(compras.flatMap((c) => c.productos.map((p) => ({
        category: rubroPorProducto.get(p.id) || null,
        amount: p.precio * p.cantidad,
    }))));
}

/**
 * Categorías que compró el cliente, con el monto y el porcentaje, de mayor a menor.
 * @param {object[]} compras — compras con productos { id, cantidad, precio }
 * @param {Map<number, string>} rubroPorProducto — product.product → rubro
 */
function categoriasCompradas(compras, rubroPorProducto) {
    const porRubro = new Map();
    let total = 0;
    for (const c of compras) {
        for (const p of c.productos) {
            const rubro = rubroPorProducto.get(p.id);
            if (!rubro) continue;
            const monto = p.precio * p.cantidad;
            porRubro.set(rubro, (porRubro.get(rubro) || 0) + monto);
            total += monto;
        }
    }
    return [...porRubro.entries()]
        .map(([rubro, monto]) => ({ rubro, monto: round2(monto), porcentaje: total ? Math.round((monto / total) * 100) : 0 }))
        .sort((a, b) => b.monto - a.monto);
}

// =============================================
// Compras
// =============================================

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
        const prev = porClave.get(clave) || { id, nombre: limpiarNombre(m2oName(l.product_id)), cantidad: 0, precio };
        prev.cantidad += qty;
        porClave.set(clave, prev);
    }
    return [...porClave.values()].map((p) => ({ ...p, cantidad: round2(p.cantidad) }));
}

const ESTADOS = { paid: 'pagado', done: 'pagado', invoiced: 'facturado' };

function unicos(lista) {
    return [...new Set(lista.filter(Boolean))];
}

/**
 * Clientes nuevos: primera compra válida (en toda la historia) dentro de los últimos `dias` días.
 * @param {{ tickets: object[], lineas: object[], hoy: string, dias: number }} input
 *   tickets: pos.order con id, name, pos_reference, partner_id, date_order, amount_total, state,
 *            sale_order_origin_id (m2o del pedido que cobra, o false), user_id (vendedor, m2o)
 *            y formas_pago (nombres de los medios de pago).
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
                vendedor: m2oName(primero.user_id) || null,
                formas_pago: unicos(ts.flatMap((t) => t.formas_pago || [])),
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
    CADENCIA,
    DIAS_DEFAULT,
    DIAS_MAX,
    VENTANA_ENVIO,
    NOMBRES_EXCLUIDOS,
    m2oId,
    m2oName,
    toArIso,
    desdeVentana,
    inicioDiaUtc,
    limpiarNombre,
    tocaHoy,
    proximaAccion,
    ventanaAbierta,
    errorTransicion,
    rubroDeCompras,
    categoriasCompradas,
    ticketsDeNuevos,
    armarProductos,
    calcularClientesNuevos,
};
