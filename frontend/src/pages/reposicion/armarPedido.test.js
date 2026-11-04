import assert from 'node:assert/strict';
import {
    destinoDe,
    estaVinculado,
    proveedoresDelPedido,
    filtrarSolapa,
    accesoDe,
    recomendarDePedidos,
} from './pedidoDestino.js';

const alif = { proveedor: 'Alif', proveedor_odoo: 'Alif', precio: 7904, disponible: true, es_principal: true, url: 'https://alifcell.com/e' };
const babu = { proveedor: 'Babu', proveedor_odoo: 'Babu', precio: 5884, disponible: true, es_principal: false, url: 'https://babu.example/e' };

function item(extra) {
    return {
        id: 1,
        vendor_name: 'Alif',
        ofertas: null,
        ...extra,
    };
}

const espejo = item({
    id: 1,
    ofertas: {
        conviene: { proveedor: 'Babu' },
        mas_economico: babu,
        ofertas: [alif, babu],
    },
});

const batidora = item({
    id: 2,
    ofertas: {
        conviene: null,
        mas_economico: { ...alif, precio: 10448 },
        ofertas: [{ ...alif, precio: 10448 }],
    },
});

const suelto = item({ id: 3, vendor_name: 'Alif', ofertas: null });

assert.equal(estaVinculado(espejo), true);
assert.equal(estaVinculado(suelto), false);
assert.equal(destinoDe(espejo), 'Babu');
assert.equal(destinoDe(espejo, 'principal'), 'Alif');
assert.equal(destinoDe(batidora), 'Alif');
assert.equal(destinoDe(suelto), 'Alif');

const grupos = proveedoresDelPedido([espejo, batidora, suelto], {});
assert.equal(grupos.find(g => g.nombre === 'Alif').n, 2);
assert.equal(grupos.find(g => g.nombre === 'Alif').sin, 1);
assert.equal(grupos.find(g => g.nombre === 'Babu').n, 1);

assert.equal(filtrarSolapa([espejo, suelto], 'sin').length, 1);
assert.equal(filtrarSolapa([espejo, suelto], 'vinculados').length, 1);

assert.deepEqual(accesoDe('Alif', [
    { name: 'Alif', odoo_vendor_name: 'Alif', website_url: 'https://alifcell.com', pide_clave: true },
]), { tipo: 'clave', sitio: 'https://alifcell.com' });
assert.equal(accesoDe('Lista', []).tipo, 'pdf');

const rec = recomendarDePedidos([
    {
        name: 'S0001',
        productos: [
            { odoo_id: 9, name: 'Resma', vendor_name: 'Alif', qty: 2, en_cache: true, en_cola: false },
            { odoo_id: 9, name: 'Resma', vendor_name: 'Alif', qty: 1, en_cache: true, en_cola: false },
            { odoo_id: 8, name: 'Ya en cola', vendor_name: 'Alif', qty: 4, en_cache: true, en_cola: true },
            { odoo_id: 7, name: 'Otro', vendor_name: 'Babu', qty: 1, en_cache: true, en_cola: false },
            { odoo_id: 6, name: 'Liquidar', vendor_name: 'Alif', qty: 1, en_cache: true, en_cola: false, es_liquidar: true },
        ],
    },
    { name: 'S0002', productos: [{ odoo_id: 9, name: 'Resma', vendor_name: 'Alif', qty: 3, en_cache: true, en_cola: false }] },
], 'Alif', [3]);

assert.equal(rec.length, 1);
assert.equal(rec[0].odoo_id, 9);
assert.equal(rec[0].qty, 6);
assert.deepEqual(rec[0].pedidos, ['S0001', 'S0002']);

console.log('armarPedido ok');
