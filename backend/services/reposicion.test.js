// Detección de transiciones, bajo stock y ABC para la cola de reposición. Sin base de datos.
// node backend/services/reposicion.test.js

const assert = require('assert');
const {
    detectarTransiciones,
    detectarBajoStock,
    clasificarAbc,
    lunesDe,
} = require('./reposicionService');

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

function testBajoStock() {
    const productos = [
        { id: 1, active: true, qty_available: 0 },
        { id: 2, active: true, qty_available: 3 },
        { id: 3, active: true, qty_available: 10 },
        { id: 4, active: false, qty_available: 1 }, // archivado: no entra por bajo_stock
        { id: 5, active: true, qty_available: null },
    ];
    assert.deepStrictEqual(detectarBajoStock(productos, 3), [1, 2]);
}

function testAbc() {
    const items = [
        { odoo_id: 1, amount_30d: 800 },
        { odoo_id: 2, amount_30d: 150 },
        { odoo_id: 3, amount_30d: 50 },
    ];
    const labels = clasificarAbc(items);
    assert.strictEqual(labels.get(1), 'A'); // 80% acumulado
    assert.strictEqual(labels.get(2), 'B');
    assert.strictEqual(labels.get(3), 'C');
}

function testLunesDe() {
    // 2026-10-20 es martes → lunes 2026-10-19
    assert.strictEqual(lunesDe('2026-10-20T15:00:00Z'), '2026-10-19');
    // domingo → lunes anterior
    assert.strictEqual(lunesDe('2026-10-18T12:00:00Z'), '2026-10-12');
}

testTransiciones();
testCacheVacio();
testBajoStock();
testAbc();
testLunesDe();
console.log('✅ reposicion: todos los casos pasan');
process.exit(0);
