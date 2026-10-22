// Unificación de fichas duplicadas de Odoo (nota #72), con casos reales de la base.
// Sin base ni Odoo. node backend/services/clientDuplicates.test.js

const assert = require('assert');
const { groupDuplicates, mergedPartner, docKey, nameKey } = require('./clientDuplicates');
const { mergeDuplicates, buildRows } = require('./clientMetricsService');

function partnersMap(list) {
    return new Map(list.map((p) => [p.id, { commercial_partner_id: [p.id, p.name], ...p }]));
}

function testKeys() {
    // El CUIT trae el DNI en el medio
    assert.strictEqual(docKey('20139440340'), '13944034');
    assert.strictEqual(docKey('13944034'), '13944034');
    assert.strictEqual(docKey('20-42087268-3'), '42087268');
    assert.strictEqual(docKey(false), null);
    assert.strictEqual(docKey('123'), null);
    // DNI de relleno
    assert.strictEqual(docKey('12345678'), null);
    assert.strictEqual(docKey('11111111'), null);
    assert.strictEqual(docKey('20-12345678-3'), null);
    assert.strictEqual(nameKey('Marisa Becerro Estado: Cliente SLD'), 'marisa becerro');
    assert.strictEqual(nameKey('Yesica González '), 'yesica gonzalez');
}

function testGroups() {
    const partners = partnersMap([
        // Mismo DNI dentro del CUIT, mismo teléfono y el nombre "Jorge ..." en una ficha vieja
        { id: 385, name: 'Jorge Estado: NRI SLD', phone: '5492477589211' },
        { id: 808, name: 'jorge Luis Flores' },
        { id: 1262, name: 'Jorge luis Flores', phone: '+54 2477 58-9211', vat: '20139440340' },
        { id: 1284, name: 'Jorge luis Flores', phone: '+54 2477 58-9211', vat: '13944034' },
        // Contacto hijo "neggo" de Andrés Silva
        { id: 1174, name: 'Andres Silva', phone: '+54 2477 20-0170', vat: '20258320078' },
        { id: 1340, name: 'neggo', commercial_partner_id: [1174, 'Andres Silva'], vat: '20258320078' },
        // Mismo email y el primer nombre arranca igual
        { id: 882, name: 'Nahuel Sanz', email: 'nahuelsanz2021@gmail.com', vat: '41025113' },
        { id: 1281, name: 'Nahue Sanz ', email: 'nahuelsanz2021@gmail.com' },
        // Mismo teléfono y email pero distinto DNI: son dos personas
        { id: 910, name: 'Emma larez', phone: '+54 2954 52-8507', email: 'bribrim55@gmail.com', vat: '14664429' },
        { id: 1474, name: 'Brisa mielgo', phone: '+54 2954 52-8507', email: 'bribrim55@gmail.com', vat: '44118990' },
        // Mismo teléfono con nombres distintos: no se adivina
        { id: 1070, name: 'Lucrecia Caelles', phone: '+54 2477 51-8294' },
        { id: 611, name: 'Cosmo Shop Estado: Cliente NLD-10', phone: '5492477518294' },
        // Mismo nombre de una sola palabra sin otro dato: demasiado común
        { id: 2001, name: 'Yamil' },
        { id: 2002, name: 'Yamil' },
        // Mismo nombre pero DNI distinto
        { id: 3001, name: 'Juan Perez', vat: '30111222' },
        { id: 3002, name: 'Juan Pérez', vat: '30111223' },
        // La cuenta genérica nunca se une
        { id: 6, name: 'Consumidor Final' },
        { id: 7, name: 'consumidor final' },
    ]);
    const { repOf, groups } = groupDuplicates(partners, { skipNames: ['consumidor final', 'rma'] });

    assert.deepStrictEqual(groups.get(385), [385, 808, 1262, 1284]);
    assert.deepStrictEqual(groups.get(1174), [1174, 1340]);
    assert.deepStrictEqual(groups.get(882), [882, 1281]);
    assert.strictEqual(repOf.get(1284), 385);
    for (const id of [910, 1474, 1070, 611, 2001, 2002, 3001, 3002, 6, 7]) {
        assert.strictEqual(repOf.get(id), id, `${id} no debería unirse`);
    }
    assert.strictEqual(groups.size, 3);
}

function testMergedPartner() {
    const members = [
        { id: 385, name: 'Jorge Estado: NRI SLD', phone: '5492477589211', tags: ['NRI'] },
        { id: 808, name: 'jorge Luis Flores', phone: false, city: 'Pergamino', tags: [] },
        { id: 1340, name: 'neggo', commercial_partner_id: [1174, 'x'], phone: false },
    ];
    const tickets = new Map([[385, 1], [808, 7], [1340, 9]]);
    const p = mergedPartner(385, members, tickets);
    // El nombre sale de la ficha con más compras que no sea un contacto hijo
    assert.strictEqual(p.name, 'jorge Luis Flores');
    assert.strictEqual(p.phone, '5492477589211');
    assert.strictEqual(p.city, 'Pergamino');
    assert.deepStrictEqual(p.tags, ['NRI']);
    assert.deepStrictEqual(p.merged.map((m) => [m.id, m.tickets]), [[385, 1], [808, 7], [1340, 9]]);

    // El principal es una dirección sin compras: el nombre sale del contacto que compra
    const direccion = mergedPartner(1041, [
        { id: 1041, name: 'calle 6 311' },
        { id: 1042, name: 'Antonelia Carrera', commercial_partner_id: [1041, 'calle 6 311'] },
    ], new Map([[1042, 2]]));
    assert.strictEqual(direccion.name, 'Antonelia Carrera');
}

function testMergeIntoRows() {
    const partners = partnersMap([
        { id: 743, name: 'Marcela Villaruel', phone: '+54 2477 68-1505', vat: '20821156', tags: [] },
        { id: 1344, name: 'Marcela Villaruel', phone: '+54 2477 68-1505', vat: '20821156', tags: [] },
        { id: 10, name: 'Otro Cliente', tags: [] },
    ]);
    const orders = [
        { id: 1, partner_id: [743, 'Marcela Villaruel'], date_order: '2026-09-01 15:00:00', amount_total: 1000 },
        { id: 2, partner_id: [1344, 'Marcela Villaruel'], date_order: '2026-10-01 15:00:00', amount_total: 2000 },
        { id: 3, partner_id: [10, 'Otro Cliente'], date_order: '2026-10-01 15:00:00', amount_total: 500 },
    ];
    const quotations = new Map([
        [1344, [{ company: 'neggo', name: 'S2', state: 'sent', date: '2026-10-15', amount: 10 }]],
        [743, [{ company: 'preventas', name: 'S1', state: 'draft', date: '2026-10-10', amount: 20 }]],
    ]);
    const lines = [{ order_id: [2, 'x'], product_id: [100, 'Vasos'], qty: 1, price_subtotal_incl: 2000 }];
    const merged = mergeDuplicates({ orders, quotations, partners });
    const rows = buildRows({ ...merged, lines, today: '2026-10-21' });
    const byId = new Map(rows.map((r) => [r.odoo_partner_id, r]));

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(byId.has(1344), false);
    const marcela = byId.get(743);
    assert.strictEqual(marcela.purchase_count, 2);
    assert.strictEqual(marcela.total_revenue, 3000);
    assert.deepStrictEqual(marcela.open_quotations.map((q) => q.name), ['S2', 'S1']);
    assert.strictEqual(marcela.top_products[0].name, 'Vasos');
    assert.deepStrictEqual(marcela.merged_partners.map((m) => m.id), [743, 1344]);
    assert.deepStrictEqual(byId.get(10).merged_partners, []);
}

testKeys();
testGroups();
testMergedPartner();
testMergeIntoRows();
console.log('ok clientDuplicates.test.js');
