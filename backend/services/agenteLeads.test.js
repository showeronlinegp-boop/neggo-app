// Posibles clientes de la API del agente. Sin base ni Odoo. node backend/services/agenteLeads.test.js

const assert = require('assert');
const L = require('./agenteLeads');
const V = require('./agenteLeadsValidacion');

const HOY = '2026-11-04';
let n = 0;
function test(nombre, fn) {
    fn();
    n++;
    console.log(`✅ ${nombre}`);
}

// ── Zona ─────────────────────────────────────────────────────
test('zona: Pergamino, Junín y San Nicolás son prioridad 1; Rosario prioridad 2', () => {
    assert.deepStrictEqual(L.zonaDe('2477519062'), { prioridad: 1, localidad: 'Pergamino', caracteristica: '2477' });
    assert.strictEqual(L.zonaDe('2364123456').localidad, 'Junín');
    assert.strictEqual(L.zonaDe('3364123456').localidad, 'San Nicolás');
    assert.strictEqual(L.zonaDe('3415123456').prioridad, 2);
});

test('zona: fuera de los 150 km queda afuera', () => {
    assert.strictEqual(L.zonaDe('3815123456'), null); // Tucumán
    assert.strictEqual(L.zonaDe('1123456789'), null); // AMBA
    assert.strictEqual(L.zonaDe('2324123456'), null); // Mercedes (en "afuera")
    assert.strictEqual(L.zonaDe(null), null);
});

test('excluidos: churn siempre, y los de fuera de zona', () => {
    assert.strictEqual(L.motivoExcluido({ phoneKey: '2477519062', estadoAgenda: 'churn' }), 'churn');
    assert.strictEqual(L.motivoExcluido({ phoneKey: '3815123456', estadoAgenda: 'nri' }), 'fuera_de_zona');
    assert.strictEqual(L.motivoExcluido({ phoneKey: '2477519062', estadoAgenda: 'nri' }), null);
});

// ── Cadencia ─────────────────────────────────────────────────
test('cadencia: pendiente → presentación hoy', () => {
    assert.strictEqual(L.tocaHoy({ hoy: HOY }), 'presentacion');
});

test('cadencia: recordatorio a los 7 días de la presentación, no antes', () => {
    assert.strictEqual(L.tocaHoy({ etapa: 'presentacion', fechaUltimoEnvio: '2026-10-29', hoy: HOY }), null);
    assert.strictEqual(L.tocaHoy({ etapa: 'presentacion', fechaUltimoEnvio: '2026-10-28', hoy: HOY }), 'recordatorio');
});

test('cadencia: cierre a los 14 días del recordatorio y después nada', () => {
    assert.strictEqual(L.tocaHoy({ etapa: 'recordatorio', fechaUltimoEnvio: '2026-10-21', hoy: HOY }), 'cierre');
    assert.strictEqual(L.tocaHoy({ etapa: 'recordatorio', fechaUltimoEnvio: '2026-10-22', hoy: HOY }), null);
    assert.strictEqual(L.tocaHoy({ etapa: 'cierre', fechaUltimoEnvio: '2026-01-01', hoy: HOY }), null);
});

test('cadencia: la presentación mandada a mano desde la app cuenta', () => {
    assert.strictEqual(L.tocaHoy({ presentacionManual: '2026-11-01', hoy: HOY }), null);
    assert.strictEqual(L.tocaHoy({ presentacionManual: '2026-10-20', hoy: HOY }), 'recordatorio');
});

test('cadencia: se frena si contestó, si no quiere, si está bloqueado o finalizado', () => {
    assert.strictEqual(L.tocaHoy({ hoy: HOY, respondio: true }), null);
    assert.strictEqual(L.tocaHoy({ hoy: HOY, noContactar: true }), null);
    assert.strictEqual(L.tocaHoy({ hoy: HOY, bloqueado: true }), null);
    assert.strictEqual(L.tocaHoy({ hoy: HOY, etapa: 'finalizado' }), null);
});

// ── Tope y cola ──────────────────────────────────────────────
test('tope: 15 por defecto, respeta la variable y 0 apaga', () => {
    assert.strictEqual(L.topeDiario({}), 15);
    assert.strictEqual(L.topeDiario({ AGENTE_LEADS_TOPE_DIARIO: '10' }), 10);
    assert.strictEqual(L.topeDiario({ AGENTE_LEADS_TOPE_DIARIO: '0' }), 0);
    assert.strictEqual(L.topeDiario({ AGENTE_LEADS_TOPE_DIARIO: 'x' }), 15);
    assert.strictEqual(L.topeDiario({ AGENTE_LEADS_TOPE_DIARIO: '9999' }), L.TOPE_MAX);
    assert.strictEqual(L.quedanHoy(15, 16), 0);
});

test('cola: seguimientos primero, después zona 1, estado y con nombre', () => {
    const z1 = { prioridad: 1 };
    const z2 = { prioridad: 2 };
    const cola = [
        { id: 1, toca_hoy: 'presentacion', zona: z2, estado_agenda: 'recuperar', nombre: 'A' },
        { id: 2, toca_hoy: 'presentacion', zona: z1, estado_agenda: 'nri', nombre: null },
        { id: 3, toca_hoy: 'presentacion', zona: z1, estado_agenda: 'nri', nombre: 'Beto' },
        { id: 4, toca_hoy: 'presentacion', zona: z1, estado_agenda: 'lead', nombre: null },
        { id: 5, toca_hoy: 'recordatorio', desde: '2026-11-02', zona: z2 },
        { id: 6, toca_hoy: 'cierre', desde: '2026-10-30', zona: z1 },
    ].sort(L.compararCola);
    assert.deepStrictEqual(cola.map((x) => x.id), [6, 5, 4, 3, 2, 1]);
});

test('resultado: no_contactar y ya_en_odoo no se pisan; sin_respuesta sí', () => {
    assert.strictEqual(L.errorResultado(null, 'interesado'), null);
    assert.strictEqual(L.errorResultado('sin_respuesta', 'interesado'), null);
    assert.ok(L.errorResultado('no_contactar', 'interesado'));
    assert.ok(L.errorResultado('ya_en_odoo', 'no_interesado'));
});

// ── Validación ───────────────────────────────────────────────
test('validación: query de leads', () => {
    const ok = V.validarQueryLeads({ para_hoy: 'true', no_contactar: 'todos', limit: '15' });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.value.para_hoy, true);
    assert.strictEqual(ok.value.no_contactar, null);
    assert.strictEqual(ok.value.limit, 15);
    assert.strictEqual(V.validarQueryLeads({}).value.no_contactar, undefined);
    assert.strictEqual(V.validarQueryLeads({ etapa: 'dia_7' }).errors[0].campo, 'etapa');
    assert.strictEqual(V.validarQueryLeads({ para_hoy: 'si' }).errors[0].campo, 'para_hoy');
});

test('validación: envío pide etapa de leads, mensaje e id_externo; nada de IVA', () => {
    assert.deepStrictEqual(V.validarEnvioLead({ etapa: 'presentacion', mensaje: 'Hola', id_externo: 'grok-lead-1-p' }).errors, []);
    const mal = V.validarEnvioLead({ etapa: 'dia_1', mensaje: '', otro: 1 });
    assert.deepStrictEqual(mal.errors.map((e) => e.campo).sort(), ['etapa', 'id_externo', 'mensaje', 'otro']);
    assert.strictEqual(V.validarEnvioLead({ etapa: 'cierre', mensaje: 'Precio + IVA', id_externo: 'x' }).errors[0].campo, 'mensaje');
});

test('validación: mensaje de la charla', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    assert.deepStrictEqual(V.validarMensajeLead({ tipo: 'recibido', mensaje: 'Me interesa' }, now).errors, []);
    assert.strictEqual(V.validarMensajeLead({ tipo: 'recibido', mensaje: 'x', fecha: '2026-12-01T10:00:00-03:00' }, now).errors[0].campo, 'fecha');
    assert.strictEqual(V.validarMensajeLead({ tipo: 'otro', mensaje: 'x' }, now).errors[0].campo, 'tipo');
});

test('validación: PATCH de lead', () => {
    assert.deepStrictEqual(V.validarLeadPatch({ resultado: 'interesado', nota: 'Quiere lista de bazar' }).errors, []);
    assert.deepStrictEqual(V.validarLeadPatch({ no_contactar: true }).errors, []);
    assert.strictEqual(V.validarLeadPatch({ resultado: 'no_contactar' }).errors[0].campo, 'resultado');
    assert.strictEqual(V.validarLeadPatch({ nota: 'solo nota' }).errors[0].campo, 'body');
    assert.ok(V.validarLeadPatch({ no_contactar: true, resultado: 'interesado' }).errors.length);
});

console.log(`\n✅ ${n} tests de leads OK`);
