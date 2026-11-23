// Identidad de los chats del WhatsApp del negocio. Sin base ni Odoo. node backend/services/whatsappIdentidad.test.js

const assert = require('assert');
const r = require('./whatsappIdentidad');
const { validarIdentidadChat } = require('./agenteValidacion');
const { conIdentidad } = require('./agenteConversaciones');

// Referencias
assert.deepStrictEqual(r.extraerReferencias('Te paso la S04466 y la s04466, también S04470.'), ['S04466', 'S04470']);
assert.deepStrictEqual(r.extraerReferencias('S0446 o XS04466 no'), []);
assert.deepStrictEqual(r.extraerReferencias(null), []);

const ordenes = new Map([
    ['S00001', { partnerId: 10, partnerNombre: 'Lucila' }],
    ['S00002', { partnerId: 10, partnerNombre: 'Lucila' }],
    ['S00003', { partnerId: 10, partnerNombre: 'Lucila' }],
    ['S00004', { partnerId: 11, partnerNombre: 'Yamii' }],
    ['S00005', { partnerId: 12, partnerNombre: 'Public user' }],
    ['S00006', { partnerId: 2, partnerNombre: 'Mariano Menendez' }],
    ['S00007', { partnerId: 13, partnerNombre: 'Agus' }],
    ['S00008', { partnerId: 14, partnerNombre: 'Gisela' }],
    ['S00009', { partnerId: 15, partnerNombre: 'Neli' }],
]);
const refs = new Map([
    ['a@lid', ['S00001', 'S00002', 'S00003', 'S00004']], // 3 de 4 = 75 % → alta
    ['b@lid', ['S00004']], // una sola → media
    ['c@lid', ['S00005', 'S00006', 'S00009', 'S99999']], // genérico, interno y una que no existe → Neli media
    ['d@lid', ['S00007', 'S00008']], // empate → nada
    ['e@lid', ['S00007', 'S00008', 'S00009', 'S00001']], // nadie llega al 60 % → nada
    ['f@lid', ['S00001']], // Lucila otra vez, con menos → baja
]);
const out = r.decidirPorCotizaciones(refs, ordenes, [2]);
const por = Object.fromEntries(out.map((d) => [d.chat, d]));
assert.deepStrictEqual(Object.keys(por).sort(), ['a@lid', 'b@lid', 'c@lid', 'f@lid']);
assert.strictEqual(por['a@lid'].partnerId, 10);
assert.strictEqual(por['a@lid'].confianza, 'alta');
assert.strictEqual(por['a@lid'].evidencia.cotizaciones, 3);
assert.deepStrictEqual(por['a@lid'].evidencia.otros_clientes, [{ id: 11, nombre: 'Yamii', cotizaciones: 1 }]);
assert.strictEqual(por['b@lid'].confianza, 'media');
assert.strictEqual(por['c@lid'].partnerId, 15);
assert.strictEqual(por['c@lid'].evidencia.cotizaciones_total, 1);
assert.strictEqual(por['f@lid'].confianza, 'baja');
assert.strictEqual(por['f@lid'].evidencia.mismo_cliente_en_otro_chat, 'a@lid');
// 2 de 3 = 67 %: media
const dos = r.decidirPorCotizaciones(new Map([['g@lid', ['S00001', 'S00002', 'S00004']]]), ordenes);
assert.strictEqual(dos[0].confianza, 'media');

// Mapeo de lid
assert.deepStrictEqual(r.parsearMapeoLid('197731805085715 5492473410163\r\nbasura\n\n'), [{ chat: '197731805085715@lid', numero: '+5492473410163' }]);

// Validación del POST
let v = validarIdentidadChat({ chat: '197731805085715@lid', cliente_id: 901 });
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.value, { chat: '197731805085715@lid', cliente_id: 901 });
v = validarIdentidadChat({ chat: '197731805085715@lid', numero: '2477 15-41-0163', nombre: ' Lu ' });
assert.deepStrictEqual(v.errors, []);
assert.strictEqual(v.value.numero, '+5492477410163');
assert.strictEqual(v.value.nombre, 'Lu');
v = validarIdentidadChat({ chat: '197731805085715', nombre: 'Lu' });
assert.deepStrictEqual(v.errors, []);
assert.strictEqual(v.value.chat, '197731805085715@lid');
v = validarIdentidadChat({ chat: '120363@g.us', cliente_id: '9', numero: '123', extra: 1 });
assert.deepStrictEqual(v.errors.map((e) => e.campo).sort(), ['chat', 'cliente_id', 'extra', 'numero']);
v = validarIdentidadChat({ chat: '197731805085715@lid' });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['body']);

// Identidad sumada a la conversación
const chat = { chat: 'a@lid', numero: null, nombre: null, es_grupo: false, mensajes: [] };
const conId = conIdentidad(chat, { numero: '+5492477410163', nombre: 'Lucila', cliente_id: 10, fuente: 'cotizacion', confianza: 'alta' });
assert.strictEqual(conId.nombre, 'Lucila');
assert.strictEqual(conId.cliente_id, 10);
assert.deepStrictEqual(conId.identificado_por, { fuente: 'cotizacion', confianza: 'alta' });
assert.deepStrictEqual(Object.keys(conId).slice(-1), ['mensajes']);
const sinId = conIdentidad({ ...chat, numero: '+549247' }, undefined, 'La Barra');
assert.strictEqual(sinId.nombre, 'La Barra');
assert.strictEqual(sinId.identificado_por, null);
assert.strictEqual(sinId.cliente_id, null);

console.log('✅ whatsappIdentidad: todos los tests pasaron');
