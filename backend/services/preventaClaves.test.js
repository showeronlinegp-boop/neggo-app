// Cruce de la pestaña Preventa: claves de código y órdenes de venta sin factura.
// Sin base ni Odoo. node backend/services/preventaClaves.test.js

const assert = require('assert');
const { normClave, clavesPreventa } = require('./preventaClaves');
const { ordenSinFacturaNiPos, lineaOrdenPendiente } = require('./odooService');

// ZLE repite la sigla en el código
assert.deepStrictEqual(clavesPreventa('ZLE-BCA-32-01', 'ZL'), {
    conPrefijo: ['PREZLZLEBCA3201', 'PREZLBCA3201'],
    sinPrefijo: ['PREZLEBCA3201'],
});

// Códigos con espacios, # y / llegan a la misma forma que la referencia
assert.ok(clavesPreventa('ZLE-LPG-02-01 CA', 'ZL').conPrefijo.includes('PREZLLPG0201CA'));
assert.ok(clavesPreventa('ZLS-LPG-859-8 BL', 'ZL').conPrefijo.includes('PREZLZLSLPG8598BL'));
assert.ok(clavesPreventa('A024# / GMC-19 RJ', 'ZL').conPrefijo.includes('PREZLA024GMC19RJ'));

// Otro proveedor no pierde la sigla: CT-17 de Cast nunca se vuelve "17"
assert.deepStrictEqual(clavesPreventa('CT-17', 'CT'), {
    conPrefijo: ['PRECTCT17'],
    sinPrefijo: ['PRECT17'],
});

// ZLE no se recorta en otro proveedor, ni los prefijos del scraper dejan de sacarse
assert.deepStrictEqual(clavesPreventa('ZLE-BCA', 'IT').conPrefijo, ['PREITZLEBCA']);
assert.deepStrictEqual(clavesPreventa('imptk-INF-1093', 'IT').conPrefijo, ['PREITINF1093']);

// Código vacío o de un solo carácter: sin claves
assert.deepStrictEqual(clavesPreventa('', 'ZL'), { conPrefijo: [], sinPrefijo: [] });
assert.deepStrictEqual(clavesPreventa('#1', 'ZL'), { conPrefijo: [], sinPrefijo: [] });
assert.strictEqual(normClave('a-1 /#b'), 'A1B');

// Orden sin factura: se descarta si tiene factura, aunque sea parcial, o pasó por el POS
assert.strictEqual(ordenSinFacturaNiPos({ invoice_status: 'to invoice', invoice_count: 0, invoice_ids: [] }), true);
assert.strictEqual(ordenSinFacturaNiPos({ invoice_status: 'invoiced', invoice_count: 0 }), false);
assert.strictEqual(ordenSinFacturaNiPos({ invoice_status: 'to invoice', invoice_count: 1 }), false);
assert.strictEqual(ordenSinFacturaNiPos({ invoice_status: 'to invoice', invoice_ids: [9] }), false);
assert.strictEqual(ordenSinFacturaNiPos({ invoice_status: 'to invoice', pos_order_count: 1 }), false);

// Línea: solo cuenta lo que falta entregar
const linea = (extra) => ({
    id: 1, product_id: [5, 'Cutter'], product_uom_qty: 4, qty_delivered: 0,
    price_unit: 100, price_subtotal: 400, ...extra,
});
assert.strictEqual(lineaOrdenPendiente(linea(), {}).quantity, 4);
const parcial = lineaOrdenPendiente(linea({ qty_delivered: 3 }), {});
assert.strictEqual(parcial.quantity, 1);
assert.strictEqual(parcial.subtotal, 100);
assert.strictEqual(lineaOrdenPendiente(linea({ qty_delivered: 4 }), {}), null);
assert.strictEqual(lineaOrdenPendiente(linea({ product_uom_qty: 0, price_subtotal: 0 }), {}), null);
assert.strictEqual(lineaOrdenPendiente(linea({ product_id: false }), {}), null);

console.log('✅ preventaClaves.test.js');
process.exit(0);
