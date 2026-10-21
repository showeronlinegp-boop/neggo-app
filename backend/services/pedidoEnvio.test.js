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
    topeDeFase,
    refPendientes,
    ordenFacturada,
    ordenCobradaAparte,
    ordenEnviosYaHechos,
    clasificarEnvios,
    etapaDesdeOdoo,
    estadoSegunOdoo,
    qtyDesdeMoves,
    fuentesDeQty,
    planIgualar,
    esCotizacionParaArmar,
    odooNecesitaConfirmar,
    odooYaConfirmada,
    armandoRequiereConfirmado,
    primerPickingSalida,
    planQtyMovesArmado,
    hayFaltanteEnMoves,
    esWizardBackorder,
    auditarTerminarArmado,
    auditarEmpezarArmar,
    auditarSaldar,
    auditarCancelarOrden,
    condicionesListado,
    ordenListado,
    ETIQUETA_PENDIENTES,
    asegurarBackorder,
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

function testListado() {
    const companies = ['neggo', 'preventas'];
    const pedidos = condicionesListado({ companies });
    assert.deepStrictEqual(pedidos.params, [companies]);
    assert.ok(pedidos.where.includes('e.cotizacion_enviada_at IS NULL'));
    assert.ok(pedidos.where.includes("e.estado <> 'cancelado'"));
    assert.ok(pedidos.where.some((w) => w.includes("invoice_status") && w.includes('odoo_pos_count')));
    assert.ok(!pedidos.where.some((w) => w.includes('odoo_picking_done_count')));

    const esperando = condicionesListado({ companies, solapa: 'esperando_pago', q: 'S04', dias: '7' });
    assert.deepStrictEqual(esperando.params, [companies, '%S04%', 7]);
    assert.ok(esperando.where.includes('e.cotizacion_enviada_at IS NOT NULL AND e.pago_recibido_at IS NULL'));

    const conPagados = condicionesListado({ companies, incluirPagados: true });
    assert.ok(conPagados.where.includes('(e.cotizacion_enviada_at IS NULL OR e.pago_recibido_at IS NOT NULL)'));

    // Días inválidos no filtran
    assert.strictEqual(condicionesListado({ companies, dias: 'x' }).params.length, 1);

    assert.ok(ordenListado(undefined, 'pedidos').includes('x.date_order ASC'));
    assert.ok(ordenListado(undefined, 'pedidos').includes("x.estado = 'saldado'"));
    assert.ok(ordenListado('nuevos', 'pedidos').includes('x.date_order DESC'));
    assert.ok(ordenListado('viejos', 'esperando_pago').includes('x.cotizacion_enviada_at ASC'));
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
    // Con el envío 1 validado, en el control el tope es lo armado
    const it = { qty_pedida: 3, qty_armada: 1 };
    assert.strictEqual(topeDeFase(it, 'controlando', 'done'), 1);
    assert.strictEqual(topeDeFase({ qty_pedida: 1, qty_armada: 0 }, 'controlando', 'done'), 0);
    assert.strictEqual(topeDeFase(it, 'controlando', 'assigned'), 3);
    assert.strictEqual(topeDeFase(it, 'armando', 'done'), 3);
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

// El pedido de pendientes lleva la etiqueta "Pendiente" (nueva o reusada) y
// se crea igual si la etiqueta no existe. Odoo y la base mockeados.
async function testEtiquetaPendientes() {
    const odooService = require('./odooService');
    const pool = require('../config/database');
    const originales = { ...odooService };
    const queryOriginal = pool.query;
    pool.query = async () => ({ rows: [] });

    const envio = { id: 1, partner_id: 9, company_key: 'neggo', odoo_order_name: 'S0001' };
    const plan = { pendientes: [{ odoo_product_id: 5, product_name: 'X', qty_pendiente: 2, price_unit: 10 }] };
    let creado = null;
    let etiquetado = null;
    odooService.createSaleOrder = async (partnerId, lines, companyKey, extra) => {
        creado = extra;
        return { id: 50, name: 'S0050' };
    };
    odooService.addSaleOrderTags = async (orderId, tagIds) => { etiquetado = { orderId, tagIds }; return true; };

    try {
        assert.strictEqual(ETIQUETA_PENDIENTES, 'Pendiente');

        odooService.findSaleTagIdByName = async (name) => (name === 'Pendiente' ? 6 : null);
        odooService.findSaleOrdersByOriginRef = async () => [];
        assert.deepStrictEqual(await asegurarBackorder(envio, plan), { id: 50, name: 'S0050' });
        assert.deepStrictEqual(creado.tag_ids, [6]);

        odooService.findSaleOrdersByOriginRef = async () => [{ id: 40, name: 'S0040' }];
        assert.deepStrictEqual(await asegurarBackorder(envio, plan), { id: 40, name: 'S0040' });
        assert.deepStrictEqual(etiquetado, { orderId: 40, tagIds: [6] });

        // Sin etiqueta en Odoo (o error buscándola): se crea sin tags.
        odooService.findSaleOrdersByOriginRef = async () => [];
        odooService.findSaleTagIdByName = async () => { throw new Error('caído'); };
        creado = null;
        await asegurarBackorder(envio, plan);
        assert.deepStrictEqual(creado.tag_ids, []);
    } finally {
        Object.assign(odooService, originales);
        pool.query = queryOriginal;
    }
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
    // Orden de venta confirmada directo en Odoo, sin factura ni POS: también se arma
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sale' })), true);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sale', pos_order_count: 1 })), false);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'cancel' })), false);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', invoice_status: 'invoiced' })), false);
    // Sólo arranca con cotizaciones enviadas (el pedido de pendientes en borrador espera en su solapa)
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'draft' })), false);
    const pend = { client_order_ref: 'Pendientes de S00042' };
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', ...pend })), true);
    assert.strictEqual(ordenFacturada(odooOrder({ invoice_status: 'invoiced' })), true);
    assert.strictEqual(ordenFacturada(odooOrder({ lines: [odooLine({ qty_invoiced: 1 })] })), true);
    // Con factura (aunque sea borrador) o derivada al POS no se arma
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', invoice_count: 1 })), false);
    assert.strictEqual(ordenCobradaAparte(odooOrder({ invoice_status: 'to invoice', invoice_count: 1 })), true);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', pos_order_count: 1 })), false);
    assert.strictEqual(ordenCobradaAparte(odooOrder({ pos_order_count: 1 })), true);
    assert.strictEqual(ordenCobradaAparte(odooOrder({})), false);
    // La base son los envíos de Odoo: 2 validados no se arma
    assert.strictEqual(ordenEnviosYaHechos(odooOrder({ done_picking_count: 2 })), true);
    assert.strictEqual(ordenEnviosYaHechos(odooOrder({ done_picking_count: 1 })), false);
    assert.strictEqual(esCotizacionParaArmar(odooOrder({ state: 'sent', done_picking_count: 2 })), false);
    const yaEnviada = auditarEmpezarArmar(odooOrder({ state: 'sale', done_picking_count: 2 }));
    assert.strictEqual(yaEnviada.ok, false);
    assert.match(yaEnviada.error, /envíos hechos/);
    const facturada = auditarEmpezarArmar(odooOrder({ state: 'sale', invoice_status: 'invoiced' }));
    assert.strictEqual(facturada.ok, false);
    assert.match(facturada.error, /factura|POS/);
}

function testEtapaDesdeEnviosOdoo() {
    const nahue = clasificarEnvios([
        { id: 6335, state: 'cancel', picking_type_code: 'internal' },
        { id: 6333, state: 'done', picking_type_code: 'internal' },
        { id: 6334, state: 'done', picking_type_code: 'outgoing' },
    ]);
    assert.deepStrictEqual(nahue, { para_armar: false, reabierto: false, envio1_done: true, envio2_done: true });
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 6333, state: 'done', picking_type_code: 'internal' },
        { id: 6334, state: 'done', picking_type_code: 'outgoing' },
    ] }), 'saldado');

    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'assigned', picking_type_code: 'internal' },
    ] }), 'pendiente');
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'done', picking_type_code: 'internal' },
        { id: 2, state: 'assigned', picking_type_code: 'outgoing' },
    ] }), 'armado');
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'done', picking_type_code: 'internal' },
    ] }), 'armado');
    assert.strictEqual(etapaDesdeOdoo({ done_picking_count: 2 }), 'saldado');
    assert.strictEqual(etapaDesdeOdoo({ done_picking_count: 1 }), 'armado');
    assert.strictEqual(etapaDesdeOdoo({ state: 'sent' }), 'pendiente');
    // Factura/POS no son etapa: el listado las saca, el envío sigue mandando el estado
    assert.strictEqual(etapaDesdeOdoo({ state: 'sale', pos_order_count: 1 }), 'pendiente');
    assert.strictEqual(etapaDesdeOdoo({ state: 'sale', invoice_status: 'invoiced' }), 'pendiente');
    assert.strictEqual(etapaDesdeOdoo({
        invoice_status: 'invoiced',
        pickings: [
            { id: 1, state: 'done', picking_type_code: 'internal' },
            { id: 2, state: 'done', picking_type_code: 'outgoing' },
        ],
    }), 'saldado');

    assert.strictEqual(estadoSegunOdoo('pendiente', 'saldado'), 'saldado');
    assert.strictEqual(estadoSegunOdoo('pendiente', 'armado'), 'armado');
    assert.strictEqual(estadoSegunOdoo('armando', 'armado'), 'armado');
    assert.strictEqual(estadoSegunOdoo('controlando', 'armado'), 'controlando');
    assert.strictEqual(estadoSegunOdoo('armando', 'pendiente'), 'armando');
    assert.strictEqual(estadoSegunOdoo('saldado', 'pendiente'), 'saldado');
    assert.strictEqual(estadoSegunOdoo('cancelado', 'saldado'), 'cancelado');

    // 1 paso: la entrega hecha es el armado; se controla en la app
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'done', picking_type_code: 'outgoing' },
    ] }), 'armado');
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'assigned', picking_type_code: 'outgoing' },
    ] }), 'pendiente');
}

// En Odoo agregaron productos después de armar: abre un Recolectar nuevo y vuelve a armar
function testReabiertoPorProductosNuevos() {
    const reabierto = [
        { id: 1, state: 'done', picking_type_code: 'internal' },
        { id: 2, state: 'done', picking_type_code: 'outgoing' },
        { id: 3, state: 'assigned', picking_type_code: 'internal' },
        { id: 4, state: 'waiting', picking_type_code: 'outgoing' },
    ];
    assert.strictEqual(clasificarEnvios(reabierto).reabierto, true);
    assert.strictEqual(etapaDesdeOdoo({ pickings: reabierto }), 'rearmar');
    assert.strictEqual(estadoSegunOdoo('saldado', 'rearmar'), 'pendiente');
    assert.strictEqual(estadoSegunOdoo('armado', 'rearmar'), 'pendiente');
    assert.strictEqual(estadoSegunOdoo('controlando', 'rearmar'), 'pendiente');
    // Si ya lo están armando, no se suelta
    assert.strictEqual(estadoSegunOdoo('armando', 'rearmar'), 'armando');
    assert.strictEqual(estadoSegunOdoo('pendiente', 'rearmar'), 'pendiente');
    // Recolectar cancelado no reabre
    assert.strictEqual(etapaDesdeOdoo({ pickings: [
        { id: 1, state: 'done', picking_type_code: 'internal' },
        { id: 2, state: 'done', picking_type_code: 'outgoing' },
        { id: 3, state: 'cancel', picking_type_code: 'internal' },
    ] }), 'saldado');
}

// Lo escaneado en la app no se pisa con lo de Odoo hasta que termina la etapa
function testFuentesDeQty() {
    const pickings = [
        { id: 1, state: 'done', picking_type_code: 'internal', moves: [{ id: 10, quantity: 2 }] },
        { id: 2, state: 'done', picking_type_code: 'outgoing', moves: [{ id: 20, quantity: 1 }] },
    ];
    assert.strictEqual(fuentesDeQty('armando', pickings).arm.length, 0);
    assert.strictEqual(fuentesDeQty('pendiente', pickings).arm.length, 0);
    assert.strictEqual(fuentesDeQty('armado', pickings).arm.length, 1);
    assert.strictEqual(fuentesDeQty('controlando', pickings).ctrl.length, 0);
    assert.strictEqual(fuentesDeQty('saldado', pickings).ctrl.length, 1);
    // 1 paso: la entrega es el armado y no hay envío de control
    const unPaso = [pickings[1]];
    assert.strictEqual(fuentesDeQty('armado', unPaso).arm[0].id, 20);
    assert.strictEqual(fuentesDeQty('saldado', unPaso).ctrl.length, 0);
}

// Al cerrar el control: pedida = entregada y el resto al pedido de pendientes
function testPlanIgualar() {
    const plan = planIgualar({
        lines: [
            { id: 1, product_id: 10, product_name: 'Taza', quantity: 6, qty_delivered: 6, unit_price: 100 },
            { id: 2, product_id: 11, product_name: 'Vaso', quantity: 4, qty_delivered: 1, unit_price: 50 },
            { id: 3, product_id: 12, product_name: 'Plato', quantity: 3, qty_delivered: 0, unit_price: 80 },
            { id: 4, product_id: 99, product_name: 'Down payment', quantity: 1, qty_delivered: 0 },
            { id: 5, product_id: null, product_name: 'Nota', quantity: 0 },
        ],
    });
    assert.deepStrictEqual(plan.writes.map((w) => [w.odoo_line_id, w.qty]), [[2, 1], [3, 0]]);
    assert.deepStrictEqual(
        plan.pendientes.map((p) => [p.odoo_product_id, p.qty_pendiente, p.price_unit]),
        [[11, 3, 50], [12, 3, 80]]
    );
    // Ya igualada (reintento): no escribe nada
    const igual = planIgualar({ lines: [{ id: 1, product_id: 10, quantity: 2, qty_delivered: 2 }] });
    assert.strictEqual(igual.writes.length + igual.pendientes.length, 0);
}

function testQtyDesdeMoves() {
    const items = [
        { id: 1, odoo_line_id: 74168, odoo_product_id: 68122, qty_pedida: 2 },
        { id: 2, odoo_line_id: 74179, odoo_product_id: 46148, qty_pedida: 2 },
        { id: 3, odoo_line_id: 99, odoo_product_id: 1, qty_pedida: 5 },
    ];
    const rec = [
        { sale_line_id: 74168, product_id: 68122, quantity: 2, state: 'done' },
        { sale_line_id: 74179, product_id: 46148, quantity: 2, state: 'done' },
        { sale_line_id: 88, product_id: 1, quantity: 3, state: 'cancel' },
    ];
    const armadas = qtyDesdeMoves(items, rec);
    assert.deepStrictEqual(armadas.map((x) => [x.id, x.qty]), [[1, 2], [2, 2], [3, 0]]);

    const porProducto = qtyDesdeMoves(
        [{ id: 9, odoo_line_id: null, odoo_product_id: 50, qty_pedida: 4 }],
        [{ sale_line_id: null, product_id: 50, quantity: 3, state: 'done' }]
    );
    assert.strictEqual(porProducto[0].qty, 3);
}

function testAuditarCancelarOrden() {
    const envio = (extra = {}) => ({ estado: 'pendiente', odoo_order_name: 'S00001', ...extra });

    assert.strictEqual(auditarCancelarOrden({ envio: null, odoo: null }).statusCode, 404);

    const controlando = auditarCancelarOrden({ envio: envio({ estado: 'controlando' }), odoo: { state: 'sale' } });
    assert.strictEqual(controlando.ok, false);
    assert.match(controlando.error, /controlando/);

    assert.strictEqual(auditarCancelarOrden({ envio: envio(), odoo: null }).statusCode, 404);

    const sent = auditarCancelarOrden({ envio: envio(), odoo: { name: 'S00001', state: 'sent' } });
    assert.deepStrictEqual(sent, { ok: true, alreadyCancelled: false });

    const armando = auditarCancelarOrden({ envio: envio({ estado: 'armando' }), odoo: { name: 'S00001', state: 'sale' } });
    assert.strictEqual(armando.ok, true);

    const yaCancelada = auditarCancelarOrden({ envio: envio(), odoo: { name: 'S00001', state: 'cancel' } });
    assert.deepStrictEqual(yaCancelada, { ok: true, alreadyCancelled: true });

    const facturada = auditarCancelarOrden({ envio: envio(), odoo: { name: 'S00001', state: 'sale', invoice_status: 'invoiced' } });
    assert.strictEqual(facturada.ok, false);
    assert.match(facturada.error, /facturada/);

    assert.strictEqual(auditarCancelarOrden({ envio: envio(), odoo: { name: 'S00001', state: 'done' } }).ok, false);

    const validado = auditarCancelarOrden({
        envio: envio({ estado: 'armando', odoo_picking_state: 'done', odoo_picking_name: 'WH/OUT/00010' }),
        odoo: { name: 'S00001', state: 'sale' },
    });
    assert.strictEqual(validado.ok, false);
    assert.match(validado.error, /WH\/OUT\/00010/);
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

    assert.strictEqual(armandoRequiereConfirmado({ estado: 'pendiente', odoo_state: 'sent' }).ok, true);
    assert.strictEqual(armandoRequiereConfirmado({ estado: 'armando', odoo_state: 'sale' }).ok, true);
    assert.strictEqual(armandoRequiereConfirmado({ estado: 'armando', odoo_state: 'done' }).ok, true);
    const sinConfirmar = armandoRequiereConfirmado({ estado: 'armando', odoo_state: 'sent', odoo_order_name: 'S0001' });
    assert.strictEqual(sinConfirmar.ok, false);
    assert.match(sinConfirmar.error, /confirmado/);
    assert.strictEqual(armandoRequiereConfirmado({ estado: 'armando', odoo_state: null }).ok, false);
}

function testPrimerPickingSalida() {
    assert.strictEqual(primerPickingSalida([]), null);
    assert.strictEqual(primerPickingSalida(null), null);
    const primero = primerPickingSalida([
        { id: 88, name: 'WH/IN/0001', picking_type_code: 'incoming' },
        { id: 91, name: 'WH/OUT/0002', picking_type_code: 'outgoing' },
        { id: 90, name: 'WH/OUT/0001', picking_type_code: 'outgoing' },
    ]);
    assert.strictEqual(primero.id, 90);
    assert.strictEqual(primero.name, 'WH/OUT/0001');

    const pickShip = primerPickingSalida([
        { id: 12, name: 'pre/OUT/1', picking_type_code: 'outgoing', state: 'waiting' },
        { id: 10, name: 'pre/PICK/1', picking_type_code: 'internal', state: 'assigned' },
        { id: 11, name: 'pre/PICK/2', picking_type_code: 'internal', state: 'cancel' },
    ]);
    assert.strictEqual(pickShip.id, 10);
    assert.strictEqual(pickShip.name, 'pre/PICK/1');
    assert.strictEqual(pickShip.state, 'assigned');

    const suelto = primerPickingSalida([{ id: 5, name: 'OUT/1' }]);
    assert.strictEqual(suelto.id, 5);
    assert.strictEqual(suelto.name, 'OUT/1');
}

function testPlanQtyMovesArmado() {
    const items = [
        { odoo_line_id: 10, odoo_product_id: 100, qty_pedida: 5, qty_armada: 3 },
        { odoo_line_id: 11, odoo_product_id: 101, qty_pedida: 2, qty_armada: 0 },
        { odoo_line_id: 12, odoo_product_id: 102, qty_pedida: 1, qty_armada: 1 },
    ];
    const moves = [
        { id: 1, sale_line_id: 10, product_id: 100, product_uom_qty: 5, state: 'assigned' },
        { id: 2, sale_line_id: 11, product_id: 101, product_uom_qty: 2, state: 'assigned' },
        { id: 3, sale_line_id: 12, product_id: 102, product_uom_qty: 1, state: 'assigned' },
        { id: 4, sale_line_id: 99, product_id: 999, product_uom_qty: 4, state: 'cancel' },
    ];
    const plan = planQtyMovesArmado(moves, items);
    assert.deepStrictEqual(plan.writes.map((w) => [w.id, w.quantity, w.demand]), [
        [1, 3, 5],
        [2, 0, 2],
        [3, 1, 1],
    ]);
    assert.strictEqual(plan.hayFaltante, true);
    assert.strictEqual(plan.hayAlgo, true);
    assert.strictEqual(hayFaltanteEnMoves(plan.writes), true);

    const completo = planQtyMovesArmado(
        [{ id: 1, sale_line_id: 10, product_id: 100, product_uom_qty: 5, state: 'assigned' }],
        [{ odoo_line_id: 10, odoo_product_id: 100, qty_pedida: 5, qty_armada: 5 }]
    );
    assert.strictEqual(completo.hayFaltante, false);
    assert.strictEqual(completo.writes[0].quantity, 5);

    const porProducto = planQtyMovesArmado(
        [{ id: 8, sale_line_id: null, product_id: 100, product_uom_qty: 5, state: 'assigned' }],
        [{ odoo_line_id: 10, odoo_product_id: 100, qty_pedida: 5, qty_armada: 2 }]
    );
    assert.strictEqual(porProducto.writes[0].quantity, 2);

    const vacio = planQtyMovesArmado(
        [{ id: 1, sale_line_id: 10, product_id: 100, product_uom_qty: 5, state: 'assigned' }],
        [{ odoo_line_id: 10, odoo_product_id: 100, qty_pedida: 5, qty_armada: 0 }]
    );
    assert.strictEqual(vacio.hayAlgo, false);
    assert.strictEqual(vacio.hayFaltante, true);

    // Entrega (2 pasos): se usa lo controlado, no lo armado
    const salida = planQtyMovesArmado(
        [{ id: 9, sale_line_id: 10, product_id: 100, product_uom_qty: 5, state: 'assigned' }],
        [{ odoo_line_id: 10, odoo_product_id: 100, qty_pedida: 5, qty_armada: 5, qty_controlada: 4 }],
        'qty_controlada'
    );
    assert.strictEqual(salida.writes[0].quantity, 4);
    assert.strictEqual(salida.hayFaltante, true);
}

function testWizardBackorder() {
    assert.strictEqual(esWizardBackorder(true), false);
    assert.strictEqual(esWizardBackorder(null), false);
    assert.strictEqual(esWizardBackorder({ type: 'ir.actions.act_window', res_model: 'stock.backorder.confirmation' }), true);
    assert.strictEqual(esWizardBackorder({ type: 'ir.actions.act_window', res_model: 'stock.immediate.transfer' }), false);
}

// Secuencia que odooService.validateSalePicking debe seguir en Odoo 19
// cuando qty < demanda y el tipo de operación está en create_backorder=ask.
function testMockOdooValidateFlow() {
    const calls = [];
    function fakeOdoo(model, method, args) {
        calls.push(`${model}.${method}`);
        if (model === 'stock.move' && method === 'write') {
            assert.strictEqual(args[1].picked, true);
            assert.ok(Object.prototype.hasOwnProperty.call(args[1], 'quantity'));
            return true;
        }
        if (model === 'stock.picking' && method === 'button_validate') {
            return {
                type: 'ir.actions.act_window',
                res_model: 'stock.backorder.confirmation',
                context: { button_validate_picking_ids: args[0] },
            };
        }
        if (model === 'stock.backorder.confirmation' && method === 'create') return 77;
        if (model === 'stock.backorder.confirmation' && method === 'process') return true;
        throw new Error(`call no mockeado: ${model}.${method}`);
    }

    fakeOdoo('stock.move', 'write', [[1], { quantity: 3, picked: true }]);
    const wizard = fakeOdoo('stock.picking', 'button_validate', [[10]]);
    assert.strictEqual(esWizardBackorder(wizard), true);
    assert.deepStrictEqual(wizard.context.button_validate_picking_ids, [10]);
    const wizId = fakeOdoo('stock.backorder.confirmation', 'create', [{}]);
    const done = fakeOdoo('stock.backorder.confirmation', 'process', [[wizId]]);
    assert.strictEqual(done, true);
    assert.deepStrictEqual(calls, [
        'stock.move.write',
        'stock.picking.button_validate',
        'stock.backorder.confirmation.create',
        'stock.backorder.confirmation.process',
    ]);
}

function testAuditarTerminarArmado() {
    const envio = { estado: 'armando', odoo_picking_id: 10, odoo_picking_name: 'pre/PICK/1' };
    assert.strictEqual(auditarTerminarArmado({ envio, picking: { id: 10, state: 'assigned' } }).ok, true);
    assert.strictEqual(auditarTerminarArmado({ envio, picking: { id: 10, state: 'done' } }).alreadyDone, true);

    const sinPicking = auditarTerminarArmado({ envio: { estado: 'armando' }, picking: null });
    assert.strictEqual(sinPicking.ok, false);
    assert.match(sinPicking.error, /envío 1/);

    const noArmando = auditarTerminarArmado({ envio: { estado: 'pendiente', odoo_picking_id: 1 }, picking: { id: 1 } });
    assert.strictEqual(noArmando.ok, false);

    const cancelado = auditarTerminarArmado({
        envio: { estado: 'armando', odoo_picking_id: 1, odoo_picking_name: 'X' },
        picking: { id: 1, name: 'X', state: 'cancel' },
    });
    assert.strictEqual(cancelado.ok, false);
    assert.match(cancelado.error, /cancelado/);
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
testListado();
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
testEtapaDesdeEnviosOdoo();
testQtyDesdeMoves();
testReabiertoPorProductosNuevos();
testFuentesDeQty();
testPlanIgualar();
testConfirmarAlEmpezar();
testPrimerPickingSalida();
testPlanQtyMovesArmado();
testWizardBackorder();
testMockOdooValidateFlow();
testAuditarTerminarArmado();
testAuditarSent();
testAuditarFacturada();
testAuditarEntregadaYLocked();
testAuditarCancelada();
testAuditarLineasDeMasYDeMenos();
testAuditarIgnoraDownPayment();
testAuditarSinOdoo();
testAuditarCancelarOrden();
testEtiquetaPendientes()
    .then(() => console.log('ok pedidoEnvio.test.js'))
    .catch((err) => { console.error(err); process.exit(1); });
