// Detección de packs de la tabla maestra (nombre "xN" + costo Odoo ÷ neto ≈ 1/N). Sin base ni Odoo.
// node backend/services/tablaMaestra.test.js

const assert = require('assert');
const { packFromName, costRatio, decidirPack } = require('./tablaMaestraService');

function testPackPorNombre() {
    assert.strictEqual(packFromName('Bic Opaca Azul x 50 Un'), 50);
    assert.strictEqual(packFromName('Invisibles negros x 12'), 12);
    assert.strictEqual(packFromName('ADHESIVO EN BARRA VOLIBARRA 10g  x30'), 30);
    assert.strictEqual(packFromName('Mini brochecitos x100 Negros Art. 11731'), 100);
    assert.strictEqual(packFromName('LAPIZ X12UN'), 12);
    assert.strictEqual(packFromName('x24 MINAS CONSUL 0.5 HB'), 24);
    // Medidas, contenidos y sin pack
    assert.strictEqual(packFromName('Alfombra Coco Diseño Bienvenido 40x60'), null);
    assert.strictEqual(packFromName('CUADERNO UNIVERSITARIO 22 X 29 AVON 84 HOJAS'), null);
    assert.strictEqual(packFromName('CUADERNO TAPA DURA GLORIA x42 HOJAS AZUL'), null);
    assert.strictEqual(packFromName('REPUESTO EXITO x480 HOJAS RAYADO'), null);
    assert.strictEqual(packFromName('Shampoo x 500 ml'), null);
    assert.strictEqual(packFromName('TAZA CERAMICA 11CM ALTO'), null);
    assert.strictEqual(packFromName('Mouse x1'), null);
    assert.strictEqual(packFromName(null), null);
}

function testRatio() {
    assert.strictEqual(costRatio(100, 1200), 12);
    assert.strictEqual(costRatio(0, 1200), null);
    assert.strictEqual(costRatio(null, 1200), null);
    assert.strictEqual(costRatio(100, null), null);
}

function testDecidir() {
    // Costo Odoo por unidad 100, la oferta "x12" trae 12 a 1.200 (o cerca)
    assert.deepStrictEqual(decidirPack(12, 12), { cantidad: 12, origen: 'ambos' });
    assert.deepStrictEqual(decidirPack(12, 13), { cantidad: 12, origen: 'ambos' });   // 8 %: entra
    assert.deepStrictEqual(decidirPack(12, 11), { cantidad: 12, origen: 'ambos' });
    // "x12" pero Odoo vende el mismo pack (costo ≈ neto): unidad 1
    assert.deepStrictEqual(decidirPack(12, 1), { cantidad: 1, origen: 'costo' });
    assert.deepStrictEqual(decidirPack(12, 0.9), { cantidad: 1, origen: 'costo' });
    // Una sola señal o señales que no coinciden: no se cambia el pack, queda para revisar
    assert.deepStrictEqual(decidirPack(12, null), { cantidad: 1, origen: 'dudoso' });
    assert.deepStrictEqual(decidirPack(12, 5), { cantidad: 1, origen: 'dudoso' });
    assert.deepStrictEqual(decidirPack(12, 24), { cantidad: 1, origen: 'dudoso' });
    assert.deepStrictEqual(decidirPack(null, 24), { cantidad: 1, origen: 'dudoso' });
    // Sin "xN" y la misma unidad (o variación de precio): nada
    assert.strictEqual(decidirPack(null, 1.3), null);
    assert.strictEqual(decidirPack(null, 1), null);
    assert.strictEqual(decidirPack(null, null), null);
}

const tests = [testPackPorNombre, testRatio, testDecidir];
for (const t of tests) t();
console.log(`✅ tablaMaestra: ${tests.length} tests OK`);
