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
    ordenFacturada,
    esCotizacionParaArmar,
    odooNecesitaConfirmar,
    odooYaConfirmada,
    primerPickingSalida,
    auditarEmpezarArmar,
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

function testCotizacionParaArmar() {
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent' })), true);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sale' })), false);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', invoice_status: 'invoiced' })), false);
    assert.strictEqual(ordenFacturada(odooOrder({ invoice_status: 'invoiced' })), true);
    assert.strictEqual(ordenFacturada(odooOrder({ lines: [odooLine({ qty_invoiced: 1 })] })), true);
}

function testConfirmarAlEmpezar() {
    assert.strictEqual(odooNecesitaConfirmar('draft'), true);
    assert.strictEqual(odooNecesitaConfirmar('sent'), true);
    assert.strictEqual(odooNecesitaConfirmar('sale'), false);
    assert.strictEqual(odooNecesitaConfirmar('done'), false);
    assert.strictEqual(odooYaConfirmada('sale'), true);
    assert.strictEqual(odooYaConfirmada('done'), true);
    assert.strictEqual(odooYaConfirmada('sent'), false);

    assert.strictEqual(auditarEmpezarArmar(null).ok, false);
    assert.strictEqual(auditarEmpezarArmar(null).statusCode, 404);

    const cancelada = auditarEmpezarArmar(odooOrder({ state: 'cancel' }));
    assert.strictEqual(cancelada.ok, false);
    assert.match(cancelada.error, /cancelada/);

    const rara = auditarEmpezarArmar(odooOrder({ state: 'waiting' }));
    assert.strictEqual(rara.ok, false);
    assert.match(rara.error, /waiting/);

    const draft = auditarEmpezarArmar(odooOrder({ state: 'draft' }));
    assert.strictEqual(draft.ok, true);
    assert.strictEqual(draft.needsConfirm, true);

    const sent = auditarEmpezarArmar(odooOrder({ state: 'sent' }));
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(sent.needsConfirm, true);

    const sale = auditarEmpezarArmar(odooOrder({ state: 'sale' }));
    assert.strictEqual(sale.ok, true);
    assert.strictEqual(sale.needsConfirm, false);
}

function testPrimerPickingSalida() {
    assert.strictEqual(primerPickingSalida([]), null);
    assert.strictEqual(primerPickingSalida(null), null);
    const primero = primerPickingSalida([
        { id: 88, name: 'WH/IN/0001', picking_type_code: 'incoming' },
        { id: 91, name: 'WH/OUT/0002', picking_type_code: 'outgoing' },
        { id: 90, name: 'WH/OUT/0001', picking_type_code: 'outgoing' },
    ]);
    assert.deepStrictEqual(primero, { id: 90, name: 'WH/OUT/0001' });
    assert.deepStrictEqual(
        primerPickingSalida([{ id: 5, name: 'OUT/1' }]),
        { id: 5, name: 'OUT/1' }
    );
}

function testAuditarSent() {
    const r = auditar([item()], odooOrder({ state: 'sent' }));
    assert.strictEqual(r.ok, true);
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
testCotizacionParaArmar();
testConfirmarAlEmpezar();
testPrimerPickingSalida();
testAuditarSent();
testAuditarFacturada();
testAuditarEntregadaYLocked();
testAuditarCancelada();
testAuditarLineasDeMasYDeMenos();
testAuditarIgnoraDownPayment();
testAuditarSinOdoo();
console.log('ok pedidoEnvio.test.js');
