// Cotizaciones "Pendiente" para reposición: armado y total por producto.
// Sin base de datos ni Odoo. node backend/services/reposicionCotizaciones.test.js

const assert = require('assert');
const {
    armarCotizaciones, resumirPorProducto, repartirIngresos, puedeReponer, qtyParaCola, contarListos,
} = require('./reposicionCotizacionesService');

const COMPANIES = { neggo: 1, preventas: 50 };

function testArmar() {
    const orders = [
        { id: 20, name: 'S00020', state: 'sent', company_id: [50, 'Precompras'], partner_id: [8, 'Yami'], user_id: false, date_order: '2026-10-21 01:39:54', origin: 'S00010 (pendientes)', amount_total: 3000 },
        { id: 21, name: 'S00021', state: 'draft', company_id: [1, 'neggo'], partner_id: [9, 'Pablo'], user_id: [2, 'Mariano'], date_order: '2026-10-22 15:33:48', origin: false, amount_total: 1500 },
        // Solo un envío (servicio): no llega ninguna línea → no aparece
        { id: 22, name: 'S00022', state: 'draft', company_id: [1, 'neggo'], partner_id: [9, 'Pablo'], user_id: false, date_order: '2026-10-23 10:00:00', origin: false, amount_total: 100 },
    ];
    const lines = [
        { order_id: [20, 'S00020'], product_id: [100, 'Pava'], product_uom_qty: 2, price_unit: 1000 },
        { order_id: [20, 'S00020'], product_id: [100, 'Pava'], product_uom_qty: 1, price_unit: 1000 },
        { order_id: [21, 'S00021'], product_id: [100, 'Pava'], product_uom_qty: 1, price_unit: 1500 },
        { order_id: [21, 'S00021'], product_id: [101, 'Vaso'], product_uom_qty: 0, price_unit: 10 },
    ];
    const res = armarCotizaciones(orders, lines, COMPANIES);
    assert.strictEqual(res.length, 2, 'la cotización sin productos físicos no se muestra');
    assert.strictEqual(res[0].name, 'S00021', 'más nuevas primero');
    assert.strictEqual(res[0].estado, 'borrador');
    assert.strictEqual(res[0].company, 'neggo');
    assert.strictEqual(res[0].origen, null);
    assert.strictEqual(res[0].productos.length, 1, 'cantidad 0 no cuenta');
    assert.strictEqual(res[1].estado, 'enviada');
    assert.strictEqual(res[1].company, 'preventas');
    assert.strictEqual(res[1].empresa, 'Preventas');
    assert.strictEqual(res[1].date_order, '2026-10-21T01:39:54Z');
    assert.strictEqual(res[1].productos[0].qty, 3, 'el mismo producto se suma');
}

function testResumir() {
    const cotizaciones = [
        { name: 'S1', partner_name: 'A', company: 'neggo', empresa: 'Neggo', productos: [
            { odoo_id: 100, name: 'Pava', qty: 2, vendor_name: 'Zeta' },
            { odoo_id: 101, name: 'Vaso', qty: 1, vendor_name: 'Alfa', estado_cola: 'pendiente' },
        ] },
        { name: 'S2', partner_name: 'B', company: 'neggo', empresa: 'Neggo', productos: [
            { odoo_id: 100, name: 'Pava', qty: 3, vendor_name: 'Zeta' },
        ] },
        // Mismo id en otra empresa: va aparte
        { name: 'S3', partner_name: 'C', company: 'preventas', empresa: 'Preventas', productos: [
            { odoo_id: 100, name: 'Pava', qty: 1, vendor_name: 'Zeta' },
        ] },
    ];
    const res = resumirPorProducto(cotizaciones);
    assert.strictEqual(res.length, 3);
    assert.strictEqual(res[0].vendor_name, 'Alfa', 'ordena por proveedor');
    assert.strictEqual(res[0].estado_cola, 'pendiente');
    const pava = res.find(p => p.odoo_id === 100 && p.company === 'neggo');
    assert.strictEqual(pava.qty_total, 5);
    assert.deepStrictEqual(pava.cotizaciones.map(c => c.name), ['S1', 'S2']);
    assert.strictEqual(res[1].qty_total, 5, 'dentro del proveedor, más cantidad primero');
}

function testLlegada() {
    const cot = (id, date_order, qty) => ({ odoo_order_id: id, date_order, productos: [{ odoo_id: 100, qty }] });
    const ingreso = (ingreso_id, at, qty) => ({ ingreso_id, comprobante: `A-${ingreso_id}`, at, qty });
    const de = (r, id) => r.get(`${id}|100`);

    // Un ingreso viejo no cuenta
    let r = repartirIngresos([cot(1, '2026-10-25T00:00:00Z', 2)], new Map([[100, [ingreso(1, '2026-10-01T10:00:00Z', 9)]]]));
    assert.deepStrictEqual(de(r, 1), { llego: null, qty_llegada: 0 });

    // Sin ingresos
    r = repartirIngresos([cot(1, null, 2)], new Map());
    assert.deepStrictEqual(de(r, 1), { llego: null, qty_llegada: 0 });

    // Entró menos de lo pedido: no «llegó», pero se sabe cuánto hay
    r = repartirIngresos([cot(1, '2026-10-10T00:00:00Z', 5)], new Map([[100, [ingreso(2, '2026-10-20T10:00:00Z', 3)]]]));
    assert.strictEqual(de(r, 1).llego, null, '3 de 5 no alcanzan');
    assert.strictEqual(de(r, 1).qty_llegada, 3);

    // Dos ingresos completan la cantidad: queda el que la completó
    r = repartirIngresos([cot(1, '2026-10-10T00:00:00Z', 5)], new Map([[100, [
        ingreso(2, '2026-10-20T10:00:00Z', 3), ingreso(3, '2026-10-21T10:00:00Z', 4),
    ]]]));
    assert.strictEqual(de(r, 1).llego.ingreso_id, 3);
    assert.strictEqual(de(r, 1).qty_llegada, 5);

    // Dos clientes: primero la cotización más vieja, aunque venga después en la lista
    r = repartirIngresos(
        [cot(2, '2026-10-12T00:00:00Z', 3), cot(1, '2026-10-10T00:00:00Z', 2)],
        new Map([[100, [ingreso(2, '2026-10-20T10:00:00Z', 4)]]])
    );
    assert.strictEqual(de(r, 1).llego.ingreso_id, 2, 'a la vieja le alcanza');
    assert.strictEqual(de(r, 2).llego, null, 'a la nueva no: la misma unidad no cuenta dos veces');
    assert.strictEqual(de(r, 2).qty_llegada, 2);

    // Un ingreso anterior a la cotización nueva sigue sin servirle, aunque sobre
    r = repartirIngresos(
        [cot(1, '2026-10-10T00:00:00Z', 1), cot(2, '2026-10-25T00:00:00Z', 1)],
        new Map([[100, [ingreso(2, '2026-10-20T10:00:00Z', 5)]]])
    );
    assert.ok(de(r, 1).llego);
    assert.strictEqual(de(r, 2).qty_llegada, 0);
}

function testLlegadaParcial() {
    const [p] = resumirPorProducto([
        { name: 'S1', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 100, qty: 5, qty_llegada: 3, vendor_name: 'Z', llego: null, puede_reponer: true }] },
    ]);
    assert.strictEqual(p.qty_falta, 2, 'solo falta lo que no entró');
    assert.strictEqual(p.llego, null);
    assert.strictEqual(qtyParaCola(p), 2);

    const [listo] = resumirPorProducto([
        { name: 'S1', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 100, qty: 2, qty_llegada: 2, vendor_name: 'Z', llego: { ingreso_id: 1 } }] },
        { name: 'S2', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 100, qty: 3, qty_llegada: 0, vendor_name: 'Z', llego: null, separado: { at: 'x' } }] },
    ]);
    assert.strictEqual(listo.qty_falta, 0, 'una llegó y la otra está separada: no falta nada');
}

function testLlegadaPorProducto() {
    const llego = { ingreso_id: 2, comprobante: 'A-2', at: '2026-10-20T10:00:00Z' };
    const res = resumirPorProducto([
        { name: 'S1', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 100, qty: 1, vendor_name: 'Z', llego }] },
        { name: 'S2', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 100, qty: 1, vendor_name: 'Z', llego: null }] },
        { name: 'S3', company: 'neggo', empresa: 'Neggo', productos: [{ odoo_id: 101, qty: 1, vendor_name: 'Z', llego }] },
    ]);
    assert.strictEqual(res.find(p => p.odoo_id === 100).llego, null, 'falta para una cotización: no llegó');
    assert.strictEqual(res.find(p => p.odoo_id === 101).llego.ingreso_id, 2);
}

function testPuedeReponer() {
    const base = { en_cache: true, es_liquidar: false, estado_cola: null, llego: null };
    assert.strictEqual(puedeReponer(base, 'neggo'), true);
    assert.strictEqual(puedeReponer(base, 'preventas'), false, 'solo Neggo');
    assert.strictEqual(puedeReponer({ ...base, en_cache: false }, 'neggo'), false);
    assert.strictEqual(puedeReponer({ ...base, es_liquidar: true }, 'neggo'), false);
    assert.strictEqual(puedeReponer({ ...base, estado_cola: 'pendiente' }, 'neggo'), false);
    assert.strictEqual(puedeReponer({ ...base, llego: { ingreso_id: 1 } }, 'neggo'), false, 'ya llegó');
    assert.strictEqual(qtyParaCola({ qty_total: 3 }), 3);
    assert.strictEqual(qtyParaCola({ qty_total: 0.4 }), 1, 'mínimo 1');
}

// Nota 150: lo separado no se vuelve a pedir y cuenta como listo
function testSeparado() {
    const base = { en_cache: true, es_liquidar: false, estado_cola: null, llego: null };
    assert.strictEqual(puedeReponer({ ...base, separado: { at: 'x' } }, 'neggo'), false, 'separado no se pide');
    const prods = resumirPorProducto([
        { name: 'S1', company: 'neggo', empresa: 'Neggo', partner_name: 'A', productos: [{ odoo_id: 1, name: 'Pava', vendor_name: 'ZLE', qty: 2, separado: { at: 'x' }, puede_reponer: false }] },
        { name: 'S2', company: 'neggo', empresa: 'Neggo', partner_name: 'B', productos: [{ odoo_id: 1, name: 'Pava', vendor_name: 'ZLE', qty: 3, puede_reponer: true }] },
    ]);
    assert.strictEqual(prods[0].qty_total, 5);
    assert.strictEqual(prods[0].qty_falta, 3, 'lo separado se descuenta');
    assert.strictEqual(prods[0].puede_reponer, true, 'S2 todavía espera');
    assert.strictEqual(prods[0].separado, null, 'no está separado para todas');
    assert.strictEqual(qtyParaCola(prods[0]), 3);
    assert.strictEqual(contarListos([{ llego: { id: 1 } }, { separado: { at: 'x' } }, {}]), 2);
}

testArmar();
testResumir();
testLlegada();
testLlegadaParcial();
testLlegadaPorProducto();
testPuedeReponer();
testSeparado();
console.log('✅ reposicionCotizaciones: ok');
