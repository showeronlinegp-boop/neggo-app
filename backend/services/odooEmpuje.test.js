// Sumar líneas al Recolectar sin entrega abierta (nota 174). Sin red ni Postgres.
// node backend/services/odooEmpuje.test.js

const assert = require('assert');
const { empujaAlValidar } = require('./odooService');

const recolectar = { location_dest_id: [11, 'WH/Salida'] };

// Caso S03119: el move del Recolectar va a Salida con destino final Clientes → Odoo arma la entrega al validar
assert.strictEqual(empujaAlValidar({ location_final_id: [5, 'Partners/Customers'], location_dest_id: [11, 'WH/Salida'] }, recolectar), true);

// Sin destino final: no hay a dónde empujar, sigue el error
assert.strictEqual(empujaAlValidar({ location_final_id: false, location_dest_id: [11, 'WH/Salida'] }, recolectar), false);

// Destino final igual a la salida del envío: tampoco
assert.strictEqual(empujaAlValidar({ location_final_id: [11, 'WH/Salida'] }, recolectar), false);

// Sin picking leído, usa la salida del molde
assert.strictEqual(empujaAlValidar({ location_final_id: [5, 'C'], location_dest_id: [11, 'S'] }, null), true);

console.log('✅ odooEmpuje: 4 casos ok');
