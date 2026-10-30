// API del agente (Grok Bot): cotizaciones de la web sin confirmar. Lógica pura, sin I/O.
// La lectura de Odoo está en agenteService.js (listarCotizacionesWeb). Tests en agenteCotizacionesWeb.test.js.
// Una cotización web es un sale.order de Neggo con website_id, en borrador o enviada: el carrito
// que el cliente armó en la tienda y no terminó de confirmar.

const { m2oId, m2oName, odooMs, round2, esExcluido, toArIso, limpiarNombre } = require('./agenteNuevos');

const ESTADOS_ABIERTOS = ['draft', 'sent'];
const ESTADOS = { draft: 'borrador', sent: 'enviada' };
const DIAS_DEFAULT = 30;

/** Productos de una cotización: mismas líneas de producto y precio se juntan en una. Precio final, con IVA. */
function armarProductos(lineas) {
    const porClave = new Map();
    for (const l of lineas) {
        const id = m2oId(l.product_id);
        const qty = Number(l.product_uom_qty) || 0;
        if (!id || !qty) continue;
        const precio = round2((Number(l.price_total) || 0) / qty);
        const clave = `${id}|${precio}`;
        const prev = porClave.get(clave) || { id, nombre: limpiarNombre(m2oName(l.product_id)), cantidad: 0, precio, subtotal: 0 };
        prev.cantidad += qty;
        prev.subtotal += Number(l.price_total) || 0;
        porClave.set(clave, prev);
    }
    return [...porClave.values()].map((p) => ({ ...p, cantidad: round2(p.cantidad), subtotal: round2(p.subtotal) }));
}

/**
 * Cotizaciones web agrupadas por cliente.
 * @param {{ cotizaciones: object[], lineas: object[], compras: object[], excluidos: Iterable<number> }} input
 *   cotizaciones: sale.order con id, name, state, partner_id, date_order, write_date, amount_total,
 *                 website_id e is_abandoned_cart.
 *   lineas: sale.order.line de productos físicos con order_id, product_id, product_uom_qty y price_total.
 *   compras: compras ya cerradas del cliente (tickets del POS y pedidos confirmados) con partner_id y date_order.
 *   excluidos: partners que no son clientes (usuario público de la web, usuarios internos).
 * @returns {object[]} un elemento por cliente, ordenado por la cotización más nueva desc y id
 */
function agruparCotizacionesWeb({ cotizaciones, lineas = [], compras = [], excluidos = [] }) {
    const fuera = new Set(excluidos);
    const lineasPorOrden = new Map();
    for (const l of lineas) {
        const oid = m2oId(l.order_id);
        if (!lineasPorOrden.has(oid)) lineasPorOrden.set(oid, []);
        lineasPorOrden.get(oid).push(l);
    }
    const ultimaCompra = new Map();
    for (const c of compras) {
        const pid = m2oId(c.partner_id);
        const ms = odooMs(c.date_order);
        if (!pid || Number.isNaN(ms)) continue;
        if (!ultimaCompra.has(pid) || ms > ultimaCompra.get(pid)) ultimaCompra.set(pid, ms);
    }

    const porCliente = new Map();
    for (const o of cotizaciones) {
        const pid = m2oId(o.partner_id);
        const ms = odooMs(o.date_order);
        if (!pid || fuera.has(pid) || Number.isNaN(ms) || !ESTADOS_ABIERTOS.includes(o.state)) continue;
        if (esExcluido(m2oName(o.partner_id))) continue;
        const productos = armarProductos(lineasPorOrden.get(o.id) || []);
        // Un carrito vacío no dice nada del cliente
        if (!productos.length) continue;
        if (!porCliente.has(pid)) porCliente.set(pid, { id: pid, nombre: m2oName(o.partner_id) || `Cliente ${pid}`, cotizaciones: [] });
        porCliente.get(pid).cotizaciones.push({
            id: o.id,
            referencia: o.name,
            estado: ESTADOS[o.state],
            tienda: m2oName(o.website_id) || null,
            fecha: toArIso(ms),
            ultima_modificacion: toArIso(o.write_date),
            monto: round2(o.amount_total),
            abandonada: Boolean(o.is_abandoned_cart),
            productos,
            _ms: ms,
        });
    }

    const out = [...porCliente.values()].map((c) => {
        c.cotizaciones.sort((a, b) => b._ms - a._ms || b.id - a.id);
        const ultimaMs = c.cotizaciones[0]._ms;
        const compraMs = ultimaCompra.get(c.id);
        return {
            ...c,
            ultima_compra: compraMs !== undefined ? toArIso(compraMs) : null,
            // Compró (en el local o confirmando otro pedido) después de la última cotización: no hace falta escribirle
            compro_despues: compraMs !== undefined && compraMs >= ultimaMs,
            _ms: ultimaMs,
        };
    });
    out.sort((a, b) => b._ms - a._ms || a.id - b.id);
    return out.map(({ _ms, cotizaciones: cs, ...c }) => ({ ...c, cotizaciones: cs.map(({ _ms: _x, ...k }) => k) }));
}

module.exports = {
    ESTADOS_ABIERTOS,
    DIAS_DEFAULT,
    armarProductos,
    agruparCotizacionesWeb,
};
