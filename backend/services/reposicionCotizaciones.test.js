// Cotizaciones "Pendiente" para reposición: armado y total por producto.
// Sin base de datos ni Odoo. node backend/services/reposicionCotizaciones.test.js

const assert = require('assert');
const { armarCotizaciones, resumirPorProducto } = require('./reposicionCotizacionesService');

const COMPANIES = { neggo: 1, preventas: 50 };

function testArmar() {
    const orders = [
        { id: 20, name: 'S00020', state: 'sent', company_id: [50, 'Precompras'], partner_id: [8, 'Yami'], user_id: false, date_order: '2026-10-21 01:39:54', origin: 'S00010 (pendientes)', amount_total: 3000 },
        { id: 21, name: 'S00021', state: 'draft', company_id: [1, 'neggo'], partner_id: [9, 'Pablo'], user_id: [2, 'Mariano'], date_order: '2026-10-22 15:33:48', origin: false, amount_total: 1500 },
        // Solo un envío (servicio): no llega ninguna línea → no aparece
        { id: 22, name: 'S00022', state: 'draft', company_id: [1, 'neggo'], partner_id: [9, 'Pablo'], user_id: false, date_order: '2026-10-23 10:00:00', origin: false, amount_total: 100 },
    ];
    const lines = [
        { order_id: [20, 'S00020'], product_id: [100, 'Pava'], product_uom_qty: 2, price_unit: 1000 },
        { order_id: [20, 'S00020'], product_id: [100, 'Pava'], product_uom_qty: 1, price_unit: 1000 },
        { order_id: [21, 'S00021'], product_id: [100, 'Pava'], product_uom_qty: 1, price_unit: 1500 },
        { order_id: [21, 'S00021'], product_id: [101, 'Vaso'], product_uom_qty: 0, price_unit: 10 },
    ];
    const res = armarCotizaciones(orders, lines, COMPANIES);
    assert.strictEqual(res.length, 2, 'la cotización sin productos físicos no se muestra');
    assert.strictEqual(res[0].name, 'S00021', 'más nuevas primero');
    assert.strictEqual(res[0].estado, 'borrador');
    assert.strictEqual(res[0].company, 'neggo');
    assert.strictEqual(res[0].origen, null);
    assert.strictEqual(res[0].productos.length, 1, 'cantidad 0 no cuenta');
    assert.strictEqual(res[1].estado, 'enviada');
    assert.strictEqual(res[1].company, 'preventas');
    assert.strictEqual(res[1].empresa, 'Preventas');
    assert.strictEqual(res[1].date_order, '2026-10-21T01:39:54Z');
    assert.strictEqual(res[1].productos[0].qty, 3, 'el mismo producto se suma');
}

function testResumir() {
    const cotizaciones = [
        { name: 'S1', partner_name: 'A', company: 'neggo', empresa: 'Neggo', productos: [
            { odoo_id: 100, name: 'Pava', qty: 2, vendor_name: 'Zeta' },
            { odoo_id: 101, name: 'Vaso', qty: 1, vendor_name: 'Alfa', estado_cola: 'pendiente' },
        ] },
        { name: 'S2', partner_name: 'B', company: 'neggo', empresa: 'Neggo', productos: [
            { odoo_id: 100, name: 'Pava', qty: 3, vendor_name: 'Zeta' },
        ] },
        // Mismo id en otra empresa: va aparte
        { name: 'S3', partner_name: 'C', company: 'preventas', empresa: 'Preventas', productos: [
            { odoo_id: 100, name: 'Pava', qty: 1, vendor_name: 'Zeta' },
        ] },
    ];
    const res = resumirPorProducto(cotizaciones);
    assert.strictEqual(res.length, 3);
    assert.strictEqual(res[0].vendor_name, 'Alfa', 'ordena por proveedor');
    assert.strictEqual(res[0].estado_cola, 'pendiente');
    const pava = res.find(p => p.odoo_id === 100 && p.company === 'neggo');
    assert.strictEqual(pava.qty_total, 5);
    assert.deepStrictEqual(pava.cotizaciones.map(c => c.name), ['S1', 'S2']);
    assert.strictEqual(res[1].qty_total, 5, 'dentro del proveedor, más cantidad primero');
}

testArmar();
testResumir();
console.log('✅ reposicionCotizaciones: ok');
