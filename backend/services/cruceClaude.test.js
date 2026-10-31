// Cruce de productos revisado por Claude: armado de la tanda, lectura y validación de respuestas.
// Sin base de datos. node backend/services/cruceClaude.test.js

const assert = require('assert');
const {
    idLote, armarProductos, formatearLote, parsearDecisiones, validarDecisiones,
} = require('./cruceClaudeService');

const productos = [
    { odoo_id: 10, name: 'Pila AA Noga recargable x2', internal_ref: 'NG-2700', standard_price: '4783',
      list_price: '7175', categ_name: 'Tecnología', vendor_name: 'Impotekno', active: false, confirmados_con: ['Impotekno'] },
    { odoo_id: 20, name: 'Mate Stanley 240ml', internal_ref: null, standard_price: '6975',
      list_price: '9765', categ_name: 'Bazar', vendor_name: 'Babu', active: true, confirmados_con: [] },
];
const filas = [
    { odoo_id: 10, supplier_product_id: 100, proveedor: 'CastMayorista', mismo_proveedor: false, sku: null, codigo_proveedor: 'P27',
      name: 'PILAS AA RECARGABLES NOGA X2', source_category: 'Pilas', available: true, pack_cantidad: 1, precio_comparable: '4500', last_scraped_at: null },
    { odoo_id: 20, supplier_product_id: 200, proveedor: 'Babu', mismo_proveedor: true, sku: 'MST240',
      name: 'MATE STANLEY 240ML', source_category: 'MATE', available: true, pack_cantidad: 1, precio_comparable: '6975', last_scraped_at: '2026-10-29T10:00:00Z' },
    { odoo_id: 20, supplier_product_id: 201, proveedor: 'Babu', mismo_proveedor: true, sku: null,
      name: 'BOTELLA STANLEY 750', source_category: 'BOTELLAS', available: false, pack_cantidad: 6, precio_comparable: null, last_scraped_at: null },
];

function testIdLote() {
    assert.strictEqual(idLote(new Date('2026-10-31T09:05:07Z')), 'cruce-20261031-090507');
}

function testArmar() {
    // Azar fijo: el orden queda como viene
    let k = 0;
    const armados = armarProductos(productos, filas, () => k++);
    assert.strictEqual(armados.length, 2);
    assert.deepStrictEqual(armados[0].candidatos.map(c => [c.letra, c.supplier_product_id, c.sku]), [['a', 100, 'P27']]);
    // Sin código del proveedor queda el SKU
    assert.strictEqual(armados[1].candidatos[0].sku, 'MST240');
    assert.deepStrictEqual(armados[1].candidatos.map(c => c.letra), ['a', 'b']);
    assert.strictEqual(armados[1].candidatos[1].precio, null);
    assert.strictEqual(armados[0].activo, false);
    assert.strictEqual(armados[0].costo, 4783);

    const texto = formatearLote({ id: 'cruce-x', productos: armados });
    assert.ok(texto.includes('#10  Pila AA Noga recargable x2  [ref NG-2700]'));
    assert.ok(texto.includes('ARCHIVADO (agotado)'));
    assert.ok(texto.includes('ya confirmado con: Impotekno'));
    assert.ok(texto.includes('b) BOTELLA STANLEY 750'));
    assert.ok(texto.includes('sin precio'));
    assert.ok(texto.includes('pack x6'));
    // No muestra el puntaje de parecido
    assert.ok(!/parecido/i.test(texto.split('\n').filter(l => !l.startsWith('#')).join('\n')));
}

function testParsear() {
    const { decisiones, errores } = parsearDecisiones([
        '# comentario',
        '10 a alta Mismo modelo y marca, 2700 mAh',
        '',
        '20 - Ninguno: son botellas',
        '#30 ? falta el color',
        '40 b',
        'cualquier cosa',
    ].join('\n'));
    assert.deepStrictEqual(decisiones, [
        { odoo_id: 10, marca: 'a', confianza: 'alta', motivo: 'Mismo modelo y marca, 2700 mAh' },
        { odoo_id: 20, marca: '-', confianza: null, motivo: 'Ninguno: son botellas' },
        { odoo_id: 30, marca: '?', confianza: null, motivo: 'falta el color' },
    ]);
    assert.strictEqual(errores.length, 2);
    assert.match(errores[0], /falta la confianza/);
    assert.match(errores[1], /no se entiende/);
}

function testValidar() {
    const armados = armarProductos(productos, filas, (() => { let k = 0; return () => k++; })());
    const { validas, errores, faltan } = validarDecisiones(armados, [
        { odoo_id: 20, marca: 'a', confianza: 'media', motivo: 'mismo' },
        { odoo_id: 20, marca: 'b', confianza: 'alta', motivo: null },
        { odoo_id: 99, marca: '-', confianza: null, motivo: null },
    ]);
    assert.strictEqual(validas.length, 1);
    assert.strictEqual(validas[0].supplier_product_id, 200);
    assert.strictEqual(validas[0].resultado, 'elegido');
    assert.deepStrictEqual(faltan, [10]);
    assert.strictEqual(errores.length, 2);

    const r2 = validarDecisiones(armados, [
        { odoo_id: 10, marca: 'z', confianza: 'alta', motivo: null },
        { odoo_id: 20, marca: '?', confianza: null, motivo: 'color' },
    ]);
    assert.match(r2.errores[0], /letra "z" no existe/);
    assert.strictEqual(r2.validas[0].resultado, 'duda');
    assert.strictEqual(r2.validas[0].supplier_product_id, null);
}

testIdLote();
testArmar();
testParsear();
testValidar();
console.log('✅ cruceClaude: todos los casos pasan');
process.exit(0);
