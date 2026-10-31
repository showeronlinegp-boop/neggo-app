// Tarjetas por nombre (nota 139): elegir una oferta descarta solo las de su proveedor.
// Sin base de datos. node backend/services/vincularTarjetas.test.js

const assert = require('assert');
const { repartoTarjeta } = require('./vincularService');

const sugeridos = [
    { id: 1, supplier_id: 10 },
    { id: 2, supplier_id: 10 },
    { id: 3, supplier_id: 20 },
    { id: 4, supplier_id: 30 },
];

// Elegida la 1: se rechaza la otra de su proveedor y quedan las de los otros
assert.deepStrictEqual(repartoTarjeta(sugeridos, 1), { rechazar: [2], quedan: [3, 4] });
// Elegida la única de su proveedor: no se rechaza nada
assert.deepStrictEqual(repartoTarjeta(sugeridos, 3), { rechazar: [], quedan: [1, 2, 4] });
// Ninguna: se rechazan todas
assert.deepStrictEqual(repartoTarjeta(sugeridos, null), { rechazar: [1, 2, 3, 4], quedan: [] });
// Un solo proveedor: como antes, la tarjeta se cierra
assert.deepStrictEqual(repartoTarjeta(sugeridos.slice(0, 2), 2), { rechazar: [1], quedan: [] });

console.log('✅ vincularTarjetas: todos los casos pasan');
process.exit(0);
