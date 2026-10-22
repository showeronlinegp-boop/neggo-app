// Clientes nuevos de la API del agente. Sin base ni Odoo. node backend/services/agenteNuevos.test.js

const assert = require('assert');
const { calcularClientesNuevos, ticketsDeNuevos, toArIso } = require('./agenteNuevos');

const HOY = '2026-10-22';
let nextId = 1;

/** Ticket del POS. fecha en UTC como la manda Odoo; a las 15:00 UTC es el mismo día en Argentina. */
function ticket(partner, fecha, extra = {}) {
    const id = nextId++;
    return {
        id,
        name: `Shop/${id}`,
        pos_reference: `Pedido 00012-003-${String(id).padStart(4, '0')}`,
        partner_id: Array.isArray(partner) ? partner : [partner, `Cliente ${partner}`],
        date_order: fecha.length === 10 ? `${fecha} 15:00:00` : fecha,
        amount_total: 1000,
        state: 'paid',
        sale_order_origin_id: false,
        ...extra,
    };
}

function ids(lista) {
    return lista.map((c) => c.id);
}

function testPrimeraCompraReciente() {
    const r = calcularClientesNuevos({ tickets: [ticket(1, '2026-10-19')], hoy: HOY, dias: 15 });
    assert.deepStrictEqual(ids(r), [1]);
    assert.strictEqual(r[0].cantidad_compras, 1);
    assert.strictEqual(r[0].fecha_primera_compra, '2026-10-19');
    assert.strictEqual(r[0].compras[0].fecha, '2026-10-19T12:00:00-03:00');
    assert.strictEqual(r[0].compras[0].estado, 'pagado');
}

function testBordeInclusivo() {
    const r = calcularClientesNuevos({ tickets: [ticket(1, '2026-10-08'), ticket(2, '2026-10-07')], hoy: HOY, dias: 15 });
    assert.deepStrictEqual(ids(r), [1]);
}

function testPrimeraCompraVieja() {
    const r = calcularClientesNuevos({ tickets: [ticket(1, '2026-09-12'), ticket(1, '2026-10-20')], hoy: HOY, dias: 15 });
    assert.deepStrictEqual(ids(r), []);
    // ticketsDeNuevos también lo saca, así no se leen sus líneas
    assert.deepStrictEqual(ticketsDeNuevos({ tickets: [ticket(1, '2026-09-12'), ticket(1, '2026-10-20')], hoy: HOY, dias: 15 }), []);
}

function testVariasComprasEnLaVentana() {
    const r = calcularClientesNuevos({
        tickets: [ticket(1, '2026-10-20'), ticket(1, '2026-10-10'), ticket(1, '2026-10-15', { state: 'invoiced' })],
        hoy: HOY, dias: 15,
    });
    assert.strictEqual(r[0].cantidad_compras, 3);
    assert.strictEqual(r[0].fecha_primera_compra, '2026-10-10');
    // Compras de la más nueva a la más vieja
    assert.deepStrictEqual(r[0].compras.map((c) => c.fecha.slice(0, 10)), ['2026-10-20', '2026-10-15', '2026-10-10']);
    assert.strictEqual(r[0].compras[1].estado, 'facturado');
}

function testZonaHoraria() {
    // 02:30 UTC del 08/10 es el 07/10 a las 23:30 en Argentina: queda afuera
    const afuera = calcularClientesNuevos({ tickets: [ticket(1, '2026-10-08 02:30:00')], hoy: HOY, dias: 15 });
    assert.deepStrictEqual(ids(afuera), []);
    const adentro = calcularClientesNuevos({ tickets: [ticket(1, '2026-10-08 03:00:00')], hoy: HOY, dias: 15 });
    assert.deepStrictEqual(ids(adentro), [1]);
    assert.strictEqual(adentro[0].compras[0].fecha, '2026-10-08T00:00:00-03:00');
    assert.strictEqual(toArIso('2026-10-10 19:20:00'), '2026-10-10T16:20:00-03:00');
}

function testSenaYSaldo() {
    const venta = [77, 'S00077'];
    const sena = ticket(1, '2026-10-12 14:00:00', { amount_total: 3000, sale_order_origin_id: venta });
    const saldo = ticket(1, '2026-10-18 14:00:00', { amount_total: 7000, sale_order_origin_id: venta, state: 'invoiced' });
    // Las líneas del pedido van en el primer ticket que lo cobra (como readPosLines)
    const lineas = [
        { order_id: [sena.id, null], product_id: [10, 'Producto X'], qty: 2, price_subtotal_incl: 6000 },
        { order_id: [sena.id, null], product_id: [11, 'Producto Y'], qty: 1, price_subtotal_incl: 4000 },
    ];
    const r = calcularClientesNuevos({ tickets: [saldo, sena], lineas, hoy: HOY, dias: 15 });
    assert.strictEqual(r[0].cantidad_compras, 1);
    const compra = r[0].compras[0];
    assert.strictEqual(compra.id, 'venta-77');
    assert.strictEqual(compra.referencia, 'S00077');
    assert.strictEqual(compra.monto, 10000);
    assert.strictEqual(compra.fecha, '2026-10-12T11:00:00-03:00');
    assert.strictEqual(compra.estado, 'facturado');
    assert.deepStrictEqual(compra.productos, [
        { id: 10, nombre: 'Producto X', cantidad: 2, precio: 3000 },
        { id: 11, nombre: 'Producto Y', cantidad: 1, precio: 4000 },
    ]);
    // Un solo ticket con pedido es una compra común: pos-<id>
    const solo = calcularClientesNuevos({ tickets: [ticket(2, '2026-10-12', { sale_order_origin_id: [78, 'S00078'] })], hoy: HOY, dias: 15 });
    assert.match(solo[0].compras[0].id, /^pos-\d+$/);
}

function testExcluidos() {
    const r = calcularClientesNuevos({
        tickets: [
            ticket(1, '2026-10-20', { partner_id: false }),
            ticket([2, 'Consumidor Final'], '2026-10-20'),
            ticket([3, ' RMA '], '2026-10-20'),
            ticket([4, 'Kiosco Don Pepe'], '2026-10-20'),
        ],
        hoy: HOY, dias: 15,
    });
    assert.deepStrictEqual(ids(r), [4]);
    assert.strictEqual(r[0].nombre, 'Kiosco Don Pepe');
}

function testDiasUno() {
    const r = calcularClientesNuevos({ tickets: [ticket(1, HOY), ticket(2, '2026-10-21')], hoy: HOY, dias: 1 });
    assert.deepStrictEqual(ids(r), [1]);
}

function testOrden() {
    const r = calcularClientesNuevos({
        tickets: [ticket(5, '2026-10-10'), ticket(3, '2026-10-20'), ticket(4, '2026-10-15'), ticket(2, '2026-10-20')],
        hoy: HOY, dias: 15,
    });
    assert.deepStrictEqual(ids(r), [2, 3, 4, 5]);
}

function testProductosJuntados() {
    const t = ticket(1, '2026-10-20');
    const lineas = [
        { order_id: [t.id, null], product_id: [10, 'X'], qty: 1, price_subtotal_incl: 1500.004 },
        { order_id: [t.id, null], product_id: [10, 'X'], qty: 2, price_subtotal_incl: 3000 },
        { order_id: [t.id, null], product_id: [10, 'X'], qty: 1, price_subtotal_incl: 1200 },
    ];
    const r = calcularClientesNuevos({ tickets: [t], lineas, hoy: HOY, dias: 15 });
    assert.deepStrictEqual(r[0].compras[0].productos, [
        { id: 10, nombre: 'X', cantidad: 3, precio: 1500 },
        { id: 10, nombre: 'X', cantidad: 1, precio: 1200 },
    ]);
}

const tests = [
    testPrimeraCompraReciente, testBordeInclusivo, testPrimeraCompraVieja, testVariasComprasEnLaVentana,
    testZonaHoraria, testSenaYSaldo, testExcluidos, testDiasUno, testOrden, testProductosJuntados,
];
for (const t of tests) t();
console.log(`✅ agenteNuevos: ${tests.length} tests OK`);
