// Sugerencias de oferta en la tarjeta de Ingreso y reglas de lo que se vincula solo (nota 162). Sin base.
// node backend/services/ingresoVinculos.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { puntuarOferta, elegirOfertas } = require('./ingresoVinculosService');

const TIBETANO = {
    descripcion: 'Mini Tibetanos x 5 u. AROMANZA',
    odoo_product_name: 'Mini Sahumerio Tibetano Aromanza',
    precio_unitario: '943.00',
};
const correcta = { id: 44026, sku: 'PRERY305939963', name: 'Sahumerios Mini Tibetano x5 Aromanza', raw_price: '943.00', available: false, rechazada: false };
const parecida = { id: 43930, sku: 'PRERY305939545', name: 'Sahumerios Tibetanos Aromanza', raw_price: '1939.00', available: true, rechazada: false };
const otra = { id: 1, sku: 'PRERY1', name: 'Cuenco de bronce grande', raw_price: '49850.00', available: true, rechazada: false };

function testMismoPrecio() {
    assert.strictEqual(puntuarOferta(TIBETANO, correcta).mismo_precio, true);
    assert.strictEqual(puntuarOferta(TIBETANO, parecida).mismo_precio, false);
    // Sin precio no suma
    assert.strictEqual(puntuarOferta({ ...TIBETANO, precio_unitario: null }, correcta).mismo_precio, false);
    assert.strictEqual(puntuarOferta(TIBETANO, { ...correcta, raw_price: null }).mismo_precio, false);
}

function testSugerencias() {
    // El caso de la nota: la correcta está agotada, se parece menos, pero tiene el mismo precio
    const lista = elegirOfertas(TIBETANO, [parecida, otra, correcta]);
    assert.strictEqual(lista[0].id, correcta.id);
    assert.ok(!lista.some(o => o.id === otra.id), 'lo que no se parece no se sugiere');

    // Lo rechazado no se vuelve a sugerir
    const sinRechazada = elegirOfertas(TIBETANO, [{ ...correcta, rechazada: true }, parecida]);
    assert.deepStrictEqual(sinRechazada.map(o => o.id), [parecida.id]);
}

function testBusqueda() {
    // Cualquier orden, sin acentos, por nombre o SKU; lo agotado y lo rechazado aparecen
    const porNombre = elegirOfertas(TIBETANO, [{ ...correcta, rechazada: true }, parecida, otra], 'tibetano mini');
    assert.deepStrictEqual(porNombre.map(o => o.id), [correcta.id]);
    assert.deepStrictEqual(elegirOfertas(TIBETANO, [parecida, otra], 'bronce').map(o => o.id), [otra.id]);
    assert.deepStrictEqual(elegirOfertas(TIBETANO, [correcta, otra], 'prery305939963').map(o => o.id), [correcta.id]);
    assert.deepStrictEqual(elegirOfertas(TIBETANO, [correcta], 'no existe'), []);
}

// Las reglas que están en SQL: si alguien las afloja, que salte acá
function testReglasEnSql() {
    const vinculos = fs.readFileSync(path.join(__dirname, 'ingresoVinculosService.js'), 'utf8');
    assert.ok(vinculos.includes("ii.supplier_match_level = 'exact_code'"), 'solo el código exacto se vincula solo');
    assert.ok(vinculos.includes("md.decision = 'rechazado'"), 'lo rechazado no vuelve a vincularse solo');

    const maestra = fs.readFileSync(path.join(__dirname, 'tablaMaestraService.js'), 'utf8');
    assert.ok(maestra.includes("NOT IN ('manual', 'fuzzy')"), 'por nombre parecido no se vincula sin tildar');
    assert.ok(maestra.includes('c.vinculo_revisado_at IS NULL OR md.created_at'), 'sin tildar no revive un rechazo');

    const ingreso = fs.readFileSync(path.join(__dirname, 'ingresoService.js'), 'utf8');
    assert.ok(ingreso.includes("ii.supplier_match_level IN ('manual', 'fuzzy')"), 'el parecido se pregunta al confirmar');
}

testMismoPrecio();
testSugerencias();
testBusqueda();
testReglasEnSql();
console.log('✅ ingresoVinculos ok');
process.exit(0);
