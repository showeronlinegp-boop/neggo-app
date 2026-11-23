// Etapas de posibles clientes con chat de WhatsApp. Sin base. node backend/services/leadEtapas.test.js

const assert = require('assert');
const e = require('./leadEtapas');

const ahora = new Date('2026-11-22T15:00:00Z');
const hace = (dias) => new Date(ahora.getTime() - dias * 86400000);
const base = {
    manual: null, churn: false, noContactar: false, descartadoCrm: false, resultadoGrok: null,
    ultimoDeEllos: null, ultimoNuestro: null, ultimoRecibidoGrok: null, ultimoEnviadoGrok: null,
};
const et = (s) => e.calcularEtapa({ ...base, ...s }, ahora);

assert.strictEqual(et({}).etapa, 'sin_contactar');
assert.strictEqual(et({ ultimoNuestro: hace(2) }).etapa, 'contactado');
assert.strictEqual(et({ ultimoEnviadoGrok: hace(3) }).etapa, 'contactado');
assert.strictEqual(et({ ultimoNuestro: hace(15) }).etapa, 'sin_respuesta');
assert.strictEqual(et({ ultimoNuestro: hace(20), ultimoDeEllos: hace(19) }).etapa, 'conversando');
assert.strictEqual(et({ ultimoRecibidoGrok: hace(5) }).etapa, 'conversando');
assert.strictEqual(et({ ultimoDeEllos: hace(1), resultadoGrok: 'interesado' }).etapa, 'interesado');
assert.strictEqual(et({ ultimoDeEllos: hace(1), resultadoGrok: 'no_interesado' }).etapa, 'descartado');
assert.strictEqual(et({ ultimoDeEllos: hace(1), descartadoCrm: true }).etapa, 'descartado');
assert.strictEqual(et({ ultimoDeEllos: hace(1), churn: true }).etapa, 'no_contactar');
assert.strictEqual(et({ noContactar: true, resultadoGrok: 'interesado' }).etapa, 'no_contactar');

// Lo manual gana sobre lo automático, salvo no_contactar; una etapa manual inválida se ignora
const m = et({ ultimoDeEllos: hace(1), manual: 'interesado' });
assert.deepStrictEqual([m.etapa, m.automatica, m.manual], ['interesado', 'conversando', true]);
assert.strictEqual(et({ ultimoDeEllos: hace(1), manual: 'descartado' }).etapa, 'descartado');
assert.strictEqual(et({ churn: true, manual: 'interesado' }).etapa, 'no_contactar');
assert.strictEqual(et({ manual: 'sin_respuesta' }).etapa, 'sin_contactar');
assert.strictEqual(et({ manual: 'sin_respuesta' }).manual, false);

// Conversación abierta: lo último lo escribió él
assert.strictEqual(et({ ultimoDeEllos: hace(1), ultimoNuestro: hace(2) }).espera_respuesta, true);
assert.strictEqual(et({ ultimoDeEllos: hace(2), ultimoNuestro: hace(1) }).espera_respuesta, false);
assert.strictEqual(et({ ultimoRecibidoGrok: hace(1) }).espera_respuesta, true);
assert.strictEqual(et({ ultimoNuestro: hace(1) }).espera_respuesta, false);
assert.strictEqual(et({ ultimoDeEllos: hace(1), ultimoNuestro: hace(2) }).ultimo_mensaje_at, hace(1).getTime());
assert.strictEqual(et({ ultimoDeEllos: 'no es fecha' }).etapa, 'sin_contactar');

// Agrupado en el orden del embudo, primero los que esperan respuesta
const g = e.agruparPorEtapa([
    { id: 1, etapa: 'conversando', espera_respuesta: false, ultimo_mensaje_at: 300 },
    { id: 2, etapa: 'conversando', espera_respuesta: true, ultimo_mensaje_at: 100 },
    { id: 3, etapa: 'conversando', espera_respuesta: false, ultimo_mensaje_at: 500 },
    { id: 4, etapa: 'rara', espera_respuesta: false },
]);
assert.deepStrictEqual(g.map((x) => x.id), e.IDS);
assert.deepStrictEqual(g.find((x) => x.id === 'conversando').items.map((x) => x.id), [2, 3, 1]);
assert.deepStrictEqual(g.find((x) => x.id === 'sin_contactar').items.map((x) => x.id), [4]);

console.log('✅ leadEtapas: todos los tests pasaron');
