import assert from 'node:assert/strict';
import {
    destinoDe,
    estaVinculado,
    proveedoresDelPedido,
    filtrarSolapa,
    accesoDe,
    listaDelProveedor,
    listasParaPdf,
    coincideBusqueda,
    coincidenciasPorProveedor,
} from './pedidoDestino.js';
import { nombreEnZip } from './pedidoPdf.js';

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
assert.equal(destinoDe(espejo, [{ destino: 'Alif', qty: null }]), 'Alif');
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

// PDF de las listas (nota 161)
const conOferta = item({ id: 1, name: 'Zapatilla', ofertas: { conviene: { proveedor: 'Babu' }, mas_economico: babu, ofertas: [alif, babu] } });
const aLaAlif = item({ id: 2, name: 'Agenda' });
const otraAlif = item({ id: 3, name: 'Birome' });
const enCero = item({ id: 4, name: 'Cuaderno', vendor_name: 'Cero' });
const paraPdf = [conOferta, aLaAlif, otraAlif, enCero];
const qtysPdf = { 1: 5, 2: 2, 3: '3', 4: 0 };

assert.deepEqual(listaDelProveedor(paraPdf, 'Alif', {}, qtysPdf).map(i => [i.name, i.qty]), [['Agenda', 2], ['Birome', 3]]);
// Si se manda al principal, sale en la lista del principal y no en la del más barato
assert.deepEqual(listaDelProveedor(paraPdf, 'Alif', { 1: [{ destino: 'Alif', qty: null }] }, qtysPdf).map(i => i.name), ['Agenda', 'Birome', 'Zapatilla']);
assert.deepEqual(listaDelProveedor(paraPdf, 'Babu', { 1: [{ destino: 'Alif', qty: null }] }, qtysPdf), []);
// Cantidad vacía o sin cargar: no entra
assert.deepEqual(listaDelProveedor([aLaAlif, otraAlif], 'Alif', {}, { 2: '' }), []);

assert.deepEqual(listasParaPdf(paraPdf, {}, qtysPdf).map(l => [l.proveedor, l.items.length]), [['Alif', 2], ['Babu', 1]]);

const usados = new Set();
assert.equal(nombreEnZip('Alif', usados), 'Alif.pdf');
assert.equal(nombreEnZip('ALIF', usados), 'ALIF (2).pdf');
assert.equal(nombreEnZip('A/B: Ñandú', usados), 'A-B- Ñandú.pdf');

// Buscador (nota 188): sin acentos, por palabras, en nombre, código o código de barras
const mate = { id: 9, name: 'Mate Camionero Algarrobo', internal_ref: 'MT-120', barcode: '7790001' };
assert.equal(coincideBusqueda(mate, ''), true);
assert.equal(coincideBusqueda(mate, 'CAMIONERO mate'), true);
assert.equal(coincideBusqueda(mate, 'mt-120'), true);
assert.equal(coincideBusqueda(mate, '7790001'), true);
assert.equal(coincideBusqueda(mate, 'mate termo'), false);
assert.equal(coincideBusqueda({ name: 'Cámara Wifi' }, 'camara'), true);
assert.equal(coincideBusqueda({ name: 'Camara Wifi' }, 'cámara'), true);
assert.deepEqual([...coincidenciasPorProveedor(paraPdf, 'zapatilla')], [['Babu', 1]]);
assert.deepEqual([...coincidenciasPorProveedor(paraPdf, 'zapatilla', { 1: [{ destino: 'Alif', qty: null }] })], [['Alif', 1]]);
// Repartido: cuenta en cada proveedor al que va
assert.deepEqual(
    [...coincidenciasPorProveedor(paraPdf, 'zapatilla', { 1: [{ destino: 'Alif', qty: 1 }, { destino: 'Babu', qty: 2 }] })],
    [['Alif', 1], ['Babu', 1]]
);
assert.deepEqual([...coincidenciasPorProveedor(paraPdf, 'no existe')], []);

console.log('armarPedido ok');

// Nota 187: elegir cualquier proveedor vinculado y repartir la cantidad
import { candidatosDe, armarReparto, qtyEn, estaRepartido } from './pedidoDestino.js';
const caro = { proveedor: 'Caro', proveedor_odoo: 'Caro', precio: 9000, disponible: false, es_principal: false, url: 'https://caro.example/e' };
const tres = item({ id: 5, name: 'Joystick', ofertas: { conviene: { proveedor: 'Babu' }, mas_economico: babu, ofertas: [babu, alif, caro] } });
const cands = candidatosDe(tres);
assert.deepEqual(cands.map(c => [c.nombre, c.precio, c.disponible, c.es_principal, c.mas_barato]), [
    ['Alif', 7904, true, true, false],
    ['Babu', 5884, true, false, true],
    ['Caro', 9000, false, false, false],
]);
// Sin ofertas: solo el principal, con el costo de Odoo
assert.deepEqual(candidatosDe(item({ id: 6, standard_price: 100 })).map(c => [c.nombre, c.precio]), [['Alif', 100]]);
// Mandarlo entero a uno que no es el más barato
assert.equal(destinoDe(tres, [{ destino: 'Caro', qty: null }]), 'Caro');
assert.equal(qtyEn(tres, 'Caro', [{ destino: 'Caro', qty: null }], 4), 4);
// Repartir: sale en las dos listas con su parte
const rep = armarReparto({ Alif: '3', Babu: 2, Caro: '' });
assert.deepEqual(rep, { asignacion: [{ destino: 'Alif', qty: 3 }, { destino: 'Babu', qty: 2 }], total: 5 });
assert.equal(estaRepartido(rep.asignacion), true);
const asigRep = { 5: rep.asignacion };
assert.deepEqual(listaDelProveedor([tres], 'Alif', asigRep, { 5: 5 }).map(i => i.qty), [3]);
assert.deepEqual(listaDelProveedor([tres], 'Babu', asigRep, { 5: 5 }).map(i => i.qty), [2]);
const gRep = proveedoresDelPedido([tres], asigRep);
assert.equal(gRep.find(g => g.nombre === 'Alif').n, 1);
assert.equal(gRep.find(g => g.nombre === 'Babu').n, 1);
// Uno solo con cantidad: va todo ahí; todo en cero: nada
assert.deepEqual(armarReparto({ Alif: 0, Babu: '4' }), { asignacion: [{ destino: 'Babu', qty: null }], total: 4 });
assert.equal(armarReparto({ Alif: '', Babu: 0 }), null);

console.log('armarPedido nota 187 ok');

// Link al producto (nota 192): sin oferta de este proveedor no se hace pasar por el producto
import { linkDelProducto } from './pedidoDestino.js';
const conClave = { tipo: 'clave', sitio: 'https://alifcell.com/catalogo2022x3.php' };
const alProd = linkDelProducto({ url: 'https://alifcell.com/catalogo2022x3.php?rub=99999#96429' }, conClave, 'Alif');
assert.equal(alProd.href, 'https://alifcell.com/catalogo2022x3.php?rub=99999#96429');
assert.equal(alProd.alProducto, true);
assert.equal(alProd.texto, 'Abrir producto (pide clave)');
const soloWeb = linkDelProducto({ url: null }, conClave, 'Alif');
assert.equal(soloWeb.href, conClave.sitio);
assert.equal(soloWeb.alProducto, false);
assert.equal(soloWeb.texto, 'Solo la web (pide clave)');
assert.equal(linkDelProducto(null, { tipo: 'abierta', sitio: 'https://x.com' }, 'X').texto, 'Solo la web');
assert.equal(linkDelProducto({ url: 'https://x.com/p' }, { tipo: 'abierta', sitio: 'https://x.com' }, 'X').texto, 'Ver en el catálogo');
assert.equal(linkDelProducto({ url: 'https://f.com/p' }, { tipo: 'pdf', sitio: null }, 'F').texto, 'Abrir ficha');
assert.equal(linkDelProducto(null, { tipo: 'pdf', sitio: null }, 'F'), null);
console.log('armarPedido nota 192 ok');

// Nota 218: el principal no tiene oferta vinculada → va de entrada a uno que sí la tenga
const caroDisp = { ...caro, disponible: true, precio: 9500 };
const sinPrincipal = item({ id: 7, standard_price: 5000, ofertas: { conviene: null, mas_economico: null, ofertas: [caroDisp] } });
assert.equal(destinoDe(sinPrincipal), 'Caro');
const candsSin = candidatosDe(sinPrincipal);
assert.deepEqual(candsSin.map(c => [c.nombre, c.precio, c.sin_oferta]), [['Alif', 5000, true], ['Caro', 9500, false]]);
// Sale en la lista de Caro y el principal queda como pestaña para mandarlo de vuelta
assert.deepEqual(proveedoresDelPedido([sinPrincipal]).map(g => [g.nombre, g.n]), [['Caro', 1], ['Alif', 0]]);
// Si se elige el principal a mano, se respeta
assert.equal(destinoDe(sinPrincipal, [{ destino: 'Alif', qty: null }]), 'Alif');
// Con oferta del principal, nada cambia
assert.equal(destinoDe(item({ id: 8, ofertas: { conviene: null, mas_economico: null, ofertas: [alif, caroDisp] } })), 'Alif');
assert.equal(candidatosDe(item({ id: 8, ofertas: { ofertas: [alif, caroDisp] } }))[0].sin_oferta, false);
// Sin ninguna oferta: sigue en el principal y no dice «sin oferta vinculada»
assert.equal(destinoDe(item({ id: 9 })), 'Alif');
assert.equal(candidatosDe(item({ id: 9 }))[0].sin_oferta, false);
console.log('armarPedido nota 218 ok');
