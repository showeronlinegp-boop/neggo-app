// Comparar compras: motivo de "Se vende y no tiene oferta". Sin base ni Odoo.
// node backend/services/compararCompras.test.js

const assert = require('assert');
const { motivoSinOferta } = require('./compararComprasService');

function testMotivo() {
    const base = { con_no_disponible: false, sugeridos: 0, vendor_name: 'Impotekno', proveedor_con_web: true };
    // Tiene oferta confirmada pero no disponible: es lo primero que se mira
    assert.strictEqual(motivoSinOferta({ ...base, con_no_disponible: true, sugeridos: 2 }), 'no_disponible');
    // Sugeridas pendientes en Vincular
    assert.strictEqual(motivoSinOferta({ ...base, sugeridos: 3 }), 'sugerido');
    assert.strictEqual(motivoSinOferta({ ...base, sugeridos: '1' }), 'sugerido');
    // El principal tiene web pero no se encontró la oferta
    assert.strictEqual(motivoSinOferta(base), 'no_encontrada');
    // El principal no tiene web (Chuang Yi, Pan Lin...) o no hay principal
    assert.strictEqual(motivoSinOferta({ ...base, vendor_name: 'Pan Lin', proveedor_con_web: false }), 'proveedor_sin_web');
    assert.strictEqual(motivoSinOferta({ ...base, vendor_name: null, proveedor_con_web: null }), 'sin_proveedor');
}

const tests = [testMotivo];
for (const t of tests) t();
console.log(`✅ compararCompras: ${tests.length} tests OK`);
