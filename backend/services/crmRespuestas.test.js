// Tests de crmRespuestas.js (validación de preguntas frecuentes). Uso: node services/crmRespuestas.test.js
const assert = require('assert');
const { validarRespuesta, usables } = require('./crmRespuestas');

// Alta: la pregunta es obligatoria
let v = validarRespuesta({ pregunta: '  ¿Hacen envíos?  ', respuesta: 'Sí,\r\na todo el país.\n', informar_a_todos: false });
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.value, { pregunta: '¿Hacen envíos?', respuesta: 'Sí,\na todo el país.', informar_a_todos: false });
v = validarRespuesta({ respuesta: 'x' });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['pregunta']);
v = validarRespuesta({ pregunta: 'x'.repeat(201) });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['pregunta']);
v = validarRespuesta({ pregunta: 'ok', activa: 'si', respuesta: 3 });
assert.deepStrictEqual(v.errors.map((e) => e.campo).sort(), ['activa', 'respuesta']);
v = validarRespuesta(null);
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['body']);

// Edición parcial: solo lo que viene, y algo tiene que venir
v = validarRespuesta({ activa: false }, { parcial: true });
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.value, { activa: false });
v = validarRespuesta({}, { parcial: true });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['body']);
v = validarRespuesta({ pregunta: '' }, { parcial: true });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['pregunta']);

// Usables: activas y con texto
assert.deepStrictEqual(usables([
    { id: 1, activa: true, respuesta: 'a' },
    { id: 2, activa: false, respuesta: 'b' },
    { id: 3, activa: true, respuesta: '  ' },
]).map((r) => r.id), [1]);

console.log('✅ crmRespuestas: todos los tests pasaron');
