// Reglas de armado/control: cantidades, preview de saldar, match de barcode.
// Sin base ni Odoo. node backend/services/pedidoEnvio.test.js

const assert = require('assert');
const {
    clampQty,
    tabDeEstado,
    normalizarCode,
    itemPorCodigo,
    previewSaldar,
    qtyCampoDeFase,
} = require('./pedidoEnvioService');

function testClamp() {
    assert.strictEqual(clampQty(-1, 5), 0);
    assert.strictEqual(clampQty(3, 5), 3);
    assert.strictEqual(clampQty(9, 5), 5);
    assert.strictEqual(clampQty('2.6', 5), 3);
    assert.strictEqual(clampQty(null, 5), 0);
}

function testTabs() {
    assert.strictEqual(tabDeEstado('pendiente'), 'armar');
    assert.strictEqual(tabDeEstado('armando'), 'armar');
    assert.strictEqual(tabDeEstado('armado'), 'controlar');
    assert.strictEqual(tabDeEstado('controlando'), 'controlar');
    assert.strictEqual(tabDeEstado('saldado'), 'hechos');
}

function testBarcode() {
    assert.strictEqual(normalizarCode('000123'), '123');
    assert.strictEqual(normalizarCode(' 7790 '), '7790');
    const items = [
        { id: 1, barcode: '7790123', internal_ref: 'NEG-1', product_name: 'A' },
        { id: 2, barcode: '00055', internal_ref: 'X', product_name: 'B' },
    ];
    assert.strictEqual(itemPorCodigo(items, '7790123').id, 1);
    assert.strictEqual(itemPorCodigo(items, 'NEG-1').id, 1);
    assert.strictEqual(itemPorCodigo(items, '55').id, 2);
    assert.strictEqual(itemPorCodigo(items, 'nope'), null);
}

function testPreviewCompleto() {
    const plan = previewSaldar([
        { id: 1, odoo_line_id: 10, odoo_product_id: 100, product_name: 'A', qty_pedida: 5, qty_controlada: 5, price_unit: 10 },
    ]);
    assert.strictEqual(plan.queda.length, 0);
    assert.strictEqual(plan.pendientes.length, 0);
    assert.strictEqual(plan.iguales.length, 1);
    assert.strictEqual(plan.cancela_original, false);
}

function testPreviewParcial() {
    const plan = previewSaldar([
        { id: 1, odoo_line_id: 10, odoo_product_id: 100, product_name: 'A', qty_pedida: 5, qty_controlada: 3, price_unit: 10 },
        { id: 2, odoo_line_id: 11, odoo_product_id: 101, product_name: 'B', qty_pedida: 2, qty_controlada: 0, price_unit: 4 },
        { id: 3, odoo_line_id: 12, odoo_product_id: 102, product_name: 'C', qty_pedida: 1, qty_controlada: 1, price_unit: 8 },
    ]);
    assert.strictEqual(plan.iguales.length, 1);
    assert.strictEqual(plan.queda.length, 2);
    assert.deepStrictEqual(plan.queda.map((l) => [l.odoo_line_id, l.qty_nueva]), [[10, 3], [11, 0]]);
    assert.deepStrictEqual(plan.pendientes.map((l) => [l.odoo_product_id, l.qty_pendiente]), [[100, 2], [101, 2]]);
    assert.strictEqual(plan.cancela_original, false);
}

function testPreviewNadaControlado() {
    const plan = previewSaldar([
        { id: 1, odoo_line_id: 10, odoo_product_id: 100, product_name: 'A', qty_pedida: 5, qty_controlada: 0, price_unit: 10 },
    ]);
    assert.strictEqual(plan.cancela_original, true);
    assert.strictEqual(plan.pendientes[0].qty_pendiente, 5);
    assert.strictEqual(plan.queda[0].qty_nueva, 0);
}

function testFaseQty() {
    assert.strictEqual(qtyCampoDeFase('armando'), 'qty_armada');
    assert.strictEqual(qtyCampoDeFase('controlando'), 'qty_controlada');
}

testClamp();
testTabs();
testBarcode();
testPreviewCompleto();
testPreviewParcial();
testPreviewNadaControlado();
testFaseQty();
console.log('ok pedidoEnvio.test.js');
