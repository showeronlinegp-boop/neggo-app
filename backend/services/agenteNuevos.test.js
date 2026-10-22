// Clientes nuevos de la API del agente. Sin base ni Odoo. node backend/services/agenteNuevos.test.js

const assert = require('assert');
const {
    calcularClientesNuevos, ticketsDeNuevos, toArIso, tocaHoy, proximaAccion, ventanaAbierta, errorTransicion,
    vence, abreA, respuestaPendiente,
    limpiarNombre, rubroDeCompras, categoriasCompradas,
} = require('./agenteNuevos');

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
    const sena = ticket(1, '2026-10-12 14:00:00', { amount_total: 3000, sale_order_origin_id: venta, user_id: [7, 'Agus'], formas_pago: ['Efectivo'] });
    const saldo = ticket(1, '2026-10-18 14:00:00', { amount_total: 7000, sale_order_origin_id: venta, state: 'invoiced', formas_pago: ['Transferencia', 'Efectivo'] });
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
    assert.deepStrictEqual(compra.formas_pago, ['Efectivo', 'Transferencia']);
    assert.strictEqual(compra.vendedor, 'Agus');
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
        { order_id: [t.id, null], product_id: [10, '[BB88150] X'], qty: 1, price_subtotal_incl: 1500.004 },
        { order_id: [t.id, null], product_id: [10, 'X'], qty: 2, price_subtotal_incl: 3000 },
        { order_id: [t.id, null], product_id: [10, 'X'], qty: 1, price_subtotal_incl: 1200 },
    ];
    const r = calcularClientesNuevos({ tickets: [t], lineas, hoy: HOY, dias: 15 });
    assert.deepStrictEqual(r[0].compras[0].productos, [
        { id: 10, nombre: 'X', cantidad: 3, precio: 1500 },
        { id: 10, nombre: 'X', cantidad: 1, precio: 1200 },
    ]);
}

function testDiaQuinceNoSePierde() {
    // Por defecto la ventana es de 21 días: el cliente que cumple el día 15 hoy está en la lista
    const r = calcularClientesNuevos({ tickets: [ticket(1, '2026-10-07')], hoy: HOY });
    assert.deepStrictEqual(ids(r), [1]);
    assert.strictEqual(tocaHoy({ fechaPrimeraCompra: '2026-10-07', hoy: HOY, etapa: 'dia_7' }), 'dia_15');
}

function testTocaHoy() {
    const t = (fecha, etapa, extra = {}) => tocaHoy({ fechaPrimeraCompra: fecha, hoy: HOY, etapa, ...extra });
    assert.strictEqual(t('2026-10-22', 'pendiente'), null);          // día 0: compró hoy
    assert.strictEqual(t('2026-10-21', 'pendiente'), 'dia_1');
    assert.strictEqual(t('2026-10-21', 'dia_1'), null);              // ya se mandó
    assert.strictEqual(t('2026-10-17', 'pendiente'), 'dia_1');       // día 5: el día 1 todavía vale
    assert.strictEqual(t('2026-10-15', 'dia_1'), 'dia_7');
    assert.strictEqual(t('2026-10-13', 'pendiente'), 'dia_7');       // entró el día 9: el día 1 se saltea
    assert.strictEqual(t('2026-10-07', 'dia_15'), null);
    assert.strictEqual(t('2026-10-02', 'dia_7'), 'dia_15');          // día 20: último día del 15
    assert.strictEqual(t('2026-10-01', 'dia_7'), null);              // día 21: ya pasó
    assert.strictEqual(t('2026-10-15', 'finalizado'), null);
    assert.strictEqual(t('2026-10-15', 'pendiente', { noContactar: true }), null);
    assert.strictEqual(t(null, 'pendiente'), null);
}

function testProximaAccion() {
    assert.strictEqual(proximaAccion('2026-10-10', 'pendiente'), '2026-10-11');
    assert.strictEqual(proximaAccion('2026-10-10', 'dia_1'), '2026-10-17');
    assert.strictEqual(proximaAccion('2026-10-10', 'dia_7'), '2026-10-25');
    assert.strictEqual(proximaAccion('2026-10-10', 'dia_15'), null);
    assert.strictEqual(proximaAccion('2026-10-10', 'finalizado'), null);
}

function testVentana() {
    // 22/10/2026 es jueves. Horario de Argentina: UTC-3
    assert.ok(ventanaAbierta(new Date('2026-10-22T12:00:00Z')));   // 9:00
    assert.ok(ventanaAbierta(new Date('2026-10-22T20:59:00Z')));   // 17:59
    assert.ok(!ventanaAbierta(new Date('2026-10-22T21:00:00Z')));  // 18:00
    assert.ok(!ventanaAbierta(new Date('2026-10-22T11:59:00Z')));  // 8:59
    assert.ok(!ventanaAbierta(new Date('2026-10-24T15:00:00Z')));  // sábado
    assert.ok(!ventanaAbierta(new Date('2026-10-26T02:00:00Z')));  // domingo 23:00 en Argentina
}

function testVenceYAbre() {
    assert.strictEqual(vence('2026-10-10', 'dia_1'), '2026-10-16');
    assert.strictEqual(vence('2026-10-10', 'dia_7'), '2026-10-24');
    assert.strictEqual(vence('2026-10-10', 'dia_15'), '2026-10-30');
    assert.strictEqual(vence('2026-10-10', null), null);
    // Abierto: null. Jueves 19:00 → viernes 9:00. Viernes 18:30 → lunes 9:00. Jueves 7:00 → ese día 9:00
    assert.strictEqual(abreA(new Date('2026-10-22T15:00:00Z')), null);
    assert.strictEqual(abreA(new Date('2026-10-22T22:00:00Z')), '2026-10-23T09:00:00-03:00');
    assert.strictEqual(abreA(new Date('2026-10-23T21:30:00Z')), '2026-10-26T09:00:00-03:00');
    assert.strictEqual(abreA(new Date('2026-10-22T10:00:00Z')), '2026-10-22T09:00:00-03:00');
}

function testRespuestaPendiente() {
    const t = (r, e, v) => respuestaPendiente({ ultimoRecibido: r, ultimoEnviado: e, revisadoHasta: v });
    assert.strictEqual(t(null, '2026-10-22T13:00:00Z', null), false);
    assert.strictEqual(t('2026-10-22T14:00:00Z', '2026-10-22T13:00:00Z', null), true);
    assert.strictEqual(t('2026-10-22T12:00:00Z', '2026-10-22T13:00:00Z', null), false);
    // La marcó como revisada después de recibirla
    assert.strictEqual(t('2026-10-22T14:00:00Z', '2026-10-22T13:00:00Z', '2026-10-22T14:05:00Z'), false);
}

function testTransiciones() {
    assert.strictEqual(errorTransicion({ actual: 'pendiente', nueva: 'dia_7' }), null);
    assert.strictEqual(errorTransicion({ actual: 'dia_7', nueva: 'dia_7' }), null);
    assert.match(errorTransicion({ actual: 'dia_7', nueva: 'dia_1' }), /No se puede volver/);
    assert.match(errorTransicion({ actual: 'finalizado', nueva: 'dia_15' }), /finalizada/);
    // El caso que encontró Grok: no contactar no se puede reabrir
    assert.match(errorTransicion({ actual: 'finalizado', nueva: 'dia_1', noContactar: true }), /no recibir mensajes/);
    assert.strictEqual(errorTransicion({ actual: 'dia_1', nueva: 'finalizado', noContactar: true }), null);
}

function testNombresYRubro() {
    assert.strictEqual(limpiarNombre('[BB88150] Cable Usb Iphone'), 'Cable Usb Iphone');
    assert.strictEqual(limpiarNombre('  AURICULAR  JK-604 '), 'AURICULAR JK-604');
    assert.strictEqual(limpiarNombre('Cable [nuevo]'), 'Cable [nuevo]');
    const compras = [{ productos: [{ id: 1, cantidad: 2, precio: 100 }, { id: 2, cantidad: 1, precio: 300 }, { id: 3, cantidad: 1, precio: 50 }] }];
    assert.deepStrictEqual(categoriasCompradas(compras, new Map([[1, 'Librería'], [2, 'Tecnología']])), [
        { rubro: 'Tecnología', monto: 300, porcentaje: 60 },
        { rubro: 'Librería', monto: 200, porcentaje: 40 },
    ]);
    // Misma regla que el módulo comercial: la categoría en la que más gastó
    assert.strictEqual(rubroDeCompras(compras, new Map([[1, 'Librería'], [2, 'Tecnología']])), 'Tecnología');
    assert.strictEqual(rubroDeCompras(compras, new Map()), null);
}

const tests = [
    testDiaQuinceNoSePierde, testTocaHoy, testProximaAccion, testVentana, testVenceYAbre, testRespuestaPendiente,
    testTransiciones, testNombresYRubro,
    testPrimeraCompraReciente, testBordeInclusivo, testPrimeraCompraVieja, testVariasComprasEnLaVentana,
    testZonaHoraria, testSenaYSaldo, testExcluidos, testDiasUno, testOrden, testProductosJuntados,
];
for (const t of tests) t();
console.log(`✅ agenteNuevos: ${tests.length} tests OK`);
