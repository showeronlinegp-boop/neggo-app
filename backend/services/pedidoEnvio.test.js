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
    refPendientes,
    auditarSaldar,
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

function item(over = {}) {
    return {
        id: 1,
        odoo_line_id: 10,
        odoo_product_id: 100,
        product_name: 'A',
        qty_pedida: 5,
        qty_controlada: 5,
        price_unit: 10,
        ...over,
    };
}

function odooLine(over = {}) {
    return {
        id: 10,
        product_id: 100,
        product_name: 'A',
        quantity: 5,
        qty_delivered: 0,
        qty_invoiced: 0,
        ...over,
    };
}

function odooOrder(over = {}) {
    return {
        id: 1,
        name: 'S0001',
        state: 'sale',
        locked: false,
        invoice_status: 'to invoice',
        lines: [odooLine()],
        ...over,
    };
}

function auditar(items, odoo, extraEnvio = {}) {
    const envio = { items, odoo_order_name: 'S0001', ...extraEnvio };
    return auditarSaldar({ envio, odoo, plan: previewSaldar(items) });
}

function testRefPendientes() {
    assert.strictEqual(refPendientes('S0001'), 'Pendientes de S0001');
}

function testAuditarIgual() {
    const r = auditar([item()], odooOrder());
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.writes, []);
    assert.strictEqual(r.alreadyCancelled, false);
}

function testAuditarEscribeParcialYCero() {
    const items = [
        item({ qty_controlada: 3 }),
        item({
            id: 2, odoo_line_id: 11, odoo_product_id: 101,
            product_name: 'B', qty_pedida: 2, qty_controlada: 0,
        }),
    ];
    const odoo = odooOrder({
        lines: [
            odooLine(),
            odooLine({ id: 11, product_id: 101, product_name: 'B', quantity: 2 }),
        ],
    });
    const r = auditar(items, odoo);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.writes.map((w) => [w.odoo_line_id, w.qty]), [[10, 3], [11, 0]]);
}

function testAuditarYaAplicado() {
    const items = [item({ qty_controlada: 3 })];
    const r = auditar(items, odooOrder({ lines: [odooLine({ quantity: 3 })] }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.writes, []);
}

function testAuditarDrift() {
    const r = auditar([item({ qty_controlada: 3 })], odooOrder({ lines: [odooLine({ quantity: 4 })] }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /cantidad 4/);
}

function testAuditarFacturada() {
    const porEstado = auditar([item()], odooOrder({ invoice_status: 'invoiced' }));
    assert.strictEqual(porEstado.ok, false);
    assert.match(porEstado.error, /facturada/);

    const porLinea = auditar([item()], odooOrder({ lines: [odooLine({ qty_invoiced: 1 })] }));
    assert.strictEqual(porLinea.ok, false);
    assert.match(porLinea.error, /facturada/);
}

function testAuditarEntregadaYLocked() {
    const entregada = auditar([item()], odooOrder({ lines: [odooLine({ qty_delivered: 1 })] }));
    assert.strictEqual(entregada.ok, false);
    assert.match(entregada.error, /entregada/);

    const locked = auditar([item()], odooOrder({ locked: true }));
    assert.strictEqual(locked.ok, false);
    assert.match(locked.error, /bloqueada/);
}

function testAuditarCancelada() {
    const nada = [item({ qty_controlada: 0 })];
    const reintento = auditar(nada, odooOrder({ state: 'cancel' }));
    assert.strictEqual(reintento.ok, true);
    assert.strictEqual(reintento.alreadyCancelled, true);
    assert.deepStrictEqual(reintento.writes, []);

    const noEraCancelar = auditar([item()], odooOrder({ state: 'cancel' }));
    assert.strictEqual(noEraCancelar.ok, false);
    assert.match(noEraCancelar.error, /cancel/);
}

function testAuditarLineasDeMasYDeMenos() {
    const falta = auditar([item()], odooOrder({ lines: [] }));
    assert.strictEqual(falta.ok, false);
    assert.match(falta.error, /no está el renglón/);

    const sobra = auditar(
        [item()],
        odooOrder({
            lines: [
                odooLine(),
                odooLine({ id: 99, product_id: 200, product_name: 'Z' }),
            ],
        })
    );
    assert.strictEqual(sobra.ok, false);
    assert.match(sobra.error, /renglón que acá no está/);

    const producto = auditar([item()], odooOrder({ lines: [odooLine({ product_id: 999 })] }));
    assert.strictEqual(producto.ok, false);
    assert.match(producto.error, /cambió el producto/);
}

function testAuditarIgnoraDownPayment() {
    const r = auditar(
        [item()],
        odooOrder({
            lines: [
                odooLine(),
                odooLine({ id: 50, product_id: 9, product_name: 'Down Payment', quantity: 1 }),
            ],
        })
    );
    assert.strictEqual(r.ok, true);
}

function testAuditarSinOdoo() {
    const r = auditar([item()], null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.statusCode, 404);
}

testClamp();
testTabs();
testBarcode();
testPreviewCompleto();
testPreviewParcial();
testPreviewNadaControlado();
testFaseQty();
testRefPendientes();
testAuditarIgual();
testAuditarEscribeParcialYCero();
testAuditarYaAplicado();
testAuditarDrift();
testAuditarFacturada();
testAuditarEntregadaYLocked();
testAuditarCancelada();
testAuditarLineasDeMasYDeMenos();
testAuditarIgnoraDownPayment();
testAuditarSinOdoo();
console.log('ok pedidoEnvio.test.js');
