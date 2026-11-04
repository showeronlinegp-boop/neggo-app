// Costo del pedido al proveedor. Sin Odoo.
// node backend/services/supplierBreakdown.test.js

const assert = require('assert');
const { supplierNetCost, groupQuotationsBySupplier } = require('./supplierBreakdown');

function testNetCost() {
    assert.strictEqual(supplierNetCost({ raw_price: 1000, default_discount: 10 }), 900);
    assert.strictEqual(supplierNetCost({ raw_price: 1000, offer_price: 750, default_discount: 10 }), 750);
    assert.strictEqual(supplierNetCost({ raw_price: null, default_discount: 10 }), null);
    assert.strictEqual(supplierNetCost({ raw_price: 0, default_discount: 0 }), null);
    // Fuente Neggo: el costo ya tiene el descuento (nota 129)
    assert.strictEqual(supplierNetCost({ raw_price: 900, default_discount: 10, source: 'neggo' }), 900);
    console.log('neto ok');
}

function testGroupUsesSupplierCost() {
    const quotations = [{
        id: 1,
        name: 'S0001',
        client: 'Ana',
        date: '2026-10-01',
        lines: [{ product_id: 7, product_name: 'Vaso', external_id: 'PRE1', quantity: 2, unit_price: 1500 }],
    }];
    const grouped = groupQuotationsBySupplier(quotations, {
        7: { vendor_name: 'Cast', standard_price: 400, order_cost: 900, image_url: null },
    }, { 7: 'Cast' });
    assert.strictEqual(grouped[0].products[0].unit_cost, 900);
    assert.strictEqual(grouped[0].total_cost, 1800);

    const fallback = groupQuotationsBySupplier(quotations, {
        7: { vendor_name: 'Cast', standard_price: 400, image_url: null },
    }, {});
    assert.strictEqual(fallback[0].products[0].unit_cost, 400);
    console.log('agrupado ok');
}

function testMarcaPendientes() {
    const linea = { product_id: 7, product_name: 'Vaso', quantity: 1, unit_price: 100 };
    const grouped = groupQuotationsBySupplier([
        { id: 1, name: 'S0001', es_pendiente: true, lines: [linea] },
        { id: 2, name: 'S0002', es_pendiente: false, lines: [linea] },
        { id: 3, name: 'S0003', lines: [linea] },
    ], {}, { 7: 'Cast' });
    assert.deepStrictEqual(grouped[0].products[0].quotations.map(q => q.es_pendiente), [true, false, false]);
    console.log('marca de pendientes ok');
}

testNetCost();
testGroupUsesSupplierCost();
testMarcaPendientes();
console.log('pedidos x proveedor ok');
