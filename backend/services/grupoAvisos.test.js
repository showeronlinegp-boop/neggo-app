// Grupo de avisos de la comunidad (nota 228). Sin base ni red. node backend/services/grupoAvisos.test.js

const assert = require('assert');
const g = require('./grupoAvisos');

// Teléfonos escritos distinto cruzan
assert.strictEqual(g.claveTelefono('5492477508804@s.whatsapp.net'), '2477508804');
assert.strictEqual(g.claveTelefono('+54 9 2477 50-8804'), '2477508804');
assert.strictEqual(g.claveTelefono('542477508804'), '2477508804');
assert.strictEqual(g.claveTelefono('2477508804'), '2477508804');
assert.strictEqual(g.claveTelefono('2477 15 508804'), '2477508804');
assert.strictEqual(g.claveTelefono('59899123456'), 'x59899123456');
assert.strictEqual(g.claveTelefono('123'), null);
assert.strictEqual(g.claveTelefono(null), null);

// Participantes de Evolution
const part = g.normalizarParticipantes([
    { id: '227285709914212@lid', phoneNumber: '5492604414056@s.whatsapp.net', admin: null },
    { id: '227285709914212@lid', phoneNumber: '5492604414056@s.whatsapp.net', admin: null },
    { id: '5492477000000@s.whatsapp.net', admin: 'admin' },
    { id: '' },
]);
assert.deepStrictEqual(part, [
    { lid: '227285709914212', numero: '5492604414056', admin: null },
    { lid: 'pn5492477000000', numero: '5492477000000', admin: 'admin' },
]);
assert.deepStrictEqual(g.normalizarParticipantes(null), []);

// Diferencias entre fotos
const d = g.diferencias([{ lid: 'a' }, { lid: 'b' }], [{ lid: 'b' }, { lid: 'c' }]);
assert.deepStrictEqual(d.entraron.map((m) => m.lid), ['c']);
assert.deepStrictEqual(d.salieron.map((m) => m.lid), ['a']);
assert.deepStrictEqual(d.siguen.map((m) => m.lid), ['b']);

// Lista vacía o cortada no se toma
assert.strictEqual(g.fotoConfiable(0, 353).ok, true);
assert.strictEqual(g.fotoConfiable(353, 0).ok, false);
assert.strictEqual(g.fotoConfiable(353, 200).ok, false);
assert.strictEqual(g.fotoConfiable(353, 340).ok, true);
assert.strictEqual(g.fotoConfiable(10, 5).ok, true);

// Estado de un contacto
const filas = [
    { lid: '111', numero: '5492477508804', activo: true, visto_desde: '2026-11-22T12:00:00Z', desde_foto_inicial: true, salio_at: null },
    { lid: '222', numero: '5492477111111', activo: false, visto_desde: '2026-11-22T12:00:00Z', desde_foto_inicial: true, salio_at: '2026-11-25T12:00:00Z' },
];
const idx = g.indiceMiembros(filas);
assert.strictEqual(g.estadoDeContacto({ chats: ['111@lid'] }, idx).estado, 'miembro');
assert.strictEqual(g.estadoDeContacto({ chats: ['5492477508804@s.whatsapp.net'] }, idx).estado, 'miembro');
assert.strictEqual(g.estadoDeContacto({ chats: ['999@lid'], numero: '+5492477508804' }, idx).estado, 'miembro');
const salio = g.estadoDeContacto({ chats: ['222@lid'] }, idx);
assert.strictEqual(salio.estado, 'salio');
assert.strictEqual(salio.salio_at, '2026-11-25T12:00:00.000Z');
assert.strictEqual(g.estadoDeContacto({ chats: ['333@lid'], numero: null }, idx).estado, 'no_esta');
// Si un contacto tiene un chat que se fue y otro que sigue, cuenta el que sigue
assert.strictEqual(g.estadoDeContacto({ chats: ['222@lid', '111@lid'] }, idx).estado, 'miembro');
// Sin ninguna foto todavía no se sabe
assert.strictEqual(g.estadoDeContacto({ chats: ['111@lid'] }, g.indiceMiembros([])), null);

console.log('✅ grupoAvisos: todo OK');
