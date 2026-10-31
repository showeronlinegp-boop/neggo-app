// Detección de transiciones, Pareto ABC, ranking de catálogo y Encargado × ingresos.
// Sin base de datos. node backend/services/reposicion.test.js

const assert = require('assert');
const {
    detectarTransiciones,
    clasificarAbc,
    lunesDe,
    vendorLabel,
    origenDesdeActivo,
    rankearMasVendidos,
    rankearActivos,
    rankearArchivados,
    ESTADOS_ABIERTOS,
    ESTADOS_FINALES,
    cruzaIngresoActivoNeggo,
    resumirSemanas,
} = require('./reposicionService');
const { sumQtyByProduct } = require('./odooService');
const { agregarLineas, fechaDesde, semanasATraer } = require('../jobs/salesWeeklySync');

function testTransiciones() {
    const antes = new Map([
        [1, true],
        [2, true],
        [3, false],
        [4, false],
    ]);
    const productos = [
        { id: 1, active: true },
        { id: 2, active: false },
        { id: 3, active: true },
        { id: 4, active: false },
        { id: 5, active: false },
    ];
    const r = detectarTransiciones(antes, productos);
    assert.deepStrictEqual(r.archivados, [2]);
    assert.deepStrictEqual(r.reactivados, [3]);
}

function testCacheVacio() {
    const r = detectarTransiciones(new Map(), [{ id: 1, active: false }, { id: 2, active: true }]);
    assert.deepStrictEqual(r, { archivados: [], reactivados: [] });
}

function testAbcPorUnidades() {
    const items = [
        { odoo_id: 1, qty_30d: 800 },
        { odoo_id: 2, qty_30d: 150 },
        { odoo_id: 3, qty_30d: 50 },
    ];
    const labels = clasificarAbc(items);
    assert.strictEqual(labels.get(1), 'A');
    assert.strictEqual(labels.get(2), 'B');
    assert.strictEqual(labels.get(3), 'C');
}

function testResumirSemanas() {
    const lunes = '2026-10-26';
    // Vendió 6 en una sola de las 4 semanas completas: promedio 1,5, no 6
    const una = resumirSemanas([{ week_start: '2026-10-05', qty_vendida: 6 }], lunes);
    assert.strictEqual(una.avg_weekly, 1.5);
    assert.strictEqual(una.qty_7d, 0);
    assert.strictEqual(una.semanas_con_venta, 1);
    assert.strictEqual(una.ritmo, 'flojo');

    // Parejo las 4 semanas, más lo que va de la actual
    const parejo = resumirSemanas([
        { week_start: '2026-10-26', qty_vendida: 2 },
        { week_start: '2026-10-19', qty_vendida: 4 },
        { week_start: '2026-10-12', qty_vendida: 4 },
        { week_start: '2026-10-05', qty_vendida: 4 },
        { week_start: '2026-09-28', qty_vendida: 4 },
        { week_start: '2026-08-31', qty_vendida: 9 },
    ], lunes);
    assert.strictEqual(parejo.avg_weekly, 4);
    assert.strictEqual(parejo.qty_7d, 4);
    assert.strictEqual(parejo.qty_semana_actual, 2);
    assert.strictEqual(parejo.qty_30d, 18);
    assert.strictEqual(parejo.semanas_con_venta, 5);
    assert.strictEqual(parejo.ritmo, 'estable');

    // Recién empezó esta semana
    const nuevo = resumirSemanas([{ week_start: '2026-10-26', qty_vendida: 3 }], lunes);
    assert.strictEqual(nuevo.avg_weekly, 0);
    assert.strictEqual(nuevo.ritmo, 'reponer');

    // Fuera de las 12 semanas no cuenta
    const viejo = resumirSemanas([{ week_start: '2026-07-27', qty_vendida: 50 }], lunes);
    assert.strictEqual(viejo.semanas_con_venta, 0);
    assert.strictEqual(viejo.ritmo, 'sin_datos');
}

function testAgregarLineasVentas() {
    const fechas = new Map([[1, '2026-10-20 15:00:00'], [2, '2026-10-27 10:00:00']]);
    const agg = agregarLineas([
        { product_id: [10, 'Taza'], order_id: [1, 'S1'], product_uom_qty: 2, price_subtotal: 100 },
        { product_id: [10, 'Taza'], order_id: [1, 'S1'], product_uom_qty: 1, price_subtotal: 50 },
        { product_id: [99, 'Down Payment (POS)'], order_id: [1, 'S1'], product_uom_qty: 1, price_subtotal: 500 },
        { product_id: [10, 'Taza'], order_id: [2, 'S2'], product_uom_qty: 4, price_subtotal: 200 },
        { product_id: false, order_id: [2, 'S2'], product_uom_qty: 9 },
    ], fechas, 'product_uom_qty', new Set([99]));
    assert.strictEqual(agg.size, 2);
    assert.deepStrictEqual(agg.get('10|2026-10-19'), { odoo_id: 10, week_start: '2026-10-19', qty: 3, amount: 150 });
    assert.strictEqual(agg.get('10|2026-10-26').qty, 4);
}

function testVentanaDelSync() {
    assert.strictEqual(fechaDesde(6, new Date('2026-10-30T12:00:00Z')), '2026-09-14');
    assert.strictEqual(semanasATraer(0), 52);
    assert.strictEqual(semanasATraer(40), 6);
}

function testLunesDe() {
    assert.strictEqual(lunesDe('2026-10-20T15:00:00Z'), '2026-10-19');
    assert.strictEqual(lunesDe('2026-10-18T12:00:00Z'), '2026-10-12');
}

function testVendorYOrigen() {
    assert.strictEqual(vendorLabel('  ZLE  '), 'ZLE');
    assert.strictEqual(vendorLabel(''), 'Sin proveedor');
    assert.strictEqual(vendorLabel(null), 'Sin proveedor');
    assert.strictEqual(origenDesdeActivo(true), 'reponer');
    assert.strictEqual(origenDesdeActivo(false), 'archivado');
}

function testRankearMasVendidos() {
    const qty = new Map([[1, 12], [2, 3], [3, 12], [9, 50]]);
    const productos = [
        { odoo_id: 1, name: 'B' },
        { odoo_id: 2, name: 'C' },
        { odoo_id: 3, name: 'A' },
        { odoo_id: 4, name: 'Sin ventas' },
    ];
    const top = rankearMasVendidos(productos, qty, 2);
    assert.deepStrictEqual(top.map(p => p.odoo_id), [3, 1]);
    assert.strictEqual(top[0].qty_semana, 12);
    assert.ok(!top.some(p => p.odoo_id === 9));
}

function testRankearActivos() {
    const qty = new Map([[1, 2], [2, 9]]);
    const productos = [
        { odoo_id: 1, name: 'B', active: true },
        { odoo_id: 2, name: 'A', active: true },
        { odoo_id: 3, name: 'Sin ventas', active: true },
        { odoo_id: 4, name: 'Archivado top', active: false },
    ];
    const lista = rankearActivos(productos, qty);
    assert.deepStrictEqual(lista.map(p => p.odoo_id), [2, 1, 3]);
    assert.ok(!lista.some(p => p.odoo_id === 4));
}

function testRankearArchivados() {
    const qty = new Map([[1, 4], [2, 20], [3, 20]]);
    const productos = [
        { odoo_id: 1, name: 'Viejo', active: false },
        { odoo_id: 2, name: 'B', active: false },
        { odoo_id: 3, name: 'A', active: false },
        { odoo_id: 4, name: 'Sin ventas', active: false },
        { odoo_id: 5, name: 'Activo top', active: true },
    ];
    const lista = rankearArchivados(productos, qty, 3);
    assert.deepStrictEqual(lista.map(p => p.odoo_id), [3, 2, 1]);
    assert.ok(!lista.some(p => p.active));
    assert.ok(!lista.some(p => p.odoo_id === 4));
}

function testSumQty() {
    const map = sumQtyByProduct([
        { product_id: [10, 'X'], product_uom_qty: 2 },
        { product_id: 10, product_uom_qty: 3 },
        { product_id: false, product_uom_qty: 9 },
        { product_id: [11, 'Y'], product_uom_qty: 0 },
    ], 'product_uom_qty');
    assert.strictEqual(map.get(10), 5);
    assert.strictEqual(map.has(11), false);
}

function testEstadosEncargado() {
    assert.ok(ESTADOS_ABIERTOS.includes('encargado'));
    assert.ok(ESTADOS_ABIERTOS.includes('pendiente'));
    assert.ok(!ESTADOS_FINALES.includes('encargado'));
    assert.deepStrictEqual(ESTADOS_FINALES, ['repuesto', 'descartado']);
}

function testCruzaIngreso() {
    const base = {
        estadoItem: 'matched',
        odooActive: true,
        odooCompany: 'neggo',
        ingresoEstado: 'confirmed',
        preventaQtyConfirmed: 0,
        cantidad: 12,
        ingresoAt: '2026-10-20T12:00:00Z',
        colaCreatedAt: '2026-10-19T12:00:00Z',
    };
    assert.strictEqual(cruzaIngresoActivoNeggo(base), true);
    assert.strictEqual(cruzaIngresoActivoNeggo({ ...base, odooActive: false }), false);
    assert.strictEqual(cruzaIngresoActivoNeggo({ ...base, odooCompany: 'preventas' }), false);
    assert.strictEqual(cruzaIngresoActivoNeggo({ ...base, ingresoEstado: 'rechazado' }), false);
    assert.strictEqual(cruzaIngresoActivoNeggo({ ...base, preventaQtyConfirmed: 12 }), false);
    assert.strictEqual(cruzaIngresoActivoNeggo({
        ...base, ingresoAt: '2026-10-01T12:00:00Z', colaCreatedAt: '2026-10-19T12:00:00Z',
    }), false);
    assert.strictEqual(cruzaIngresoActivoNeggo({ ...base, odooActive: null }), true);
}

testTransiciones();
testCacheVacio();
testAbcPorUnidades();
testResumirSemanas();
testAgregarLineasVentas();
testVentanaDelSync();
testLunesDe();
testVendorYOrigen();
testRankearMasVendidos();
testRankearActivos();
testRankearArchivados();
testSumQty();
testEstadosEncargado();
testCruzaIngreso();
console.log('✅ reposicion: todos los casos pasan');
process.exit(0);
