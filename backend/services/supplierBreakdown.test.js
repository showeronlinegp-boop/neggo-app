// Costo del pedido al proveedor. Sin Odoo.
// node backend/services/supplierBreakdown.test.js

const assert = require('assert');
const { supplierNetCost, groupQuotationsBySupplier } = require('./supplierBreakdown');

function testNetCost() {
    assert.strictEqual(supplierNetCost({ raw_price: 1000, default_discount: 10 }), 900);
    assert.strictEqual(supplierNetCost({ raw_price: 1000, offer_price: 750, default_discount: 10 }), 750);
    assert.strictEqual(supplierNetCost({ raw_price: null, default_discount: 10 }), null);
    assert.strictEqual(supplierNetCost({ raw_price: 0, default_discount: 0 }), null);
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

testNetCost();
testGroupUsesSupplierCost();
console.log('pedidos x proveedor ok');
