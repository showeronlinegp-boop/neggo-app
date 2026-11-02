// Clientes importantes de la API del agente (fase 1). Sin base ni Odoo.
// node backend/services/agenteImportantes.test.js

const assert = require('assert');
const { calcularClientesNuevos } = require('./agenteNuevos');
const {
    calcularImportantes, evaluarCliente, calcularTendencia, intervaloHabitualDias, ventanas,
    ordenarImportantes, resumenImportante, DEFAULTS,
} = require('./agenteImportantes');

const HOY = '2026-10-29';
let nextId = 1;

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

function clientesDe(tickets, lineas = []) {
    return calcularClientesNuevos({ tickets, lineas, hoy: HOY, dias: 100000 });
}

function importantesDe(tickets, opts = {}, lineas = []) {
    return calcularImportantes({
        clientes: clientesDe(tickets, lineas),
        hoy: HOY,
        dias: opts.dias ?? 60,
        monto_minimo: opts.monto_minimo ?? 1000000,
        monto_pedido_minimo: opts.monto_pedido_minimo ?? 500000,
        dias_pedido: opts.dias_pedido ?? 60,
        min_compras_intervalo: opts.min_compras_intervalo ?? 3,
        top: opts.top ?? null,
        marcas: opts.marcas ?? null,
    });
}

function testVentanas() {
    const v = ventanas('2026-10-29', 60);
    assert.deepStrictEqual(v.ventana, { desde: '2026-08-31', hasta: '2026-10-29' });
    assert.deepStrictEqual(v.ventana_anterior, { desde: '2026-07-02', hasta: '2026-08-30' });
}

function testMontoJustoCalifica() {
    // Exactamente $1.000.000 en la ventana (dos de $500.000: el umbral de pedido grande es >)
    // → solo monto_acumulado
    const r = importantesDe([
        ticket(1, '2026-09-15', { amount_total: 500000 }),
        ticket(1, '2026-10-01', { amount_total: 500000 }),
    ]);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].motivo_importante, ['monto_acumulado']);
    assert.strictEqual(r[0].total_comprado, 1000000);
    assert.strictEqual(r[0].ticket_promedio, 500000);
    assert.deepStrictEqual(r[0].pedidos_grandes, []);
}

function testMontoDebajoNoCalifica() {
    // Dos de $499.999,995 no; usamos 499999.99 + 500000 = 999999.99
    const r = importantesDe([
        ticket(1, '2026-09-15', { amount_total: 499999.99 }),
        ticket(1, '2026-10-01', { amount_total: 500000 }),
    ]);
    assert.deepStrictEqual(r, []);
}

function testDia61NoSuma() {
    // Ventana desde 2026-08-31; el 30/08 es el día 61 y no suma
    const r = importantesDe([
        ticket(1, '2026-08-30', { amount_total: 800000 }),
        ticket(1, '2026-10-01', { amount_total: 300000 }),
    ]);
    assert.deepStrictEqual(r, []);
    // Si la del 31 entra, llega a 1.100.000
    const ok = importantesDe([
        ticket(2, '2026-08-31', { amount_total: 800000 }),
        ticket(2, '2026-10-01', { amount_total: 300000 }),
    ]);
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(ok[0].total_comprado, 1100000);
}

function testPedidoExacto500000NoCalifica() {
    // Exactamente $500.000 → no es pedido_grande (hace falta >)
    const r = importantesDe([ticket(1, '2026-10-01', { amount_total: 500000 })], {
        monto_minimo: 999999999,
    });
    assert.deepStrictEqual(r, []);
}

function testPedidoGrandeCalifica() {
    const r = importantesDe([ticket(1, '2026-09-30', { amount_total: 612500 })]);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].motivo_importante, ['pedido_grande']);
    assert.strictEqual(r[0].pedidos_grandes.length, 1);
    assert.strictEqual(r[0].pedidos_grandes[0].monto, 612500);
    assert.strictEqual(r[0].total_comprado, 612500);
}

function testSoloPedidoGrandeBajoUmbral() {
    // Un solo pedido de $600.000: total < $1.000.000 → solo pedido_grande
    const r = importantesDe([ticket(1, '2026-10-01', { amount_total: 600000 })]);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].motivo_importante, ['pedido_grande']);
    assert.strictEqual(r[0].total_comprado, 600000);
    assert.strictEqual(r[0].pedidos_grandes[0].monto, 600000);
}

function testSenaYSaldoUnPedido() {
    const venta = [871, 'S00871'];
    const sena = ticket(1, '2026-09-20 14:00:00', { amount_total: 200000, sale_order_origin_id: venta });
    const saldo = ticket(1, '2026-09-30 14:00:00', { amount_total: 412500, sale_order_origin_id: venta });
    const r = importantesDe([sena, saldo]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].cantidad_compras, 1);
    assert.deepStrictEqual(r[0].motivo_importante, ['pedido_grande']);
    assert.strictEqual(r[0].pedidos_grandes[0].id, 'venta-871');
    assert.strictEqual(r[0].pedidos_grandes[0].referencia, 'S00871');
    assert.strictEqual(r[0].pedidos_grandes[0].monto, 612500);
}

function testDosTicketsMismoDiaDosCompras() {
    const r = importantesDe([
        ticket(1, '2026-10-01 12:00:00', { amount_total: 600000 }),
        ticket(1, '2026-10-01 18:00:00', { amount_total: 500000 }),
    ]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].cantidad_compras, 2);
    assert.strictEqual(r[0].total_comprado, 1100000);
    assert.strictEqual(r[0].ticket_promedio, 550000);
}

function testVariosMotivos() {
    const r = importantesDe([
        ticket(1, '2026-09-01', { amount_total: 500000 }),
        ticket(1, '2026-09-30', { amount_total: 612500 }),
    ]);
    assert.deepStrictEqual(r[0].motivo_importante, ['monto_acumulado', 'pedido_grande']);
    assert.strictEqual(r[0].pedidos_grandes.length, 1);
}

function testExcluidoGana() {
    const r = importantesDe(
        [ticket(1, '2026-10-01', { amount_total: 1500000 })],
        { marcas: new Map([[1, { tipo: 'excluido', nota: 'prueba', at: '2026-10-01T10:00:00-03:00' }]]) },
    );
    assert.deepStrictEqual(r, []);
}

function testManualFijo() {
    const r = importantesDe(
        [ticket(1, '2026-10-01', { amount_total: 1000 })],
        { marcas: { 1: { tipo: 'fijo', nota: 'amigo', at: '2026-10-01T10:00:00-03:00' } } },
    );
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].motivo_importante, ['manual']);
    assert.deepStrictEqual(r[0].pedidos_grandes, []);
    assert.strictEqual(r[0].marca_manual.tipo, 'fijo');
}

function testTopSinMontoMinimo() {
    const tickets = [
        ticket(1, '2026-10-01', { amount_total: 50000 }),
        ticket(2, '2026-10-01', { amount_total: 80000 }),
        ticket(3, '2026-10-01', { amount_total: 20000 }),
        ticket(4, '2026-10-01', { amount_total: 90000 }),
    ];
    const r = importantesDe(tickets, { top: 2, monto_minimo: 1000000 });
    assert.deepStrictEqual(r.map((c) => c.id), [4, 2]);
    // Con top, el umbral no filtra; el motivo monto_acumulado solo si llega al umbral
    assert.deepStrictEqual(r[0].motivo_importante, []);
    assert.strictEqual(r[0].total_comprado, 90000);
}

function testTendencia() {
    assert.deepStrictEqual(calcularTendencia(100, 0), {
        periodo_anterior: 0, variacion_pct: null, direccion: 'sin_datos',
    });
    assert.deepStrictEqual(calcularTendencia(1268000, 1610000), {
        periodo_anterior: 1610000, variacion_pct: -21, direccion: 'baja',
    });
    assert.deepStrictEqual(calcularTendencia(110, 100).direccion, 'estable');
    assert.deepStrictEqual(calcularTendencia(120, 100).direccion, 'sube');

    const r = importantesDe([
        ticket(1, '2026-08-15', { amount_total: 2000000 }), // período anterior
        ticket(1, '2026-10-01', { amount_total: 1000000 }),
    ]);
    assert.strictEqual(r[0].tendencia.direccion, 'baja');
    assert.strictEqual(r[0].tendencia.periodo_anterior, 2000000);
}

function testTendenciaSinDatos() {
    // $1.500.000 en un solo pedido también marca pedido_grande; nos alcanza con que califique
    const r = importantesDe([ticket(1, '2026-10-01', { amount_total: 1500000 })]);
    assert.deepStrictEqual(r[0].tendencia, {
        periodo_anterior: 0, variacion_pct: null, direccion: 'sin_datos',
    });
}

function testIntervaloHabitual() {
    const compras = [
        { id: 'a', fecha: '2026-09-01T12:00:00-03:00', monto: 1 },
        { id: 'b', fecha: '2026-09-11T12:00:00-03:00', monto: 1 },
        { id: 'c', fecha: '2026-09-21T12:00:00-03:00', monto: 1 },
    ];
    assert.strictEqual(intervaloHabitualDias(compras, HOY, 3), 10);
    assert.strictEqual(intervaloHabitualDias(compras.slice(0, 2), HOY, 3), null);
}

function testDiasSinComprar() {
    const r = importantesDe([ticket(1, '2026-09-30', { amount_total: 1500000 })]);
    assert.strictEqual(r[0].dias_sin_comprar, 29);
    assert.ok(r[0].ultima_compra.startsWith('2026-09-30'));
}

function testOrden() {
    const lista = [
        { id: 1, nombre: 'B', total_comprado: 100, dias_sin_comprar: 5, ultima_compra: '2026-10-01', tendencia: { variacion_pct: -5, direccion: 'estable' } },
        { id: 2, nombre: 'A', total_comprado: 200, dias_sin_comprar: 10, ultima_compra: '2026-09-01', tendencia: { variacion_pct: -40, direccion: 'baja' } },
        { id: 3, nombre: 'C', total_comprado: 50, dias_sin_comprar: 1, ultima_compra: '2026-10-20', tendencia: { variacion_pct: null, direccion: 'sin_datos' } },
    ];
    assert.deepStrictEqual(ordenarImportantes(lista, 'monto_desc').map((c) => c.id), [2, 1, 3]);
    assert.deepStrictEqual(ordenarImportantes(lista, 'nombre').map((c) => c.id), [2, 1, 3]);
    assert.deepStrictEqual(ordenarImportantes(lista, 'tendencia_asc').map((c) => c.id), [2, 1, 3]);
    assert.deepStrictEqual(ordenarImportantes(lista, 'dias_sin_comprar_desc').map((c) => c.id), [2, 1, 3]);
}

function testResumenImportante() {
    const [c] = clientesDe([
        ticket(1, '2026-09-15', { amount_total: 500000 }),
        ticket(1, '2026-10-01', { amount_total: 500000 }),
    ]);
    const s = resumenImportante(c, DEFAULTS, HOY);
    assert.strictEqual(s.es_importante, true);
    assert.deepStrictEqual(s.motivo_importante, ['monto_acumulado']);
    assert.strictEqual(s.marca_manual, null);
}

function testPedidoFueraDeVentanaPedido() {
    // Pedido grande hace 90 días: no califica por pedido_grande con dias_pedido=60
    const r = importantesDe([ticket(1, '2026-07-01', { amount_total: 612500 })], {
        monto_minimo: 999999999,
        dias_pedido: 60,
    });
    assert.deepStrictEqual(r, []);
}

function testEvaluarSinMarcaFase1() {
    const [c] = clientesDe([ticket(1, '2026-10-01', { amount_total: 1500000 })]);
    const ev = evaluarCliente(c, {
        hoy: HOY, dias: 60, monto_minimo: 1000000, monto_pedido_minimo: 500000,
        dias_pedido: 60, min_compras_intervalo: 3,
    }, null);
    assert.strictEqual(ev.marca_manual, null);
    assert.ok(!ev.motivo_importante.includes('manual'));
}

const tests = [
    testVentanas,
    testMontoJustoCalifica,
    testMontoDebajoNoCalifica,
    testDia61NoSuma,
    testPedidoExacto500000NoCalifica,
    testPedidoGrandeCalifica,
    testSoloPedidoGrandeBajoUmbral,
    testSenaYSaldoUnPedido,
    testDosTicketsMismoDiaDosCompras,
    testVariosMotivos,
    testExcluidoGana,
    testManualFijo,
    testTopSinMontoMinimo,
    testTendencia,
    testTendenciaSinDatos,
    testIntervaloHabitual,
    testDiasSinComprar,
    testOrden,
    testResumenImportante,
    testPedidoFueraDeVentanaPedido,
    testEvaluarSinMarcaFase1,
];

for (const t of tests) t();
console.log(`✅ agenteImportantes: ${tests.length} tests OK`);
