// Tabla maestra: detección de packs (nombre "xN" + costo Odoo ÷ neto ≈ 1/N) y método de los vínculos de Ingresos. Sin base ni Odoo.
// node backend/services/tablaMaestra.test.js

const assert = require('assert');
const { packFromName, costRatio, decidirPack, esRenglonManual, metodoDesdeIngreso, resumirOfertas } = require('./tablaMaestraService');

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

// Ingresos → tabla maestra: qué es manual y con qué método queda el vínculo
function testMetodoIngreso() {
    assert.strictEqual(esRenglonManual({ match_level: 'manual', supplier_match_level: 'exact_code' }), true);
    assert.strictEqual(esRenglonManual({ match_level: 'ref_prefix', supplier_match_level: 'manual' }), true);
    assert.strictEqual(esRenglonManual({ match_level: 'ref_prefix', supplier_match_level: 'fuzzy' }), false);
    assert.strictEqual(metodoDesdeIngreso({ match_level: 'manual', supplier_match_level: 'fuzzy' }), 'ingreso_manual');
    // Producto automático + oferta por nombre parecido: entra directo (Mariano, 29/10)
    assert.strictEqual(metodoDesdeIngreso({ match_level: 'ref_prefix', supplier_match_level: 'fuzzy' }), 'ingreso_nombre');
    assert.strictEqual(metodoDesdeIngreso({ match_level: 'invoice_mapping', supplier_match_level: 'exact_code' }), 'ingreso');
    assert.strictEqual(metodoDesdeIngreso({ match_level: null, supplier_match_level: 'exact_code' }), 'ingreso');
}

// Reposición: más económico y "conviene otro proveedor"
function testMasEconomico() {
    const ahora = new Date('2026-10-29T12:00:00Z');
    const reciente = '2026-10-28T12:00:00Z';
    const of = (proveedor, precio, extra = {}) => ({
        supplier_product_id: proveedor.length, proveedor, name: proveedor, precio_comparable: precio,
        available: true, last_scraped_at: reciente, es_principal: false, ...extra,
    });

    // Alif más barato que Babu (principal): conviene Alif −13,1 %
    let r = resumirOfertas([of('Babu', 2213.4, { es_principal: true }), of('Alif', 1922.8)], { costo: 2000, ahora });
    assert.strictEqual(r.mas_economico.proveedor, 'Alif');
    assert.deepStrictEqual(r.conviene, { proveedor: 'Alif', pct: -13.1, contra: 'proveedor_del_pedido' });
    assert.strictEqual(r.pct_vs_costo, -3.9);

    // A igual precio gana el principal y no hay "conviene"
    r = resumirOfertas([of('Alif', 100), of('Babu', 100, { es_principal: true })], { ahora });
    assert.strictEqual(r.mas_economico.proveedor, 'Babu');
    assert.strictEqual(r.conviene, null);

    // Principal sin oferta web: se compara contra el costo actual
    r = resumirOfertas([of('Alif', 90)], { costo: 100, ahora });
    assert.deepStrictEqual(r.conviene, { proveedor: 'Alif', pct: -10, contra: 'costo_actual' });
    r = resumirOfertas([of('Alif', 110)], { costo: 100, ahora });
    assert.strictEqual(r.conviene, null);

    // No disponible no compite; sin precio (ZLE) queda afuera; precio viejo a los 7 días
    r = resumirOfertas([of('Alif', 50, { available: false }), of('ZLE', null),
        of('Babu', 80, { es_principal: true, last_scraped_at: '2026-10-20T12:00:00Z' })], { ahora });
    assert.strictEqual(r.mas_economico.proveedor, 'Babu');
    assert.strictEqual(r.mas_economico.precio_viejo, true);
    assert.strictEqual(r.ofertas.length, 2);
    assert.strictEqual(r.conviene, null);
}

const tests = [testPackPorNombre, testRatio, testDecidir, testMetodoIngreso, testMasEconomico];
for (const t of tests) t();
console.log(`✅ tablaMaestra: ${tests.length} tests OK`);
