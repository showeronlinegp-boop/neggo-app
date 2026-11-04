// node frontend/src/pages/reposicion/cotizacionesNeggo.test.js
import assert from 'node:assert/strict';
import {
    esperasPorProducto,
    clienteCorto,
    textoEspera,
    reponiblesDe,
    cotizacionesCompletas,
    resumenBloque,
} from './cotizacionesNeggo.js';

const llego = { ingreso_id: 9, comprobante: 'A-9', at: '2026-10-20T10:00:00Z' };

const data = {
    cotizaciones: [
        { name: 'S1', company: 'neggo', n_llegados: 0, productos: [{ odoo_id: 1 }, { odoo_id: 2 }] },
        { name: 'S2', company: 'neggo', n_llegados: 1, productos: [{ odoo_id: 3 }] },
        { name: 'S3', company: 'preventas', n_llegados: 0, productos: [{ odoo_id: 1 }] },
    ],
    productos: [
        { odoo_id: 1, company: 'neggo', vendor_name: 'ZLE', puede_reponer: true, estado_cola: null,
            cotizaciones: [{ name: 'S1', partner_name: 'Soledad Linares', qty: 2 }, { name: 'S4', partner_name: 'Pablo', qty: 1 }] },
        { odoo_id: 2, company: 'neggo', vendor_name: 'Chuang Yi', puede_reponer: false, estado_cola: 'pendiente',
            cotizaciones: [{ name: 'S1', partner_name: 'Soledad Linares', qty: 1 }] },
        { odoo_id: 3, company: 'neggo', vendor_name: 'zle', puede_reponer: false, estado_cola: null, llego,
            cotizaciones: [{ name: 'S2', partner_name: 'Ana', qty: 1, llego }] },
        { odoo_id: 1, company: 'preventas', vendor_name: 'ZLE', puede_reponer: false,
            cotizaciones: [{ name: 'S3', partner_name: 'X', qty: 5 }] },
    ],
};

// Esperas: solo Neggo y sin lo que ya llegó
const esperas = esperasPorProducto(data);
assert.equal(esperas.size, 2);
assert.equal(esperas.get(1).length, 2);
assert.equal(esperas.has(3), false, 'lo que llegó no espera');

assert.equal(clienteCorto('Soledad Linares'), 'Soledad L.');
assert.equal(clienteCorto('SHOWER, Yanina Lizzi'), 'Yanina L.', 'saca el prefijo antes de la coma');
assert.equal(clienteCorto('Pablo'), 'Pablo');
assert.equal(clienteCorto(null), '');

assert.equal(textoEspera(esperas.get(1)), 'Para S1 · Soledad L. × 2 +1');
assert.equal(textoEspera(esperas.get(2)), 'Para S1 · Soledad L. × 1');
assert.equal(textoEspera([]), '');

assert.deepEqual(reponiblesDe(data, 'zle').map(p => p.odoo_id), [1], 'por proveedor sin mayúsculas');
assert.deepEqual(reponiblesDe(data).map(p => p.odoo_id), [1]);
assert.deepEqual(reponiblesDe(data, 'Chuang Yi'), []);

assert.deepEqual(cotizacionesCompletas(data).map(c => c.name), ['S2']);

const r = resumenBloque(data);
assert.equal(r.cotizaciones, 2, 'Preventas no cuenta');
assert.equal(r.productos, 3);
assert.equal(r.sinPedir, 1);
assert.equal(r.enCola, 1);
assert.equal(r.llegaron, 1);
assert.equal(r.completas, 1);
assert.deepEqual(r.proveedores, [{ nombre: 'ZLE', n: 1 }]);
assert.equal(r.otrosProveedores, 0);

console.log('✅ cotizacionesNeggo: ok');
