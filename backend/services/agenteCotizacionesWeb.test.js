// Cotizaciones web sin confirmar de la API del agente. Sin base ni Odoo. node backend/services/agenteCotizacionesWeb.test.js

const assert = require('assert');
const { agruparCotizacionesWeb, armarProductos } = require('./agenteCotizacionesWeb');

let nextId = 100;

/** Cotización web. fecha en UTC como la manda Odoo. */
function cotizacion(partner, fecha, extra = {}) {
    const id = nextId++;
    return {
        id,
        name: `S0${id}`,
        state: 'draft',
        partner_id: Array.isArray(partner) ? partner : [partner, `Cliente ${partner}`],
        date_order: fecha,
        write_date: fecha,
        amount_total: 1210,
        website_id: [1, 'neggo mayorista'],
        is_abandoned_cart: true,
        ...extra,
    };
}

function linea(orden, producto, qty = 1, total = 1210) {
    return { order_id: [orden.id, orden.name], product_id: [producto, `[COD${producto}] Producto ${producto}`], product_uom_qty: qty, price_total: total };
}

function testAgrupaPorCliente() {
    const a1 = cotizacion(1, '2026-10-20 15:00:00');
    const a2 = cotizacion(1, '2026-10-25 15:00:00', { state: 'sent', website_id: [6, 'neggo minorista'] });
    const b = cotizacion(2, '2026-10-22 15:00:00');
    const out = agruparCotizacionesWeb({
        cotizaciones: [a1, b, a2],
        lineas: [linea(a1, 10), linea(a2, 11, 2, 2420), linea(b, 12)],
    });
    // El cliente con la cotización más nueva primero; adentro, de la más nueva a la más vieja
    assert.deepStrictEqual(out.map((c) => c.id), [1, 2]);
    assert.deepStrictEqual(out[0].cotizaciones.map((k) => k.referencia), [a2.name, a1.name]);
    assert.deepStrictEqual(out[0].cotizaciones[0], {
        id: a2.id,
        referencia: a2.name,
        estado: 'enviada',
        tienda: 'neggo minorista',
        fecha: '2026-10-25T12:00:00-03:00',
        ultima_modificacion: '2026-10-25T12:00:00-03:00',
        monto: 1210,
        abandonada: true,
        productos: [{ id: 11, nombre: 'Producto 11', cantidad: 2, precio: 1210, subtotal: 2420 }],
    });
    assert.strictEqual(out[0].ultima_compra, null);
    assert.strictEqual(out[0].compro_despues, false);
}

function testDescarta() {
    const vacia = cotizacion(1, '2026-10-20 15:00:00');
    const publico = cotizacion([4, 'Public user'], '2026-10-20 15:00:00');
    const confirmada = cotizacion(2, '2026-10-20 15:00:00', { state: 'sale' });
    const cf = cotizacion([5, 'Consumidor Final'], '2026-10-20 15:00:00');
    const sinPartner = cotizacion(1, '2026-10-20 15:00:00', { partner_id: false });
    const out = agruparCotizacionesWeb({
        cotizaciones: [vacia, publico, confirmada, cf, sinPartner],
        lineas: [linea(publico, 10), linea(confirmada, 10), linea(cf, 10), linea(sinPartner, 10)],
        excluidos: [4],
    });
    assert.deepStrictEqual(out, []);
}

function testComproDespues() {
    const a = cotizacion(1, '2026-10-20 15:00:00');
    const b = cotizacion(2, '2026-10-20 15:00:00');
    const c = cotizacion(3, '2026-10-20 15:00:00');
    const out = agruparCotizacionesWeb({
        cotizaciones: [a, b, c],
        lineas: [linea(a, 10), linea(b, 10), linea(c, 10)],
        compras: [
            { partner_id: [1, 'x'], date_order: '2026-10-21 13:00:00' }, // compró en el local al otro día
            { partner_id: [2, 'x'], date_order: '2026-09-01 13:00:00' }, // cliente viejo, no volvió a comprar
            { partner_id: [2, 'x'], date_order: '2026-08-01 13:00:00' },
        ],
    });
    const porId = new Map(out.map((x) => [x.id, x]));
    assert.strictEqual(porId.get(1).compro_despues, true);
    assert.strictEqual(porId.get(1).ultima_compra, '2026-10-21T10:00:00-03:00');
    assert.strictEqual(porId.get(2).compro_despues, false);
    assert.strictEqual(porId.get(2).ultima_compra, '2026-09-01T10:00:00-03:00');
    assert.strictEqual(porId.get(3).compro_despues, false);
    assert.strictEqual(porId.get(3).ultima_compra, null);
}

function testProductosJuntados() {
    const o = cotizacion(1, '2026-10-20 15:00:00');
    assert.deepStrictEqual(armarProductos([linea(o, 10, 1, 100), linea(o, 10, 2, 200), linea(o, 10, 1, 150), linea(o, 11, 0, 0)]), [
        { id: 10, nombre: 'Producto 10', cantidad: 3, precio: 100, subtotal: 300 },
        { id: 10, nombre: 'Producto 10', cantidad: 1, precio: 150, subtotal: 150 },
    ]);
}

const tests = [testAgrupaPorCliente, testDescarta, testComproDespues, testProductosJuntados];
for (const t of tests) t();
console.log(`✅ agenteCotizacionesWeb: ${tests.length} tests OK`);
