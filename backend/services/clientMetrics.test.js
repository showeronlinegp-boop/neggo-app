// Armado de filas del CRM a partir de lo leído de Odoo: exclusiones, cuenta genérica,
// cotizaciones abiertas y productos top. Sin base ni Odoo. node backend/services/clientMetrics.test.js

const assert = require('assert');
const { buildRows } = require('./clientMetricsService');

const TODAY = '2026-10-21';

function testBuildRows() {
    const orders = [
        { id: 1, partner_id: [10, 'Polirrubro El Trébol'], date_order: '2026-10-01 15:00:00', amount_total: 1000 },
        { id: 2, partner_id: [10, 'Polirrubro El Trébol'], date_order: '2026-10-11 15:00:00', amount_total: 3000 },
        { id: 3, partner_id: [6, 'Consumidor Final'], date_order: '2026-10-20 15:00:00', amount_total: 500 },
        { id: 4, partner_id: [1516, 'RMA'], date_order: '2026-10-20 15:00:00', amount_total: 700 },
        { id: 5, partner_id: false, date_order: '2026-10-20 15:00:00', amount_total: 900 },
    ];
    const lines = [
        { order_id: [1, 'x'], product_id: [100, 'Vasos'], qty: 2, price_subtotal_incl: 400 },
        { order_id: [2, 'x'], product_id: [100, 'Vasos'], qty: 1, price_subtotal_incl: 200 },
        { order_id: [2, 'x'], product_id: [101, 'Platos'], qty: 4, price_subtotal_incl: 2800 },
    ];
    const quotations = new Map([
        [10, [{ company: 'neggo', name: 'S04187', state: 'sent', date: '2026-10-18', amount: 412500 }]],
        [20, [{ company: 'preventas', name: 'S00300', state: 'draft', date: '2026-10-19', amount: 1000 }]],
    ]);
    const partners = new Map([
        [10, { id: 10, name: 'Polirrubro El Trébol', phone: '+54 9 236 461-0093', city: ' Junín ', tags: ['Polirrubros'] }],
        [6, { id: 6, name: 'Consumidor Final', tags: [] }],
        [1516, { id: 1516, name: 'RMA', tags: [] }],
        [20, { id: 20, name: 'Prospecto Rojas', tags: [] }],
    ]);

    const rows = buildRows({ orders, lines, quotations, partners, today: TODAY });
    const byId = new Map(rows.map((r) => [r.odoo_partner_id, r]));

    // RMA queda afuera de todo; los tickets sin cliente no generan fila
    assert.strictEqual(byId.has(1516), false);
    assert.strictEqual(rows.length, 3);

    const trebol = byId.get(10);
    assert.strictEqual(trebol.purchase_count, 2);
    assert.strictEqual(trebol.total_revenue, 4000);
    assert.strictEqual(trebol.city, 'Junín');
    assert.deepStrictEqual(trebol.tags, ['Polirrubros']);
    assert.strictEqual(trebol.is_generic, false);
    assert.strictEqual(trebol.open_quotations[0].name, 'S04187');
    assert.strictEqual(trebol.top_products[0].name, 'Platos');
    assert.strictEqual(trebol.top_products[1].qty, 3);

    // Consumidor Final se guarda (suma a la facturación) pero marcado como genérico
    assert.strictEqual(byId.get(6).is_generic, true);
    assert.strictEqual(byId.get(6).revenue_90d, 500);

    // Solo con cotización abierta: entra sin compras
    const prospecto = byId.get(20);
    assert.strictEqual(prospecto.health, 'sin_compras');
    assert.strictEqual(prospecto.purchase_count, 0);
    assert.strictEqual(prospecto.open_quotations[0].company, 'preventas');
}

testBuildRows();
console.log('ok clientMetrics.test.js');
