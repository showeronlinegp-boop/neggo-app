// Clientes inactivos de la API del agente. Sin base ni Odoo.
// node backend/services/agenteInactivos.test.js

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const health = require('./clientHealth');
const { calcularClientesNuevos } = require('./agenteNuevos');
const inact = require('./agenteInactivos');
const v = require('./agenteValidacion');

const HOY = '2026-11-03'; // martes
const CFG = { ...inact.DEFAULTS };
let nextId = 1;

function ticket(partner, fecha, extra = {}) {
    const id = nextId++;
    return {
        id,
        name: `Shop/${id}`,
        pos_reference: `Pedido ${id}`,
        partner_id: [partner, `Cliente ${partner}`],
        date_order: `${fecha} 15:00:00`,
        amount_total: 1000,
        state: 'paid',
        sale_order_origin_id: false,
        ...extra,
    };
}

function linea(t, productId, qty, total) {
    return { order_id: [t.id, t.name], product_id: [productId, `[X${productId}] Producto ${productId}`], qty, price_subtotal_incl: total };
}

function cliente(tickets, lineas = []) {
    const [c] = calcularClientesNuevos({ tickets, lineas, hoy: HOY, dias: 100000 });
    return c;
}

function haceDias(n) {
    return health.addDays(HOY, -n);
}

const tests = [];
function test(nombre, fn) { tests.push([nombre, fn]); }

test('60 días justos no es inactivo; 61 sí; más de dias_max no', () => {
    const m60 = inact.metricas(cliente([ticket(1, haceDias(60))]), HOY);
    const m61 = inact.metricas(cliente([ticket(2, haceDias(61))]), HOY);
    const m365 = inact.metricas(cliente([ticket(3, haceDias(365))]), HOY);
    const m366 = inact.metricas(cliente([ticket(4, haceDias(366))]), HOY);
    assert.strictEqual(m60.dias_sin_comprar, 60);
    assert.strictEqual(inact.cumpleRegla(m60, CFG), false);
    assert.strictEqual(inact.cumpleRegla(m61, CFG), true);
    assert.strictEqual(inact.cumpleRegla(m365, CFG), true);
    assert.strictEqual(inact.cumpleRegla(m366, CFG), false);
});

test('una compra reciente lo saca aunque haya comprado mucho antes', () => {
    const m = inact.metricas(cliente([ticket(5, haceDias(200)), ticket(5, haceDias(10))]), HOY);
    assert.strictEqual(m.dias_sin_comprar, 10);
    assert.strictEqual(inact.cumpleRegla(m, CFG), false);
});

test('monto_historico_min y compras_min', () => {
    const m = inact.metricas(cliente([ticket(6, haceDias(100)), ticket(6, haceDias(80))]), HOY);
    assert.strictEqual(m.total_historico, 2000);
    assert.strictEqual(m.cantidad_compras, 2);
    assert.strictEqual(inact.cumpleRegla(m, { ...CFG, monto_historico_min: 2000 }), true);
    assert.strictEqual(inact.cumpleRegla(m, { ...CFG, monto_historico_min: 2000.01 }), false);
    assert.strictEqual(inact.cumpleRegla(m, { ...CFG, compras_min: 2 }), true);
    assert.strictEqual(inact.cumpleRegla(m, { ...CFG, compras_min: 3 }), false);
});

test('seña y saldo de un mismo pedido cuentan como una compra', () => {
    const sale = [900, 'S00900'];
    const c = cliente([
        ticket(7, haceDias(90), { amount_total: 300, sale_order_origin_id: sale }),
        ticket(7, haceDias(80), { amount_total: 700, sale_order_origin_id: sale }),
    ]);
    const m = inact.metricas(c, HOY);
    assert.strictEqual(m.cantidad_compras, 1);
    assert.strictEqual(m.total_historico, 1000);
    // La compra agrupada lleva la fecha del primer ticket
    assert.strictEqual(m.dias_sin_comprar, 90);
});

test('métricas: ticket promedio, última compra, intervalo y top productos', () => {
    const t1 = ticket(8, haceDias(150), { amount_total: 1000 });
    const t2 = ticket(8, haceDias(120), { amount_total: 2000 });
    const t3 = ticket(8, haceDias(100), { amount_total: 3000 });
    const t4 = ticket(8, haceDias(70), { amount_total: 500 });
    const c = cliente([t1, t2, t3, t4], [
        linea(t1, 10, 2, 200), linea(t1, 11, 50, 500),
        linea(t2, 10, 3, 300),
        linea(t3, 10, 1, 100), linea(t3, 12, 4, 400),
        linea(t4, 12, 1, 100),
    ]);
    const m = inact.metricas(c, HOY);
    assert.strictEqual(m.cantidad_compras, 4);
    assert.strictEqual(m.total_historico, 6500);
    assert.strictEqual(m.ticket_promedio, 1625);
    assert.strictEqual(m.monto_ultima_compra, 500);
    assert.strictEqual(m.dias_sin_comprar, 70);
    assert.strictEqual(m.primera_compra, haceDias(150));
    // gaps 30, 20, 30 → mediana 30
    assert.strictEqual(m.intervalo_habitual_dias, 30);
    // 10 aparece en 3 compras; 12 en 2; 11 en 1 (aunque tenga más unidades)
    assert.deepStrictEqual(m.top_productos.map((p) => p.id), [10, 12, 11]);
    assert.deepStrictEqual(m.top_productos[0], { id: 10, nombre: 'Producto 10', cantidad_total: 6, veces: 3, ultima_vez: haceDias(100) });
    assert.strictEqual(m.top_productos[1].ultima_vez, haceDias(70));
});

test('intervalo habitual null con menos de 3 compras; top hasta 10', () => {
    const t = ticket(9, haceDias(100));
    const lineas = Array.from({ length: 15 }, (_, i) => linea(t, 100 + i, i + 1, 10));
    const m = inact.metricas(cliente([t, ticket(9, haceDias(90))], lineas), HOY);
    assert.strictEqual(m.intervalo_habitual_dias, null);
    assert.strictEqual(m.top_productos.length, 10);
    // Empate en veces: más cantidad primero
    assert.strictEqual(m.top_productos[0].id, 114);
});

test('exclusiones: marca manual, pedido activo, nuevos e importante (en ese orden)', () => {
    assert.strictEqual(inact.motivoExclusion({}), null);
    assert.strictEqual(inact.motivoExclusion({ esImportante: true }), 'es_importante');
    assert.strictEqual(inact.motivoExclusion({ enFlujoNuevos: true, esImportante: true }), 'en_flujo_nuevos');
    assert.strictEqual(inact.motivoExclusion({ pedidoActivo: true, enFlujoNuevos: true }), 'pedido_activo');
    assert.strictEqual(inact.motivoExclusion({ marca: { marca: 'excluido' }, pedidoActivo: true }), 'manual');
    assert.strictEqual(inact.motivoExclusion({ marca: null }), null);
});

function toca(extra = {}) {
    return inact.tocaHoy({
        esInactivo: true,
        diasSinComprar: 75,
        ciclo: inact.cicloActual(null, haceDias(75)),
        hoy: HOY,
        cfg: CFG,
        ...extra,
    });
}

test('primer toque: nunca contactado; vence en 2 días hábiles', () => {
    const t = toca();
    assert.strictEqual(t.toca, 'primer_toque');
    assert.strictEqual(t.motivo, '75 días sin comprar; nunca contactado como inactivo');
    assert.strictEqual(t.vence, '2026-11-05');
    assert.strictEqual(t.proxima_accion, HOY);
    // Viernes → martes
    assert.strictEqual(inact.habilesDespues('2026-11-06', 2), '2026-11-10');
    assert.strictEqual(toca({ esInactivo: false }).toca, null);
    assert.strictEqual(toca({ esInactivo: false }).codigo, 'no_es_inactivo');
});

test('primer toque → 15 días sin respuesta → segundo toque → ciclo cerrado', () => {
    const ciclo = haceDias(75);
    const enviado = `${haceDias(14)}T10:00:00-03:00`;
    const row1 = { ciclo_desde_compra: ciclo, toques_enviados: 1, ultimo_contacto: enviado, ultimo_tipo: 'primer_toque', proxima_accion: health.addDays(haceDias(14), 15), cerrado: false };
    const a14 = toca({ ciclo: inact.cicloActual(row1, ciclo), ultimoContactoDia: haceDias(14) });
    assert.strictEqual(a14.toca, null);
    assert.strictEqual(a14.codigo, 'todavia_no');
    assert.strictEqual(a14.proxima_accion, health.addDays(HOY, 1));

    const row15 = { ...row1, ultimo_contacto: `${haceDias(15)}T10:00:00-03:00`, proxima_accion: HOY };
    const a15 = toca({ ciclo: inact.cicloActual(row15, ciclo), ultimoContactoDia: haceDias(15) });
    assert.strictEqual(a15.toca, 'segundo_toque');

    const row2 = { ...row15, toques_enviados: 2, ultimo_tipo: 'segundo_toque', proxima_accion: null, cerrado: true };
    const cerrado = toca({ ciclo: inact.cicloActual(row2, ciclo) });
    assert.strictEqual(cerrado.toca, null);
    assert.strictEqual(cerrado.cerrado, true);
    assert.strictEqual(cerrado.codigo, 'ciclo_cerrado');
    // Aunque cerrado no esté guardado, con max_toques toques se cierra
    assert.strictEqual(toca({ ciclo: inact.cicloActual({ ...row2, cerrado: false }, ciclo) }).codigo, 'ciclo_cerrado');
});

test('si responde: sin toque mientras haya respuesta pendiente, y sin segundo toque después de revisar', () => {
    const ciclo = haceDias(80);
    const row = { ciclo_desde_compra: ciclo, toques_enviados: 1, ultimo_contacto: `${haceDias(20)}T10:00:00-03:00`, ultimo_tipo: 'primer_toque', proxima_accion: haceDias(5), cerrado: false };
    const recibido = `${haceDias(19)}T12:00:00-03:00`;
    const pendiente = toca({ ciclo: inact.cicloActual(row, ciclo), respuestaPendiente: true, ultimoRecibido: recibido });
    assert.strictEqual(pendiente.toca, null);
    assert.strictEqual(pendiente.codigo, 'respuesta_pendiente');
    const revisado = toca({ ciclo: inact.cicloActual(row, ciclo), respuestaPendiente: false, ultimoRecibido: recibido });
    assert.strictEqual(revisado.toca, null);
    assert.strictEqual(revisado.cerrado, true);
    // Un mensaje viejo (antes del primer toque) no cuenta como respuesta
    const viejo = toca({ ciclo: inact.cicloActual(row, ciclo), ultimoRecibido: `${haceDias(40)}T12:00:00-03:00` });
    assert.strictEqual(viejo.toca, 'segundo_toque');
});

test('si vuelve a comprar, el ciclo viejo no cuenta y arranca uno nuevo', () => {
    const rowViejo = { ciclo_desde_compra: haceDias(300), toques_enviados: 2, ultimo_contacto: `${haceDias(200)}T10:00:00-03:00`, ultimo_tipo: 'segundo_toque', proxima_accion: null, cerrado: true };
    const ciclo = inact.cicloActual(rowViejo, haceDias(65));
    assert.deepStrictEqual([ciclo.ciclo_desde_compra, ciclo.toques_enviados, ciclo.cerrado, ciclo.ultimo_contacto], [haceDias(65), 0, false, null]);
    assert.strictEqual(toca({ ciclo }).toca, 'primer_toque');
});

test('convivencia: un mensaje por día y pausa entre flujos', () => {
    const hoy = toca({ ultimoContactoDia: HOY });
    assert.strictEqual(hoy.toca, null);
    assert.strictEqual(hoy.codigo, 'ya_contactado_hoy');
    const dos = toca({ ultimoContactoDia: haceDias(2) });
    assert.strictEqual(dos.codigo, 'pausa_entre_flujos');
    assert.strictEqual(dos.proxima_accion, health.addDays(HOY, 1));
    assert.strictEqual(toca({ ultimoContactoDia: haceDias(3) }).toca, 'primer_toque');
    assert.strictEqual(toca({ noContactar: true }).codigo, 'no_contactar');
});

function ci(id, extra) {
    return { id, nombre: `C${id}`, rubro: null, categorias_compradas: [], ciudad: null, telefono: '+54', dias_sin_comprar: 70, total_historico: 0, ultima_compra: null, toca_hoy: null, no_contactar: false, respuesta_pendiente: false, ...extra };
}

test('orden por default dias_sin_comprar_asc y los otros órdenes', () => {
    const lista = [ci(1, { dias_sin_comprar: 200, total_historico: 5 }), ci(2, { dias_sin_comprar: 61, total_historico: 1 }), ci(3, { dias_sin_comprar: 61, total_historico: 9 })];
    assert.deepStrictEqual(inact.ordenar(lista).map((c) => c.id), [3, 2, 1]);
    assert.deepStrictEqual(inact.ordenar(lista, 'dias_sin_comprar_desc').map((c) => c.id), [1, 3, 2]);
    assert.deepStrictEqual(inact.ordenar(lista, 'total_historico_desc').map((c) => c.id), [3, 1, 2]);
});

test('filtros rubro (principal o comprado), ciudad sin tildes y con_telefono', () => {
    const lista = [
        ci(1, { rubro: 'Librería', ciudad: 'Pergamino' }),
        ci(2, { rubro: 'Bazar', categorias_compradas: [{ rubro: 'Libreria', monto: 1, porcentaje: 10 }], ciudad: 'Colón', telefono: null }),
        ci(3, { rubro: 'Tecnología', ciudad: 'colon' }),
    ];
    assert.deepStrictEqual(inact.filtrar(lista, { rubro: 'libreria' }).map((c) => c.id), [1, 2]);
    assert.deepStrictEqual(inact.filtrar(lista, { ciudad: 'COLON' }).map((c) => c.id), [2, 3]);
    assert.deepStrictEqual(inact.filtrar(lista, { con_telefono: false }).map((c) => c.id), [2]);
    assert.deepStrictEqual(inact.filtrar(lista, { toca_hoy: false }).length, 3);
});

test('resumen y recuperados_30d', () => {
    const lista = [
        ci(1, { dias_sin_comprar: 61, total_historico: 100, toca_hoy: 'primer_toque', puede_enviar_ahora: true }),
        ci(2, { dias_sin_comprar: 150, total_historico: 200, toca_hoy: 'segundo_toque', telefono: null }),
        ci(3, { dias_sin_comprar: 365, total_historico: 300, no_contactar: true, respuesta_pendiente: true }),
    ];
    const r = inact.resumir(lista, { pedido_activo: 3, manual: 1 }, 2);
    assert.deepStrictEqual(r.por_tramo, { '61_90': 1, '91_180': 1, '181_365': 1 });
    assert.strictEqual(r.monto_historico_total, 600);
    assert.deepStrictEqual(r.toca_hoy, { primer_toque: 1, segundo_toque: 1 });
    assert.strictEqual(r.puede_enviar_ahora, 1);
    assert.deepStrictEqual(r.bloqueados, { respuesta_pendiente: 1, no_contactar: 1, sin_telefono: 1 });
    assert.deepStrictEqual(r.excluidos, { pedido_activo: 3, en_flujo_nuevos: 0, es_importante: 0, manual: 1 });

    const compras = new Map([
        [10, [{ fecha: `${haceDias(5)}T11:00:00-03:00` }]], // toque hace 20, compra hace 5 → recuperado
        [11, [{ fecha: `${haceDias(5)}T11:00:00-03:00` }]], // toque hace 50: compra 45 días después → no
        [12, [{ fecha: `${haceDias(25)}T11:00:00-03:00` }]], // compró antes del toque → no
    ]);
    const toques = [
        { id: 10, fecha: `${haceDias(20)}T10:00:00-03:00` },
        { id: 11, fecha: `${haceDias(50)}T10:00:00-03:00` },
        { id: 12, fecha: `${haceDias(20)}T10:00:00-03:00` },
    ];
    assert.strictEqual(inact.recuperados(toques, compras, HOY), 1);
});

test('config: defaults y claves fuera de rango', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inact-'));
    const f = path.join(dir, 'inactivos.json');
    assert.deepStrictEqual(inact.cargarConfig(path.join(dir, 'no-existe.json')), inact.DEFAULTS);
    fs.writeFileSync(f, JSON.stringify({ dias_min: 90, dias_max: 50, max_toques: 5, reintento_dias: 10 }));
    const warn = console.warn;
    console.warn = () => {};
    const cfg = inact.cargarConfig(f);
    console.warn = warn;
    assert.strictEqual(cfg.dias_min, 90);
    assert.strictEqual(cfg.dias_max, 365);
    assert.strictEqual(cfg.max_toques, 2);
    assert.strictEqual(cfg.reintento_dias, 10);
    // El archivo del repo tiene los defaults
    assert.deepStrictEqual(inact.cargarConfig(), inact.DEFAULTS);
});

test('validación de la query: defaults y fuera de rango → datos_invalidos', () => {
    const ok = v.validarQueryInactivos({}, CFG);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.value.dias_min, 60);
    assert.strictEqual(ok.value.dias_max, 365);
    assert.strictEqual(ok.value.orden, 'dias_sin_comprar_asc');
    assert.strictEqual(ok.value.limit, 50);
    const campos = (q) => v.validarQueryInactivos(q, CFG).errors.map((e) => e.campo).sort();
    assert.deepStrictEqual(campos({ dias_min: '0' }), ['dias_min']);
    assert.deepStrictEqual(campos({ dias_min: '731' }), ['dias_min']);
    assert.deepStrictEqual(campos({ dias_max: '1826' }), ['dias_max']);
    assert.deepStrictEqual(campos({ dias_min: '100', dias_max: '100' }), ['dias_max']);
    assert.deepStrictEqual(campos({ dias_max: '61' }), []);
    assert.deepStrictEqual(campos({ monto_historico_min: '-1', compras_min: '0' }), ['compras_min', 'monto_historico_min']);
    assert.deepStrictEqual(campos({ orden: 'x', toca_hoy: 'si', con_telefono: '1', limit: '101' }), ['con_telefono', 'limit', 'orden', 'toca_hoy']);
    assert.strictEqual(v.validarQueryInactivos({ no_contactar: 'false' }, CFG).value.no_contactar, false);
    assert.deepStrictEqual(v.validarQueryResumenInactivos({ dias_min: 'x' }, CFG).errors.map((e) => e.campo), ['dias_min']);
});

test('envío: exactamente uno de etapa o tipo_inactivo; IVA y productos', () => {
    const base = { mensaje: 'Hola, hace mucho que no te vemos', id_externo: 'grok-1596-inactivo1-20261103' };
    const ok = v.validarEnvio({ ...base, tipo_inactivo: 'primer_toque', productos_recomendados: [23866] });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.value.tipo_inactivo, 'primer_toque');
    assert.strictEqual(ok.value.etapa, undefined);
    const campos = (b) => v.validarEnvio(b).errors.map((e) => e.campo).sort();
    assert.deepStrictEqual(campos(base), ['etapa']);
    assert.deepStrictEqual(campos({ ...base, etapa: 'dia_1', tipo_inactivo: 'primer_toque' }), ['tipo_inactivo']);
    assert.deepStrictEqual(campos({ ...base, tipo_inactivo: 'tercer_toque' }), ['tipo_inactivo']);
    assert.deepStrictEqual(campos({ ...base, tipo_inactivo: 'primer_toque', mensaje: 'Precio con IVA' }), ['mensaje']);
    assert.deepStrictEqual(campos({ ...base, tipo_inactivo: 'primer_toque', productos_recomendados: ['23866'] }), ['productos_recomendados']);
    assert.deepStrictEqual(campos({ ...base, tipo_inactivo: 'primer_toque', productos_recomendados: [1.5] }), ['productos_recomendados']);
    assert.deepStrictEqual(campos({ ...base, tipo_inactivo: 'primer_toque', productos_recomendados: Array.from({ length: 21 }, (_, i) => i + 1) }), ['productos_recomendados']);
});

test('bodies: confirmar, marca manual y seguimiento de inactivos', () => {
    const now = new Date('2026-11-03T12:00:00-03:00');
    assert.deepStrictEqual(v.validarConfirmar(undefined), { value: {}, errors: [] });
    assert.deepStrictEqual(v.validarConfirmar({}).errors, []);
    assert.strictEqual(v.validarConfirmar({ enviado_at: '2026-11-03T11:58:00-03:00' }, now).value.enviado_at.toISOString(), '2026-11-03T14:58:00.000Z');
    assert.deepStrictEqual(v.validarConfirmar({ enviado_at: '2026-11-03T12:05:00-03:00' }, now).errors.map((e) => e.campo), ['enviado_at']);
    assert.deepStrictEqual(v.validarConfirmar({ otro: 1 }).errors.map((e) => e.campo), ['otro']);

    assert.deepStrictEqual(v.validarInactivoPatch({ marca: 'excluido', nota: ' Empleado interno ' }), { value: { marca: 'excluido', nota: 'Empleado interno' }, errors: [] });
    assert.deepStrictEqual(v.validarInactivoPatch({ marca: null }).errors, []);
    const campos = (b) => v.validarInactivoPatch(b).errors.map((e) => e.campo).sort();
    assert.deepStrictEqual(campos({ marca: 'excluido' }), ['nota']);
    assert.deepStrictEqual(campos({ nota: 'x' }), ['marca']);
    assert.deepStrictEqual(campos({ marca: 'fijo', nota: 'x' }), ['marca']);
    assert.deepStrictEqual(campos({ marca: 'excluido', nota: 'x'.repeat(501) }), ['nota']);
    assert.deepStrictEqual(campos({ marca: null, extra: 1 }), ['extra']);

    const s = (b) => v.validarSeguimientoInactivo(b, now).errors.map((e) => e.campo).sort();
    assert.deepStrictEqual(s({ toques_enviados: 1, cerrado: false, proxima_accion: '2026-11-18' }), []);
    assert.deepStrictEqual(s({ proxima_accion: null }), []);
    assert.deepStrictEqual(s({}), ['body']);
    assert.deepStrictEqual(s({ toques_enviados: 3 }), ['toques_enviados']);
    assert.deepStrictEqual(s({ cerrado: 'si', ultimo_contacto: '2026-12-01' }), ['cerrado', 'ultimo_contacto']);
});

let ok = 0;
for (const [nombre, fn] of tests) {
    try {
        fn();
        ok++;
    } catch (err) {
        console.error(`❌ ${nombre}`);
        throw err;
    }
}
console.log(`✅ agenteInactivos: ${ok} tests OK`);
