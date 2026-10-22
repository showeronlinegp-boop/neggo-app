// Reglas del seguimiento que no tocan la base: cuándo se gana y validación del destino.
// node backend/services/crmFollowup.test.js

const assert = require('assert');
const {
    shouldWin, toTarget, FollowupError, STAGES, MANUAL_STAGES, ACTION_TYPES, EVENT_KINDS, RESPONSES,
} = require('./crmFollowupService');

function testShouldWin() {
    // Pasó a Caliente el 20/10 a las 15 h (hora AR = 18 h UTC)
    const caliente = { stage: 'caliente', stage_changed_at: new Date('2026-10-20T18:00:00Z') };
    assert.strictEqual(shouldWin(caliente, '2026-10-21'), true);
    // Compra del mismo día en que pasó a Caliente: cuenta
    assert.strictEqual(shouldWin(caliente, '2026-10-20'), true);
    assert.strictEqual(shouldWin(caliente, '2026-10-19'), false);
    assert.strictEqual(shouldWin(caliente, null), false);
    // A la medianoche AR (03 h UTC del 21) sigue siendo el 20 en Argentina
    assert.strictEqual(shouldWin({ stage: 'caliente', stage_changed_at: '2026-10-21T02:30:00Z' }, '2026-10-20'), true);
    // Solo desde Caliente
    assert.strictEqual(shouldWin({ ...caliente, stage: 'templado' }, '2026-10-21'), false);
    assert.strictEqual(shouldWin(null, '2026-10-21'), false);
}

function testToTarget() {
    assert.deepStrictEqual(toTarget('cliente', '42'), { tipo: 'cliente', col: 'odoo_partner_id', id: 42 });
    assert.deepStrictEqual(toTarget('lead', 7), { tipo: 'lead', col: 'lead_id', id: 7 });
    assert.throws(() => toTarget('proveedor', 1), FollowupError);
    assert.throws(() => toTarget('cliente', 'abc'), FollowupError);
}

function testEtapas() {
    // Ganado no se elige a mano: lo marca una compra
    assert.strictEqual(MANUAL_STAGES.includes('ganado'), false);
    assert.deepStrictEqual(STAGES, ['frio', 'templado', 'caliente', 'ganado', 'descartado']);
}

testShouldWin();
testToTarget();
function testAccionesYRespuestas() {
    // Nota #80: mensaje de presentación como acción; la respuesta va aparte y no es un contacto
    assert.strictEqual(ACTION_TYPES.includes('presentacion'), true);
    assert.strictEqual(EVENT_KINDS.includes('presentacion'), true);
    assert.deepStrictEqual(RESPONSES, ['respondio', 'no_interesa']);
    assert.strictEqual(EVENT_KINDS.includes('respuesta'), false);
    // Entra en las columnas VARCHAR(20) de crm_actions y crm_events
    assert.ok(ACTION_TYPES.every((k) => k.length <= 20));
}

testEtapas();
testAccionesYRespuestas();
console.log('ok crmFollowup.test.js');
