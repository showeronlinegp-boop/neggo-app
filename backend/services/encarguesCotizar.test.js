// Pruebas de la validación de encargues a cotizar (nota 248): node services/encarguesCotizar.test.js
const assert = require('assert');
const { contacto, validarAlta, validarEdicion, validarEstado } = require('./encarguesCotizar');

assert.deepStrictEqual(contacto('cliente', '12'), { tipo: 'cliente', id: 12 });
assert.strictEqual(contacto('lead', 12), null);
assert.strictEqual(contacto('prospecto', 0), null);

assert.strictEqual(validarAlta({ texto: '   ' }).error, 'Escribí qué te pidieron');
assert.deepStrictEqual(validarAlta({ texto: ' Termo  Stanley 1L ', cantidad: '6', nota: '' }).value,
    { texto: 'Termo Stanley 1L', cantidad: 6, nota: null, contacto_nombre: null });
assert.strictEqual(validarAlta({ texto: 'x', cantidad: '2,5' }).value.cantidad, 2.5);
assert.ok(validarAlta({ texto: 'x', cantidad: 'muchos' }).error);
assert.ok(validarAlta({ texto: 'x', cantidad: 0 }).error);
assert.strictEqual(validarAlta({ texto: 'x', cantidad: '' }).value.cantidad, null);

assert.ok(validarEdicion({}).error);
assert.deepStrictEqual(validarEdicion({ cantidad: null }).value, { cantidad: null });

assert.ok(validarEstado('pendiente', { estado: 'avisado' }).error, 'no se avisa sin cotizar');
assert.strictEqual(validarEstado('pendiente', { estado: 'cotizado' }).error, 'Cargá el precio que te pasaron');
assert.deepStrictEqual(validarEstado('pendiente', { estado: 'cotizado', precio: '1500,50', proveedor: ' ZLE ' }).value,
    { estado: 'cotizado', precio: 1500.5, proveedor: 'ZLE' });
assert.deepStrictEqual(validarEstado('cotizado', { estado: 'avisado' }).value, { estado: 'avisado' });
assert.deepStrictEqual(validarEstado('no_se_consigue', { estado: 'pendiente' }).value, { estado: 'pendiente' });
assert.ok(validarEstado('pendiente', { estado: 'otro' }).error);

console.log('✅ encarguesCotizar: todas las pruebas pasaron');
