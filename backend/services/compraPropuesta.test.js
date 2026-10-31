// Motor de propuestas de compra: renglones, umbral, optimizador con mínimos y aprobación.
// Sin base de datos (usa HiGHS). node backend/services/compraPropuesta.test.js

const assert = require('assert');
const {
    redondearPack, armarRenglones, costoObjetivo, resolverSimple, construirModelo, explicar,
    armarCanastas, validarAprobacion, resolver,
} = require('./compraPropuestaService');

const ahora = new Date('2026-10-31T12:00:00Z');
const oferta = (o) => ({ disponible: true, precio_viejo: false, pack: 1, ...o });

function item(o) {
    return {
        id: o.id, odoo_id: o.odoo_id, name: o.name || `P${o.odoo_id}`, internal_ref: null,
        vendor_name: o.vendor || 'Impotekno', standard_price: o.costo ?? 1000, abc: o.abc || 'A',
        ritmo: o.ritmo || 'estable', qty_sugerida_calc: o.qty ?? 10, qty_decidida: o.decidida ?? null,
        ofertas: { ofertas: o.ofertas || [] },
    };
}

function testPack() {
    assert.strictEqual(redondearPack(8, 12), 12);
    assert.strictEqual(redondearPack(13, 12), 24);
    assert.strictEqual(redondearPack(5, 1), 5);
}

function testRenglones() {
    const cola = [
        // Oferta web fresca de su proveedor y otra de una web aparte que va al mismo pedido
        item({ id: 1, odoo_id: 10, vendor: 'Parnassa', costo: 900, ofertas: [
            oferta({ supplier_product_id: 100, proveedor: 'Parnassa Web', proveedor_odoo: 'Parnassa', precio: 800, pack: 6 }),
            oferta({ supplier_product_id: 101, proveedor: 'Babu', proveedor_odoo: 'Babu', precio: 700 }),
            oferta({ supplier_product_id: 102, proveedor: 'Cast', proveedor_odoo: 'Cast', precio: 500, precio_viejo: true }),
        ] }),
        // Sin oferta: entra el costo de Odoo de su proveedor
        item({ id: 2, odoo_id: 20, vendor: 'DDATAE', costo: 2000, qty: 3 }),
        // C flojo sin encargue: no reponer
        item({ id: 3, odoo_id: 30, abc: 'C', ritmo: 'flojo' }),
        // C flojo pero con cantidad decidida a mano: entra
        item({ id: 4, odoo_id: 40, abc: 'C', ritmo: 'flojo', decidida: 2 }),
    ];
    const encargues = [
        { odoo_id: 20, qty_total: 2, estado_cola: 'pendiente', cotizaciones: [{ name: 'S1', qty: 2, date_order: '2026-10-01T10:00:00Z' }] },
        { odoo_id: 50, name: 'Solo encargue', vendor_name: 'Babu', standard_price: 300, qty_total: 4, estado_cola: null, cotizaciones: [] },
        { odoo_id: 60, qty_total: 9, estado_cola: 'encargado', cotizaciones: [] },
    ];
    const condiciones = { Parnassa: { flete_pct: 0 }, Babu: { flete_pct: 10 } };
    const rs = armarRenglones({ cola, encargues, condiciones, ahora });
    const por = new Map(rs.map(r => [r.odoo_id, r]));

    const r10 = por.get(10);
    assert.strictEqual(r10.precios_viejos, 1);
    // Ordenadas por total; Parnassa Web va al pedido de Parnassa (una sola opción por pedido)
    assert.deepStrictEqual(r10.opciones.map(o => o.canasta), ['Babu', 'Parnassa']);
    const parnassa = r10.opciones.find(o => o.canasta === 'Parnassa');
    assert.strictEqual(parnassa.qty, 12);            // 10 redondeado al pack x6
    assert.strictEqual(parnassa.total, 9600);        // sin flete
    assert.strictEqual(parnassa.habitual, true);
    assert.strictEqual(parnassa.proveedor, 'Parnassa Web');
    const babu = r10.opciones.find(o => o.canasta === 'Babu');
    assert.strictEqual(babu.costo_unit, 770);        // 700 + 10 % de flete
    assert.strictEqual(babu.total, 7700);

    const r20 = por.get(20);
    assert.strictEqual(r20.qty_total, 5);            // 3 sugeridas + 2 encargadas
    assert.strictEqual(r20.encargue_viejo, true);
    assert.strictEqual(r20.opciones[0].origen, 'costo_odoo');
    assert.strictEqual(r20.opciones[0].costo_unit, 2030); // flete por defecto 1,5 %

    assert.match(por.get(30).no_reponer, /no reponer/);
    assert.strictEqual(por.get(40).no_reponer, null);
    assert.strictEqual(por.get(40).qty_total, 2);
    assert.strictEqual(por.get(50).reposicion_item_id, null);
    assert.strictEqual(por.get(50).qty_total, 4);
    assert.ok(!por.has(60));                         // ya encargado
}

const reng = (odoo_id, opciones, extra = {}) => ({ odoo_id, qty_encargue: 0, opciones, ...extra });
const op = (canasta, total, habitual = false) => ({ canasta, total, habitual, costo_unit: total, qty: 1 });

function testUmbral() {
    // 3 % más barato: se queda con el de siempre; 10 %: cambia
    const r1 = reng(1, [op('Habitual', 1000, true), op('Otro', 970)]);
    const r2 = reng(2, [op('Habitual', 1000, true), op('Otro', 900)]);
    assert.deepStrictEqual(resolverSimple([r1, r2]).map((j, i) => [r1, r2][i].opciones[j].canasta), ['Habitual', 'Otro']);
    // Sin habitual con precio, gana el más barato sin umbral
    const r3 = reng(3, [op('A', 1000), op('B', 990)]);
    assert.strictEqual(costoObjetivo(r3, r3.opciones[0]), 1000);
    assert.strictEqual(r3.opciones[resolverSimple([r3])[0]].canasta, 'B');
    assert.strictEqual(explicar(r2, 1).motivo, 'mas_barato');
    assert.strictEqual(explicar(r1, 0).motivo, 'habitual');
    assert.strictEqual(explicar(r1, 0).alternativa.proveedor, 'Otro');
    assert.strictEqual(explicar(reng(4, [op('A', 10)]), 0).motivo, 'unico');
    assert.strictEqual(explicar(r1, -1).motivo, 'esperando_minimo');
}

function testModelo() {
    const { lp } = construirModelo([reng(1, [op('A', 100, true), op('B', 120)])], { A: { pedido_minimo: 500 } });
    assert.ok(lp.includes(' r_0: x_0_0 + x_0_1 + w_0 = 1'));
    assert.ok(/ m_\d: 100\.00 x_0_0 - 500\.00 y_\d >= 0/.test(lp));
    assert.ok(!/m_\d: 120/.test(lp));                 // B no tiene mínimo
}

async function testOptimizador() {
    const cond = { A: { pedido_minimo: 10000 }, B: { pedido_minimo: null } };
    // Un renglón solo no llega al mínimo de A: conviene B aunque sea más caro (y el umbral)
    const solo = [reng(1, [op('A', 3000, true), op('B', 3300)])];
    let r = await resolver(solo, cond);
    assert.strictEqual(r.solver, 'highs');
    assert.strictEqual(solo[0].opciones[r.elecciones[0]].canasta, 'B');
    assert.strictEqual(explicar(solo[0], r.elecciones[0]).motivo, 'minimo');

    // Dos renglones juntos sí llegan al mínimo de A: los dos van a A
    const juntos = [reng(1, [op('A', 6000, true), op('B', 6600)]), reng(2, [op('A', 6000, true), op('B', 6600)])];
    r = await resolver(juntos, cond);
    assert.deepStrictEqual(r.elecciones.map((j, i) => juntos[i].opciones[j].canasta), ['A', 'A']);

    // Única opción en A y no llega: queda esperando el mínimo
    const espera = [reng(1, [op('A', 3000, true)])];
    r = await resolver(espera, cond);
    assert.deepStrictEqual(r.elecciones, [-1]);

    // Con encargue de un cliente conviene más pagar un poco más que esperar
    const caro = [reng(1, [op('A', 3000, true), op('B', 5500)], { qty_encargue: 2 })];
    r = await resolver(caro, cond);
    assert.strictEqual(caro[0].opciones[r.elecciones[0]].canasta, 'B');
    const sinEncargue = [reng(1, [op('A', 3000, true), op('B', 5500)])];
    r = await resolver(sinEncargue, cond);
    assert.deepStrictEqual(r.elecciones, [-1]);

    // Canastas
    juntos.forEach((x, i) => { x.elegido = 0; });
    const cs = armarCanastas(juntos, cond);
    assert.deepStrictEqual(cs.map(c => [c.proveedor, c.total, c.llega_minimo, c.falta]), [['A', 12000, true, 0]]);
    espera[0].elegido = 0;
    assert.strictEqual(armarCanastas(espera, cond)[0].falta, 7000);
}

function testAprobacion() {
    assert.match(validarAprobacion({}).error, /proveedor/);
    assert.match(validarAprobacion({ proveedor: 'A', renglones: [] }).error, /renglones/);
    assert.match(validarAprobacion({ proveedor: 'A', renglones: [{ odoo_id: 1, qty: 0 }] }).error, /entero/);
    assert.match(validarAprobacion({ proveedor: 'A', renglones: [{ odoo_id: 1, qty: 1 }, { odoo_id: 1, qty: 2 }] }).error, /dos veces/);
    const { valores } = validarAprobacion({ proveedor: ' Babu ', solver: 'highs', renglones: [
        { odoo_id: '5', qty: 3, reposicion_item_id: 9, supplier_product_id: null, precio: 100, costo_unit: 101.5, motivo: 'raro' },
    ] });
    assert.strictEqual(valores.proveedor, 'Babu');
    assert.deepStrictEqual(valores.renglones[0], {
        odoo_id: 5, reposicion_item_id: 9, supplier_product_id: null, nombre: null, qty: 3, pack: 1,
        precio: 100, costo_unit: 101.5, motivo: 'manual', alternativa: null,
    });
}

(async () => {
    testPack();
    testRenglones();
    testUmbral();
    testModelo();
    await testOptimizador();
    testAprobacion();
    console.log('✅ compraPropuesta: todos los casos pasan');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
