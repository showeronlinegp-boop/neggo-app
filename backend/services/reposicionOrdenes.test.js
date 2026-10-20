// Órdenes como tareas de reposición: armado de órdenes y separación de revisadas.
// Sin base de datos ni Odoo. node backend/services/reposicionOrdenes.test.js

const assert = require('assert');
const {
    armarOrdenes,
    separarRevisadas,
    fechaDesdeOdoo,
    diasValidos,
    isoDeOdoo,
} = require('./reposicionOrdenesService');

function testArmarVentas() {
    const orders = [
        { id: 10, name: 'S00010', partner_id: [5, 'Kiosco Pepe'], user_id: [2, 'Mariano'], date_order: '2026-10-19 13:00:00', amount_total: 5000 },
        // Solo tenía la seña (servicio): no llega ninguna línea → no aparece
        { id: 11, name: 'S00011', partner_id: [6, 'Otro'], user_id: false, date_order: '2026-10-19 14:00:00', amount_total: 100 },
    ];
    const lines = [
        { order_id: [10, 'S00010'], product_id: [100, '[A1] Pava'], product_uom_qty: 2, price_unit: 1000 },
        { order_id: [10, 'S00010'], product_id: [100, '[A1] Pava'], product_uom_qty: 1, price_unit: 1000 },
        { order_id: [10, 'S00010'], product_id: [101, 'Vaso'], product_uom_qty: 3, price_unit: 500 },
    ];
    const res = armarOrdenes(orders, lines, 'venta');
    assert.strictEqual(res.length, 1, 'la orden sin productos físicos no se muestra');
    const o = res[0];
    assert.strictEqual(o.key, 'venta|10');
    assert.strictEqual(o.name, 'S00010');
    assert.strictEqual(o.partner_name, 'Kiosco Pepe');
    assert.strictEqual(o.vendedor, 'Mariano');
    assert.strictEqual(o.date_order, '2026-10-19T13:00:00Z');
    assert.strictEqual(o.productos.length, 2, 'el mismo producto se suma en un solo renglón');
    assert.strictEqual(o.productos.find(p => p.odoo_id === 100).qty, 3);
}

function testArmarPos() {
    const orders = [
        { id: 7, name: 'neggo/0007', pos_reference: 'Orden 00001-002-0007', partner_id: false, user_id: [2, 'Caja'], date_order: '2026-10-20 10:00:00', amount_total: 900 },
    ];
    const lines = [
        { order_id: [7, 'x'], product_id: [200, 'Bombilla'], qty: 2, price_unit: 450 },
        // Devolución: no es una venta
        { order_id: [7, 'x'], product_id: [201, 'Mate'], qty: -1, price_unit: 300 },
    ];
    const [o] = armarOrdenes(orders, lines, 'pos');
    assert.strictEqual(o.key, 'pos|7');
    assert.strictEqual(o.name, 'Orden 00001-002-0007', 'en POS se muestra el número de ticket');
    assert.strictEqual(o.partner_name, null);
    assert.deepStrictEqual(o.productos.map(p => p.odoo_id), [200]);
}

function testSepararRevisadas() {
    const ordenes = [
        { key: 'venta|1', date_order: '2026-10-18T10:00:00Z' },
        { key: 'pos|2', date_order: '2026-10-20T10:00:00Z' },
        { key: 'venta|3', date_order: '2026-10-19T10:00:00Z' },
    ];
    const revisadas = new Map([['venta|3', { revisada_at: '2026-10-20T12:00:00Z', revisada_by_name: 'Ana' }]]);
    const res = separarRevisadas(ordenes, revisadas);
    assert.deepStrictEqual(res.pendientes.map(o => o.key), ['pos|2', 'venta|1'], 'pendientes: más nuevas primero');
    assert.strictEqual(res.revisadas.length, 1);
    assert.strictEqual(res.revisadas[0].revisada_by_name, 'Ana');
}

function testFechas() {
    const ahora = new Date('2026-10-20T15:30:00Z');
    assert.strictEqual(fechaDesdeOdoo(7, ahora), '2026-10-13 15:30:00');
    assert.strictEqual(diasValidos('3'), 3);
    assert.strictEqual(diasValidos('0'), 7);
    assert.strictEqual(diasValidos('abc'), 7);
    assert.strictEqual(diasValidos(90), 7, 'más de un mes no: sería demasiado para leer en vivo');
    assert.strictEqual(isoDeOdoo(false), null);
}

testArmarVentas();
testArmarPos();
testSepararRevisadas();
testFechas();
console.log('✅ reposicionOrdenes: todos los tests pasaron');
