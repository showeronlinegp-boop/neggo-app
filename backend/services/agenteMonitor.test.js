// Monitoreo del bot: motivos de la cola, resumen y lectura del activity log. Sin base ni Odoo.
// node backend/services/agenteMonitor.test.js

const assert = require('assert');
const { estadoCola, resumir, clienteDePath, envioDePath, accionDePath, validarDias } = require('./agenteMonitorService');

function cliente(extra = {}) {
    return {
        id: 1, telefono: '+5492477000000', toca_hoy: 'dia_1', reserva_activa: null,
        respuesta_pendiente: false, no_contactar: false, seguimiento: { etapa: 'pendiente' }, ...extra,
    };
}

// ── estadoCola ───────────────────────────────────────────────

assert.deepStrictEqual(estadoCola(cliente(), true), { estado: 'toca', motivo: 'pendiente' });
assert.deepStrictEqual(estadoCola(cliente(), false), { estado: 'toca', motivo: 'fuera_de_horario' });
assert.deepStrictEqual(estadoCola(cliente({ telefono: null }), true), { estado: 'toca', motivo: 'sin_telefono' });
assert.deepStrictEqual(estadoCola(cliente({ respuesta_pendiente: true }), true), { estado: 'toca', motivo: 'respuesta_pendiente' });
// Una reserva activa gana a todo lo demás: el bot ya lo está mandando
assert.deepStrictEqual(
    estadoCola(cliente({ reserva_activa: { id_externo: 'x' }, telefono: null }), false),
    { estado: 'toca', motivo: 'reservado' });
assert.deepStrictEqual(estadoCola(cliente({ toca_hoy: null }), true), { estado: 'al_dia', motivo: null });
assert.deepStrictEqual(estadoCola(cliente({ no_contactar: true }), true), { estado: 'cerrado', motivo: 'no_contactar' });
assert.deepStrictEqual(
    estadoCola(cliente({ toca_hoy: null, seguimiento: { etapa: 'finalizado' } }), true),
    { estado: 'cerrado', motivo: null });

// ── resumir ──────────────────────────────────────────────────

const interacciones = [
    { tipo: 'enviado', envio_etapa: true, estado: 'enviado' },
    { tipo: 'enviado', envio_etapa: true, estado: 'enviado' },
    { tipo: 'enviado', envio_etapa: true, estado: 'cancelado' },
    { tipo: 'enviado', envio_etapa: true, estado: 'vencido' },
    { tipo: 'enviado', envio_etapa: true, estado: 'reservado' },
    { tipo: 'enviado', envio_etapa: false, estado: 'enviado' },
    { tipo: 'recibido', envio_etapa: false, estado: 'enviado' },
];
const cola = [
    { estado: 'toca', motivo: 'pendiente' },
    { estado: 'toca', motivo: 'reservado' },
    { estado: 'al_dia', motivo: null },
    { estado: 'cerrado', motivo: 'no_contactar' },
];
assert.deepStrictEqual(resumir({ interacciones, rechazos: [{}, {}], cola }), {
    enviados: 2, cancelados: 1, vencidos: 1, reservados: 1, recibidos: 1, notas: 1,
    rechazos: 2, toca_hoy: 2, sin_enviar_hoy: 1, en_cadencia: 3,
});
// Sin cola (Odoo caído): los contadores de hoy quedan en null, no en 0
const sinCola = resumir({ interacciones: [], rechazos: [], cola: null });
assert.strictEqual(sinCola.toca_hoy, null);
assert.strictEqual(sinCola.en_cadencia, null);

// ── paths del activity log ───────────────────────────────────

assert.strictEqual(clienteDePath('/clientes/1595/envios'), 1595);
assert.strictEqual(clienteDePath('/clientes/1595'), 1595);
assert.strictEqual(clienteDePath('/envios/grok-1595-dia_1/confirmar'), null);
assert.strictEqual(clienteDePath(undefined), null);
assert.strictEqual(envioDePath('/envios/grok-1595-dia_1/confirmar'), 'grok-1595-dia_1');
assert.strictEqual(envioDePath('/clientes/1595/envios'), null);

assert.strictEqual(accionDePath('POST', '/clientes/1595/envios'), 'Reservar envío');
assert.strictEqual(accionDePath('POST', '/envios/abc/confirmar'), 'Confirmar envío');
assert.strictEqual(accionDePath('POST', '/envios/abc/cancelar'), 'Cancelar envío');
assert.strictEqual(accionDePath('PATCH', '/clientes/1595'), 'Actualizar contacto');
assert.strictEqual(accionDePath('PATCH', '/clientes/1595/seguimiento'), 'Cambiar seguimiento');
assert.strictEqual(accionDePath('POST', '/clientes/1595/interacciones'), 'Registrar mensaje');
assert.strictEqual(accionDePath('POST', '/clientes/1595/revisado'), 'Marcar respuestas leídas');
assert.strictEqual(accionDePath('POST', '/feedback'), 'Dejar feedback');
assert.strictEqual(accionDePath('DELETE', '/otra'), 'DELETE /otra');

// ── validarDias ──────────────────────────────────────────────

assert.strictEqual(validarDias(undefined), 7);
assert.strictEqual(validarDias('abc'), 7);
assert.strictEqual(validarDias('0'), 7);
assert.strictEqual(validarDias('1'), 1);
assert.strictEqual(validarDias('30'), 30);
assert.strictEqual(validarDias('500'), 90);

console.log('✅ agenteMonitor: todos los tests pasaron');
