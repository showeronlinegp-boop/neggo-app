// Condiciones de compra del proveedor: validación.
// Sin base de datos. node backend/services/supplierCondiciones.test.js

const assert = require('assert');
const { normalizarCondiciones } = require('./supplierCondiciones');

function testCompletas() {
    const { valores, error } = normalizarCondiciones({
        odoo_vendor_name: '  Parnassa ', pedido_minimo: '150000', flete_pct: '2,5',
        demora_dias: 3, acepta_auto: true, condiciones_nota: ' Transferencia; pedido por WhatsApp ',
    });
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(valores, {
        odoo_vendor_name: 'Parnassa', pedido_minimo: 150000, flete_pct: 2.5,
        demora_dias: 3, acepta_auto: true, condiciones_nota: 'Transferencia; pedido por WhatsApp',
    });
}

function testVaciasBorran() {
    const { valores } = normalizarCondiciones({
        odoo_vendor_name: '', pedido_minimo: '', flete_pct: null, demora_dias: undefined, condiciones_nota: '   ',
    });
    assert.deepStrictEqual(valores, {
        odoo_vendor_name: null, pedido_minimo: null, flete_pct: null,
        demora_dias: null, acepta_auto: false, condiciones_nota: null,
    });
}

function testErrores() {
    assert.match(normalizarCondiciones({ pedido_minimo: -1 }).error, /pedido mínimo/);
    assert.match(normalizarCondiciones({ pedido_minimo: 'mucho' }).error, /pedido mínimo/);
    assert.match(normalizarCondiciones({ flete_pct: 120 }).error, /flete/);
    assert.match(normalizarCondiciones({ demora_dias: 2.5 }).error, /demora/);
    assert.match(normalizarCondiciones({ demora_dias: 400 }).error, /demora/);
    assert.match(normalizarCondiciones({ odoo_vendor_name: 'x'.repeat(201) }).error, /Odoo/);
    assert.match(normalizarCondiciones(null).error, /objeto/);
    // "true" como texto no prende el envío automático
    assert.strictEqual(normalizarCondiciones({ acepta_auto: 'true' }).valores.acepta_auto, false);
}

testCompletas();
testVaciasBorran();
testErrores();
console.log('✅ supplierCondiciones: todos los casos pasan');
process.exit(0);
