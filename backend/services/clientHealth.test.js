// Reglas del CRM de clientes: intervalo, estado, tendencia, prioridad y métricas.
// Sin base ni Odoo. node backend/services/clientHealth.test.js

const assert = require('assert');
const {
    DEFAULT_INTERVAL_DAYS,
    MIN_INTERVAL_DAYS,
    HEALTH,
    toArDate,
    usualInterval,
    classifyHealth,
    classifyTrend,
    priorityScore,
    lastMonths,
    buildMetrics,
    topProducts,
    addDays,
} = require('./clientHealth');

const TODAY = '2026-10-21';

function testToArDate() {
    // 01:30 UTC del 21 es todavía el 20 en Argentina
    assert.strictEqual(toArDate('2026-10-21 01:30:00'), '2026-10-20');
    assert.strictEqual(toArDate('2026-10-21 03:00:00'), '2026-10-21');
    assert.strictEqual(toArDate(new Date('2026-10-21T02:59:59Z')), '2026-10-20');
    assert.strictEqual(toArDate(null), null);
    assert.strictEqual(toArDate('cualquier cosa'), null);
}

function testUsualInterval() {
    // Menos de 3 días con compra → 15 días por defecto
    assert.deepStrictEqual(usualInterval([], TODAY), { days: DEFAULT_INTERVAL_DAYS, isDefault: true });
    assert.deepStrictEqual(usualInterval(['2026-10-01', '2026-10-10'], TODAY), { days: 15, isDefault: true });
    // Dos compras el mismo día cuentan como un día
    assert.strictEqual(usualInterval(['2026-10-01', '2026-10-01', '2026-10-10'], TODAY).isDefault, true);
    // Mediana de 10, 10, 30 = 10
    assert.deepStrictEqual(usualInterval(['2026-08-01', '2026-08-11', '2026-08-21', '2026-09-20'], TODAY), { days: 10, isDefault: false });
    // Compra casi a diario → piso de 7 días
    assert.strictEqual(usualInterval(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'], TODAY).days, MIN_INTERVAL_DAYS);
    // Si en el último año hay menos de 3 días, mira toda la historia
    assert.deepStrictEqual(usualInterval(['2025-01-01', '2025-01-21', '2025-02-10', '2026-10-01'], TODAY), { days: 20, isDefault: false });
}

function testClassifyHealth() {
    const i = 10;
    assert.strictEqual(classifyHealth({ daysSinceLast: null, daysSinceFirst: null, intervalDays: i }), HEALTH.sinCompras);
    assert.strictEqual(classifyHealth({ daysSinceLast: 5, daysSinceFirst: 200, intervalDays: i }), HEALTH.activo);
    assert.strictEqual(classifyHealth({ daysSinceLast: 15, daysSinceFirst: 200, intervalDays: i }), HEALTH.activo);
    assert.strictEqual(classifyHealth({ daysSinceLast: 16, daysSinceFirst: 200, intervalDays: i }), HEALTH.desfasaje);
    assert.strictEqual(classifyHealth({ daysSinceLast: 25, daysSinceFirst: 200, intervalDays: i }), HEALTH.desfasaje);
    assert.strictEqual(classifyHealth({ daysSinceLast: 26, daysSinceFirst: 200, intervalDays: i }), HEALTH.enfriandose);
    assert.strictEqual(classifyHealth({ daysSinceLast: 120, daysSinceFirst: 200, intervalDays: i }), HEALTH.enfriandose);
    assert.strictEqual(classifyHealth({ daysSinceLast: 121, daysSinceFirst: 200, intervalDays: i }), HEALTH.perdido);
    // Primera compra hace ≤ 30 días: nuevo aunque esté atrasado para su ritmo
    assert.strictEqual(classifyHealth({ daysSinceLast: 25, daysSinceFirst: 25, intervalDays: 15 }), HEALTH.nuevo);
}

function testClassifyTrend() {
    assert.deepStrictEqual(classifyTrend(0, 0), { trend: null, pct: null });
    assert.deepStrictEqual(classifyTrend(100, 0), { trend: 'sube', pct: null });
    assert.deepStrictEqual(classifyTrend(130, 100), { trend: 'sube', pct: 30 });
    assert.deepStrictEqual(classifyTrend(120, 100), { trend: 'estable', pct: 20 });
    assert.deepStrictEqual(classifyTrend(80, 100), { trend: 'estable', pct: -20 });
    assert.deepStrictEqual(classifyTrend(50, 100), { trend: 'baja', pct: -50 });
    assert.deepStrictEqual(classifyTrend(0, 100), { trend: 'baja', pct: -100 });
}

function testPriority() {
    assert.strictEqual(priorityScore({ revenue12m: 1000, daysSinceLast: 5, intervalDays: 10, health: HEALTH.activo }), 0);
    assert.strictEqual(priorityScore({ revenue12m: 1000, daysSinceLast: 200, intervalDays: 10, health: HEALTH.perdido }), 0);
    // 30 días con ritmo de 10 → 2 intervalos de atraso
    assert.strictEqual(priorityScore({ revenue12m: 1000, daysSinceLast: 30, intervalDays: 10, health: HEALTH.enfriandose }), 2000);
    // Un cliente grande algo atrasado va antes que uno chico muy atrasado
    const grande = priorityScore({ revenue12m: 1000000, daysSinceLast: 20, intervalDays: 10, health: HEALTH.desfasaje });
    const chico = priorityScore({ revenue12m: 10000, daysSinceLast: 100, intervalDays: 10, health: HEALTH.enfriandose });
    assert.ok(grande > chico);
}

function testLastMonths() {
    const months = lastMonths('2026-03-15', 4);
    assert.deepStrictEqual(months, ['2025-12', '2026-01', '2026-02', '2026-03']);
    assert.strictEqual(lastMonths(TODAY).length, 12);
}

function testBuildMetricsVacio() {
    const m = buildMetrics([], TODAY);
    assert.strictEqual(m.health, HEALTH.sinCompras);
    assert.strictEqual(m.purchase_count, 0);
    assert.strictEqual(m.monthly_revenue.length, 12);
    assert.strictEqual(m.priority, 0);
}

function testBuildMetricsEnfriandose() {
    // Compraba cada 10 días y hace 40 que no compra
    const purchases = [
        { date: '2026-08-02', amount: 1000 },
        { date: '2026-08-12', amount: 1000 },
        { date: '2026-08-22', amount: 2000 },
        { date: '2026-09-01', amount: 2000 },
        { date: '2026-09-11', amount: 4000 },
    ];
    const m = buildMetrics(purchases, TODAY);
    assert.strictEqual(m.purchase_count, 5);
    assert.strictEqual(m.total_revenue, 10000);
    assert.strictEqual(m.avg_ticket, 2000);
    assert.strictEqual(m.first_purchase_date, '2026-08-02');
    assert.strictEqual(m.last_purchase_date, '2026-09-11');
    assert.strictEqual(m.days_since_last_purchase, 40);
    assert.strictEqual(m.median_interval_days, 10);
    assert.strictEqual(m.health, HEALTH.enfriandose);
    assert.strictEqual(m.revenue_90d, 10000);
    assert.strictEqual(m.revenue_12m, 10000);
    assert.strictEqual(m.trend, 'sube');
    assert.strictEqual(m.priority, 30000);
    const sep = m.monthly_revenue.find((x) => x.month === '2026-09');
    const ago = m.monthly_revenue.find((x) => x.month === '2026-08');
    assert.strictEqual(sep.amount, 6000);
    assert.strictEqual(ago.amount, 4000);
}

function testBuildMetricsTendencia() {
    const purchases = [
        { date: addDays(TODAY, -150), amount: 10000 },
        { date: addDays(TODAY, -120), amount: 10000 },
        { date: addDays(TODAY, -60), amount: 3000 },
        { date: addDays(TODAY, -3), amount: 2000 },
    ];
    const m = buildMetrics(purchases, TODAY);
    assert.strictEqual(m.revenue_90d, 5000);
    assert.strictEqual(m.revenue_prev_90d, 20000);
    assert.strictEqual(m.trend, 'baja');
    assert.strictEqual(m.trend_pct, -75);
    assert.strictEqual(m.health, HEALTH.activo);
}

function testTopProducts() {
    const top = topProducts([
        { product_id: 1, name: 'Vasos', qty: 2, amount: 500, date: '2026-09-01' },
        { product_id: 2, name: 'Platos', qty: 1, amount: 900, date: '2026-09-05' },
        { product_id: 1, name: 'Vasos', qty: 3, amount: 600, date: '2026-10-01' },
        { product_id: null, name: 'Seña', qty: 1, amount: 99999 },
    ], 5);
    assert.strictEqual(top.length, 2);
    assert.deepStrictEqual(top[0], { product_id: 1, name: 'Vasos', qty: 5, amount: 1100, last_date: '2026-10-01' });
    assert.strictEqual(top[1].product_id, 2);
}

testToArDate();
testUsualInterval();
testClassifyHealth();
testClassifyTrend();
testPriority();
testLastMonths();
testBuildMetricsVacio();
testBuildMetricsEnfriandose();
testBuildMetricsTendencia();
testTopProducts();
console.log('ok clientHealth.test.js');
