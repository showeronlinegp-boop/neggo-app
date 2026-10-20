// Parseo del CSV de ingreso y claves de SKU. Sin Odoo ni base de datos.
// node backend/services/ingresoParse.test.js

const assert = require('assert');
const { parsePrecio, parseCantidad, decodeCsv, supplierSkuKeys, parseCSV } = require('./ingresoService');

function testPrecio() {
    assert.strictEqual(parsePrecio('7.854,00'), 7854);
    assert.strictEqual(parsePrecio('$ 1.234,50'), 1234.5);
    assert.strictEqual(parsePrecio('1.234'), 1234);        // miles, formato argentino
    assert.strictEqual(parsePrecio('1234.56'), 1234.56);   // decimal con punto (Excel en inglés)
    assert.strictEqual(parsePrecio('12.5'), 12.5);
    assert.strictEqual(parsePrecio('1.234.567'), 1234567);
    assert.strictEqual(parsePrecio(''), 0);
    assert.strictEqual(parsePrecio('abc'), 0);
}

function testCantidad() {
    assert.strictEqual(parseCantidad('12'), 12);
    assert.strictEqual(parseCantidad(' 5,00 '), 5);
    assert.strictEqual(parseCantidad('1.000'), 1000);      // antes daba 1
    assert.ok(Number.isNaN(parseCantidad('2,5')));         // antes truncaba a 2
    assert.ok(Number.isNaN(parseCantidad('')));
}

function testDecode() {
    const texto = 'Código;Descripción\n1;Lámpara\n';
    assert.strictEqual(decodeCsv(Buffer.from(texto, 'utf-8')), texto);
    assert.strictEqual(decodeCsv(Buffer.from(texto, 'latin1')), texto);
}

function testSkuKeys() {
    assert.deepStrictEqual(supplierSkuKeys('0440209', 'CT'), ['0440209', 'PRECT0440209']);
    assert.deepStrictEqual(supplierSkuKeys('it-p113', 'IT'), ['ITP113', 'PREITITP113']);
    assert.deepStrictEqual(supplierSkuKeys('PRECT0440209', 'CT'), ['PRECT0440209']);
    assert.deepStrictEqual(supplierSkuKeys('', 'CT'), []);
    assert.deepStrictEqual(supplierSkuKeys('123', null), ['123']);
}

async function testParseCsvLatin1() {
    const csv = 'Código;Descripción;Cantidad;Precio\nA1;Lámpara de pie;1.000;1.234,50\nB2;Vaso;2,5;100\n';
    const result = await parseCSV(Buffer.from(csv, 'latin1'));
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].descripcion, 'Lámpara de pie');
    assert.strictEqual(result.data[0].cantidad, 1000);
    assert.strictEqual(result.data[0].precio_unitario, 1234.5);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0].error, /Cantidad inválida/);
}

(async () => {
    testPrecio();
    testCantidad();
    testDecode();
    testSkuKeys();
    await testParseCsvLatin1();
    console.log('✅ ingresoParse: todos los casos pasan');
    process.exit(0);
})().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
