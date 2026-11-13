// Reparto de publicaciones del grupo en el día. Sin base. node backend/services/whatsappReparto.test.js

const assert = require('assert');
const R = require('./whatsappReparto');

let n = 0;
function test(nombre, fn) {
    fn();
    n++;
    console.log(`✅ ${nombre}`);
}

// 2026-11-12 es jueves; 2026-11-14 sábado; 2026-11-15 domingo.
const ar = (s) => new Date(`${s}-03:00`);
const iso = (d) => d && d.toISOString();
const sinAzar = () => 0.5;

test('ventana: dentro del horario arranca ya y cierra a las 18', () => {
    const v = R.ventanaDesde(ar('2026-11-12T10:50:00'));
    assert.strictEqual(iso(v.inicio), iso(ar('2026-11-12T10:50:00')));
    assert.strictEqual(iso(v.fin), iso(ar('2026-11-12T18:00:00')));
});

test('ventana: antes de las 9 espera a las 9; después de las 18 pasa al día siguiente', () => {
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-12T07:00:00')).inicio), iso(ar('2026-11-12T09:00:00')));
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-12T18:00:00')).inicio), iso(ar('2026-11-13T09:00:00')));
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-12T23:59:00')).inicio), iso(ar('2026-11-13T09:00:00')));
});

test('ventana: el sábado sí, el domingo pasa al lunes', () => {
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-14T12:00:00')).fin), iso(ar('2026-11-14T18:00:00')));
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-14T19:00:00')).inicio), iso(ar('2026-11-16T09:00:00')));
    assert.strictEqual(iso(R.ventanaDesde(ar('2026-11-15T10:00:00')).inicio), iso(ar('2026-11-16T09:00:00')));
});

function tanda(batchId, inicio, cantidad, desdeId = batchId * 100) {
    return {
        tanda: { batchId, inicio },
        mensajes: Array.from({ length: cantidad }, (_, i) => ({ id: desdeId + i, batchId, position: i })),
    };
}

test('20 fotos a las 10:50 se reparten hasta las 18 (una cada ~21 min)', () => {
    const a = tanda(1, ar('2026-11-12T10:50:00'), 20);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 20 }, mensajes: a.mensajes, ahora: ar('2026-11-12T10:50:00'), azar: sinAzar });
    assert.ok(plan.every((p) => !p.omitido));
    const horas = plan.map((p) => p.scheduledAt.getTime());
    const gaps = horas.slice(1).map((h, i) => (h - horas[i]) / 60000);
    assert.ok(gaps.every((g) => Math.abs(g - 21.5) < 0.1), gaps);
    assert.ok(horas[19] <= ar('2026-11-12T18:00:00').getTime());
    assert.ok(horas[19] > ar('2026-11-12T17:30:00').getTime());
});

test('con variación: nunca menos de 90 s, en orden y antes de las 18', () => {
    const a = tanda(1, ar('2026-11-12T09:00:00'), 200);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 200 }, mensajes: a.mensajes, ahora: ar('2026-11-12T09:00:00') });
    const ok = plan.filter((p) => !p.omitido).map((p) => p.scheduledAt.getTime());
    assert.strictEqual(ok.length, 200);
    for (let i = 1; i < ok.length; i++) assert.ok(ok[i] - ok[i - 1] >= 90000);
    const posiciones = plan.map((p) => p.id);
    assert.deepStrictEqual(posiciones, [...posiciones].sort((x, y) => x - y));
});

test('una tanda nueva se intercala con la que ya estaba', () => {
    const a = tanda(1, ar('2026-11-12T09:00:00'), 18);
    const b = tanda(2, ar('2026-11-12T14:00:00'), 8);
    // Las de antes de las 14 ya salieron: quedan 8 de la tanda 1
    const pendientesA = a.mensajes.filter((m) => m.position >= 10);
    const plan = R.planificar({
        tandas: [a.tanda, b.tanda], totales: { 1: 18, 2: 8 }, mensajes: [...pendientesA, ...b.mensajes],
        ultimoEnvio: ar('2026-11-12T13:55:00'), ahora: ar('2026-11-12T14:00:00'), azar: sinAzar,
    });
    assert.ok(plan.every((p) => !p.omitido));
    const orden = plan.map((p) => (p.id < 200 ? 'A' : 'B')).join('');
    assert.ok(!/AAA|BBB/.test(orden), orden);
    const horas = plan.map((p) => p.scheduledAt.getTime());
    for (let i = 1; i < horas.length; i++) assert.ok(horas[i] - horas[i - 1] >= 90000);
    assert.ok(horas[0] >= ar('2026-11-12T14:00:00').getTime());
});

test('lo que no entra hasta las 18 no se publica', () => {
    const a = tanda(1, ar('2026-11-12T17:30:00'), 30);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 30 }, mensajes: a.mensajes, ahora: ar('2026-11-12T17:30:00') });
    const entran = plan.filter((p) => !p.omitido);
    // 30 minutos a 90 s: entran 20 o 21 (depende de dónde cae la primera)
    assert.ok(entran.length >= 19 && entran.length <= 21, entran.length);
    assert.ok(plan.filter((p) => p.omitido).every((p) => iso(p.deadline) === iso(ar('2026-11-12T18:00:00'))));
    assert.ok(entran.every((p) => p.scheduledAt <= ar('2026-11-12T18:00:00')));
});

test('el último envío cuenta para los 90 s', () => {
    const a = tanda(1, ar('2026-11-12T17:58:00'), 1);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 1 }, mensajes: a.mensajes, ultimoEnvio: ar('2026-11-12T17:58:30'), ahora: ar('2026-11-12T17:58:00'), azar: sinAzar });
    assert.strictEqual(iso(plan[0].scheduledAt), iso(ar('2026-11-12T18:00:00')));
    const tarde = R.planificar({ tandas: [a.tanda], totales: { 1: 1 }, mensajes: a.mensajes, ultimoEnvio: ar('2026-11-12T17:59:00'), ahora: ar('2026-11-12T17:58:00'), azar: sinAzar });
    assert.strictEqual(tarde[0].omitido, true);
});

test('programado para el domingo arranca el lunes a las 9', () => {
    const a = tanda(1, ar('2026-11-15T10:00:00'), 3);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 3 }, mensajes: a.mensajes, ahora: ar('2026-11-13T12:00:00'), azar: sinAzar });
    assert.ok(plan.every((p) => p.scheduledAt >= ar('2026-11-16T09:00:00') && p.scheduledAt <= ar('2026-11-16T18:00:00')));
});

test('una tanda de días anteriores que quedó pendiente se omite', () => {
    const a = tanda(1, ar('2026-11-11T10:00:00'), 2);
    const plan = R.planificar({ tandas: [a.tanda], totales: { 1: 2 }, mensajes: a.mensajes, ahora: ar('2026-11-12T10:00:00') });
    assert.ok(plan.every((p) => p.omitido));
});

test('lo atrasado no sale de golpe: se reparte en lo que queda del día', () => {
    // 10 desde las 9 que no salieron nunca; a las 13 se reacomodan
    const a = tanda(1, ar('2026-11-12T09:00:00'), 10);
    const plan = R.planificar({ tandas: [a.tanda], mensajes: a.mensajes, ahora: ar('2026-11-12T13:00:00'), azar: sinAzar });
    const horas = plan.map((p) => p.scheduledAt.getTime());
    const gaps = horas.slice(1).map((h, i) => (h - horas[i]) / 60000);
    assert.ok(gaps.every((g) => Math.abs(g - 30) < 0.1), gaps);
    assert.ok(horas[0] >= ar('2026-11-12T13:10:00').getTime());
});

test('reacomodar dos veces da lo mismo (la variación es estable)', () => {
    const a = tanda(1, ar('2026-11-12T09:00:00'), 10);
    const args = { tandas: [a.tanda], totales: { 1: 10 }, mensajes: a.mensajes, ahora: ar('2026-11-12T09:00:00') };
    assert.deepStrictEqual(R.planificar(args).map((p) => iso(p.scheduledAt)), R.planificar(args).map((p) => iso(p.scheduledAt)));
});

console.log(`\n✅ ${n} tests de reparto OK`);
