// Cruce de chats de WhatsApp con posibles clientes. Sin base ni Odoo. node backend/services/whatsappLeads.test.js

const assert = require('assert');
const r = require('./whatsappLeads');

// Número de un jid
assert.strictEqual(r.numeroDeJid('5492477665157@s.whatsapp.net'), '+5492477665157');
assert.strictEqual(r.numeroDeJid('5492477665157:12@s.whatsapp.net'), '+5492477665157');
assert.strictEqual(r.numeroDeJid('123@lid'), null);

// Mapeos: número directo, lid con alt, lid sin alt, grupo y repetidos
assert.deepStrictEqual(r.mapeosDeChats([
    { chat: '5492477111111@s.whatsapp.net' },
    { chat: '111@lid', alt: '5492477222222@s.whatsapp.net' },
    { chat: '222@lid', alt: null },
    { chat: '333@lid', alt: '444@lid' },
    { chat: '120363188316302992@g.us', alt: '5492477333333@s.whatsapp.net' },
    { chat: '111@lid', alt: '5492477999999@s.whatsapp.net' },
]), [
    { chat: '5492477111111@s.whatsapp.net', numero: '+5492477111111' },
    { chat: '111@lid', numero: '+5492477222222' },
]);
assert.deepStrictEqual(r.mapeosDeChats(null), []);

// Índices de prueba (clave = característica + número, 10 dígitos)
const partners = new Map([['2477111111', { id: 50 }]]);
const leads = new Map([
    ['2477222222', { id: 7 }],
    ['2477333333', { id: 8 }],
    ['2477444444', { id: 9, odoo_partner_id: 51 }],
]);
const idx = { partnerPorTelefono: (k) => partners.get(k) || null, leadPorTelefono: (k) => leads.get(k) || null };
const base = { fuente: 'whatsapp', confianza: 'alta', partnerId: null, leadId: null };

// Cliente por teléfono gana sobre todo lo demás
assert.deepStrictEqual(r.decidirVinculo({ ...base, numero: '+5492477111111' }, idx), { accion: 'cliente', partnerId: 50, phoneKey: '2477111111' });
// Posible cliente por teléfono
assert.deepStrictEqual(r.decidirVinculo({ ...base, numero: '+5492477222222' }, idx), { accion: 'lead', leadId: 7, phoneKey: '2477222222' });
// Nadie: posible cliente nuevo
assert.deepStrictEqual(r.decidirVinculo({ ...base, numero: '+5492477555555' }, idx), { accion: 'nuevo_lead', phoneKey: '2477555555' });
// Número extranjero o raro: nada
assert.strictEqual(r.decidirVinculo({ ...base, numero: '+34600111222' }, idx), null);
assert.strictEqual(r.decidirVinculo({ ...base, numero: null }, idx), null);
// Ya vinculado a un lead: nada
assert.strictEqual(r.decidirVinculo({ ...base, leadId: 7, numero: '+5492477222222' }, idx), null);
// Desvinculado a mano de ese lead: no se vuelve a vincular ni se crea otro
assert.strictEqual(r.decidirVinculo({ ...base, desvinculadoLead: 7, numero: '+5492477222222' }, idx), null);

// Chat con cliente por cotizaciones y un lead con ese número: el lead es ese cliente (solo alta o manual)
assert.deepStrictEqual(r.decidirVinculo({ fuente: 'cotizacion', confianza: 'alta', partnerId: 60, leadId: null, numero: '+5492477333333' }, idx),
    { accion: 'lead_es_cliente', leadId: 8, partnerId: 60, phoneKey: '2477333333' });
assert.strictEqual(r.decidirVinculo({ fuente: 'cotizacion', confianza: 'media', partnerId: 60, leadId: null, numero: '+5492477333333' }, idx), null);
assert.deepStrictEqual(r.decidirVinculo({ fuente: 'manual', confianza: 'alta', partnerId: 60, leadId: null, numero: '+5492477333333' }, idx).accion, 'lead_es_cliente');
// El lead ya pasó a Odoo: nada
assert.strictEqual(r.decidirVinculo({ fuente: 'cotizacion', confianza: 'alta', partnerId: 60, leadId: null, numero: '+5492477444444' }, idx), null);
// Chat sin cliente y su lead ya pasó a Odoo: es de ese cliente
assert.deepStrictEqual(r.decidirVinculo({ ...base, numero: '+5492477444444' }, idx), { accion: 'cliente', partnerId: 51, phoneKey: '2477444444' });
// Chat con cliente y sin lead: nada (ya está identificado)
assert.strictEqual(r.decidirVinculo({ fuente: 'cotizacion', confianza: 'alta', partnerId: 60, leadId: null, numero: '+5492477555555' }, idx), null);

// Nombre del lead nuevo
assert.strictEqual(r.nombreLeadNuevo({ nombreAgenda: 'Beto  Estado: LEAD NLD-23', pushName: 'Roberto' }), 'Beto');
assert.strictEqual(r.nombreLeadNuevo({ nombreAgenda: null, pushName: 'Kiosco Sol' }), 'Kiosco Sol');
assert.strictEqual(r.nombreLeadNuevo({ nombreAgenda: 'Estado: NRI NLD-09', pushName: '.' }), null);

// Candidatos para vincular a mano: primero los que comparten palabra, después los recientes
const cands = r.ordenarCandidatos('Kiosco Sol de Rojas', [
    { chat: 'a@lid', nombre: 'Marta', ultimo_mensaje_at: '2026-11-21T10:00:00Z' },
    { chat: 'b@lid', nombre: 'Sol Kiosco', ultimo_mensaje_at: '2026-11-10T10:00:00Z' },
    { chat: 'c@lid', nombre: 'Rojas', ultimo_mensaje_at: '2026-11-11T10:00:00Z' },
    { chat: 'd@lid', nombre: null, ultimo_mensaje_at: '2026-11-22T10:00:00Z' },
]);
assert.deepStrictEqual(cands.map((c) => c.chat), ['b@lid', 'c@lid', 'd@lid', 'a@lid']);
assert.deepStrictEqual(cands.map((c) => c.coincide), [true, true, false, false]);
assert.strictEqual(r.ordenarCandidatos('x', [{ chat: 'a' }, { chat: 'b' }], 1).length, 1);

console.log('✅ whatsappLeads: todos los tests pasaron');
