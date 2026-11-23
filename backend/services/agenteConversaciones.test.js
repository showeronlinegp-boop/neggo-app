// Conversaciones del WhatsApp del negocio de la API del agente. Sin base. node backend/services/agenteConversaciones.test.js

const assert = require('assert');
const c = require('./agenteConversaciones');
const { validarQueryConversaciones } = require('./agenteValidacion');

// 14/11/2026 10:00 en Argentina
const AHORA = new Date('2026-11-14T13:00:00Z');
let n = 0;

function fila(jid, hora, { fromMe = false, tipo = 'conversation', message, pushName = null, alt, participant, chat_nombre = null } = {}) {
    n += 1;
    return {
        key: { id: `M${n}`, remoteJid: jid, fromMe, ...(alt ? { remoteJidAlt: alt } : {}) },
        pushName,
        participant: participant || null,
        messageType: tipo,
        message: message === undefined ? { conversation: `hola ${n}` } : message,
        contextInfo: null,
        messageTimestamp: Date.parse(`2026-11-13T${hora}:00-03:00`) / 1000,
        chat_nombre,
    };
}

// Fechas y rango
assert.strictEqual(c.ayerAr(AHORA), '2026-11-13');
// 14/11 01:00 AR = 04:00 UTC: ayer es el 13
assert.strictEqual(c.ayerAr(new Date('2026-11-14T04:00:00Z')), '2026-11-13');
// 14/11 23:30 AR = 15/11 02:30 UTC: ayer sigue siendo el 13
assert.strictEqual(c.ayerAr(new Date('2026-11-15T02:30:00Z')), '2026-11-13');
const r = c.rangoDia('2026-11-13');
assert.strictEqual(r.desde, Date.parse('2026-11-13T03:00:00Z') / 1000);
assert.strictEqual(r.hasta - r.desde, 86400);
assert.strictEqual(c.isoAr(r.desde), '2026-11-13T00:00:00-03:00');

// Números y nombres
assert.strictEqual(c.numeroDeJid('5492477665157@s.whatsapp.net'), '+5492477665157');
assert.strictEqual(c.numeroDeJid('5492477665157:12@s.whatsapp.net'), '+5492477665157');
assert.strictEqual(c.numeroDeJid('135845554196674@lid'), null);
assert.strictEqual(c.buscarEnWhatsapp('189738854133918@lid'), '189738854133918');
assert.strictEqual(c.buscarEnWhatsapp('5492477123456@s.whatsapp.net'), null);
assert.strictEqual(c.buscarEnWhatsapp(null), null);
assert.strictEqual(c.conIdentidad({ chat: '189738854133918@lid', numero: null, mensajes: [] }, null, null).buscar_en_whatsapp, '189738854133918');
assert.strictEqual(c.conIdentidad({ chat: '189738854133918@lid', numero: null, mensajes: [] }, { numero: '+5492477123456' }, null).buscar_en_whatsapp, null);
assert.strictEqual(c.nombreUtil('135845554196674'), null);
assert.strictEqual(c.nombreUtil(' Clau '), 'Clau');

// Texto de cada tipo
assert.strictEqual(c.textoDe({ extendedTextMessage: { text: 'precio?' } }), 'precio?');
assert.strictEqual(c.textoDe({ imageMessage: { caption: 'esta' } }), 'esta');
assert.strictEqual(c.textoDe({ documentMessage: { fileName: 'pedido.pdf' } }), 'pedido.pdf');
assert.strictEqual(c.textoDe({ audioMessage: {} }), null);
assert.strictEqual(c.textoDe({ conversation: '   ' }), null);

// Agrupar
const LID_A = '135845554196674@lid';
const LID_B = '174930142449827@lid';
const filas = [
    fila(LID_A, '10:00', { pushName: '135845554196674' }),
    fila(LID_A, '10:05', { fromMe: true, pushName: 'Neggo' }),
    fila(LID_A, '10:10', { tipo: 'audioMessage', message: { audioMessage: {} }, pushName: 'Clau' }),
    fila(LID_B, '09:00', { tipo: 'imageMessage', message: { imageMessage: { caption: 'precio?' } }, alt: '5492477000000@s.whatsapp.net' }),
    fila(LID_B, '09:30', { fromMe: true }),
    // Ruido que no tiene que aparecer
    fila(LID_B, '09:40', { tipo: 'reactionMessage', message: { reactionMessage: { text: '👍' } } }),
    fila(LID_B, '09:41', { message: { conversation: '' } }),
    fila('status@broadcast', '11:00'),
    fila('120363000000000000@g.us', '11:30', { pushName: 'Juan', participant: '5492470000001@s.whatsapp.net' }),
    fila(LID_A, '10:20', { tipo: 'pinMessage', message: { pinMessage: {} } }),
];
// Duplicado de Baileys: mismo id
filas.push({ ...filas[0] });

const out = c.agruparConversaciones(filas);
assert.strictEqual(out.length, 2);
assert.deepStrictEqual(out.map((x) => x.chat), [LID_A, LID_B]);
const a = out[0];
assert.strictEqual(a.nombre, 'Clau');
assert.strictEqual(a.numero, null);
assert.strictEqual(a.cantidad_mensajes, 4);
assert.strictEqual(a.mensajes_cliente, 3);
assert.strictEqual(a.ultimo_de, 'cliente');
assert.strictEqual(a.sin_respuesta, true);
assert.deepStrictEqual(a.mensajes.map((m) => m.tipo), ['texto', 'texto', 'audio', 'otro']);
assert.strictEqual(a.mensajes[3].tipo_original, 'pinMessage');
assert.strictEqual(a.mensajes[1].de, 'neggo');
assert.strictEqual(a.primer_mensaje, '2026-11-13T10:00:00-03:00');
assert.ok(!('_ts' in a) && !('_ts' in a.mensajes[0]));
const b = out[1];
assert.strictEqual(b.numero, '+5492477000000');
assert.strictEqual(b.cantidad_mensajes, 2);
assert.strictEqual(b.mensajes[0].tipo, 'foto');
assert.strictEqual(b.mensajes[0].texto, 'precio?');
assert.strictEqual(b.sin_respuesta, false);

// Con grupos
const conGrupos = c.agruparConversaciones(filas, { incluirGrupos: true });
assert.strictEqual(conGrupos.length, 3);
const g = conGrupos.find((x) => x.es_grupo);
assert.strictEqual(g.mensajes[0].autor, 'Juan');
assert.strictEqual(g.mensajes[0].autor_numero, '+5492470000001');
assert.strictEqual(g.nombre, null);

// Validación de la query
let q = validarQueryConversaciones({}, AHORA);
assert.deepStrictEqual(q.errors, []);
assert.strictEqual(q.value.fecha, '2026-11-13');
assert.strictEqual(q.value.incluir_grupos, false);
assert.strictEqual(q.value.sin_respuesta, undefined);
assert.strictEqual(q.value.limit, 20);
q = validarQueryConversaciones({ fecha: '2026-11-14', incluir_grupos: 'true', sin_respuesta: 'true', page: '2', limit: '5' }, AHORA);
assert.deepStrictEqual(q.errors, []);
assert.strictEqual(q.value.fecha, '2026-11-14');
assert.strictEqual(q.value.offset, 5);
assert.strictEqual(q.value.sin_respuesta, true);
q = validarQueryConversaciones({ fecha: '2026-11-15' }, AHORA);
assert.deepStrictEqual(q.errors.map((e) => e.campo), ['fecha']);
q = validarQueryConversaciones({ fecha: '13/11/2026', incluir_grupos: 'si', sin_respuesta: '1' }, AHORA);
assert.deepStrictEqual(q.errors.map((e) => e.campo), ['fecha', 'incluir_grupos', 'sin_respuesta']);

console.log('✅ agenteConversaciones: todos los tests pasaron');
