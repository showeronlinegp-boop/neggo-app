// Listas de precios en Excel (nota 175). Sin DB ni Odoo.
// node backend/services/listaExcel.test.js
// Los casos salen de la lista real de Pan Lin (Lista20261016.xlsx).

const assert = require('assert');
const XLSX = require('xlsx');
const { leerLista, separarCodigo, numeroChino, asignarCodigos, precio, detectarColumnas } = require('./listaExcel');
const { resolverFilas, resumir } = require('./listaService');

// ─── Código pegado adelante del nombre ──────────────────────────────────────────
assert.deepStrictEqual(separarCodigo('0030TOALLA RAYADA'), { codigo: '0030', nombre: 'TOALLA RAYADA' });
assert.deepStrictEqual(separarCodigo('23001GATO SOLAR'), { codigo: '23001', nombre: 'GATO SOLAR' });
assert.deepStrictEqual(separarCodigo('292POKER EN CAJA'), { codigo: '292', nombre: 'POKER EN CAJA' });
assert.deepStrictEqual(separarCodigo('6691 50PC GLOBO PASTEL'), { codigo: '6691', nombre: '50PC GLOBO PASTEL' });
assert.deepStrictEqual(separarCodigo('1301 1.0COLLAR X12 ROMBO'), { codigo: '1301', nombre: '1.0COLLAR X12 ROMBO' });
// Una medida no es un código
assert.deepStrictEqual(separarCodigo('15CM FAROL PAPEL 6"'), { codigo: null, nombre: '15CM FAROL PAPEL 6"' });
assert.deepStrictEqual(separarCodigo('150CM CORTINA'), { codigo: null, nombre: '150CM CORTINA' });
assert.deepStrictEqual(separarCodigo('100 ML PERFUME'), { codigo: null, nombre: '100 ML PERFUME' });
assert.deepStrictEqual(separarCodigo('VELA CUADRADA'), { codigo: null, nombre: 'VELA CUADRADA' });

assert.strictEqual(numeroChino('小胶带座20051'), '20051');
assert.strictEqual(numeroChino('1.0七彩和闪光猫胸背11261127'), '11261127');
assert.strictEqual(numeroChino('16颗珍珠头圈'), null);

assert.strictEqual(precio(2500), 2500);
assert.strictEqual(precio('2.500,50'), 2500.5);
assert.strictEqual(precio('$ 2.500'), 2500);
assert.strictEqual(precio(0), null);
assert.strictEqual(precio(''), null);

// ─── Códigos únicos ─────────────────────────────────────────────────────────────
{
    const cods = asignarCodigos([
        { codigo: '0030', zh: 'toalla920611', nombre: 'TOALLA' },
        { codigo: '0256', zh: '3301带USB插电板900256', nombre: 'ALARGUE USB 3301' }, // 0256 repetido
        { codigo: '0256', zh: 'otro900257', nombre: 'ALARGUE USB' },
        { codigo: null, zh: '16颗珍珠头圈', nombre: 'COLITA 16PERLA' },
        { codigo: null, zh: '16颗珍珠头圈', nombre: 'COLITA 16PERLA' }, // fila repetida idéntica
    ]);
    assert.strictEqual(cods[0], '0030');
    assert.strictEqual(cods[1], 'CH900256');
    assert.strictEqual(cods[2], 'CH900257');
    assert.match(cods[3], /^N[0-9A-F]{8}$/);
    assert.strictEqual(cods[4], `${cods[3]}2`);
    assert.strictEqual(new Set(cods).size, cods.length);
}

// ─── Encabezados ────────────────────────────────────────────────────────────────
{
    const det = detectarColumnas([
        ['PASTEURSOL   LISTA DE PRECIO', null, null, null, null],
        ['Nombre Chino', 'Nombre De Producto', 'Precios', 'FOTOS', 'CLASES'],
    ]);
    assert.deepStrictEqual(det, { filaEncabezado: 1, columnas: { zh: 0, nombre: 1, precio: 2, categoria: 4 } });
    assert.strictEqual(detectarColumnas([['a', 'b'], ['c', 'd']]), null);
}

// ─── Lectura de un Excel como el de Pan Lin ─────────────────────────────────────
{
    const ws = XLSX.utils.aoa_to_sheet([
        ['PASTEURSOL                LISTA DE PRECIO', null, null, null, null],
        ['Nombre Chino', 'Nombre De Producto', 'Precios', 'FOTOS', 'CLASES'],
        ['玉米粒包边毛巾B-22 920611', '0030TOALLA RAYADA', 2500, 'x', 'BAZAR'],
        ['小四方蜡烛灯9004101', 'VELA CUADRADA', 1320, 'x', 'Sin Foto'],
        ['sin precio', 'ALGO', null, null, 'BAZAR'],
        [1684, null, 627501330, 1684, 'Sin Foto'], // fila de totales
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'hoja');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const { filas, salteadas } = leerLista(buf);
    assert.strictEqual(filas.length, 2);
    assert.deepStrictEqual(
        filas.map(f => [f.codigo, f.nombre, f.precio, f.categoria, f.codigo_proveedor, f.fila]),
        [['0030', 'TOALLA RAYADA', 2500, 'BAZAR', '0030', 3], ['CH9004101', 'VELA CUADRADA', 1320, null, null, 4]]
    );
    assert.strictEqual(salteadas.length, 2);
    assert.throws(() => leerLista(Buffer.from('no es un excel')), /No (se pudo leer|encontré)/);
}

// ─── Reconocer cada fila contra lo ya cargado ───────────────────────────────────
{
    const existentes = [
        { id: 1, sku: 'PREPL0030', name: 'TOALLA RAYADA', name_key: 'TOALLARAYADA', raw_price: '2500', image_url: '/storage/photos/panlin/prepl0030.jpg', available: true },
        // Cargado con otro código (hash viejo): se reconoce por nombre y conserva su SKU
        { id: 2, sku: 'PREPLN00BAD38E', name: 'FIBRA COLOR', name_key: 'FIBRACOLOR', raw_price: '1000', image_url: '/storage/photos/panlin/prepln00bad38e.jpg', available: true },
        // Dos con el mismo nombre: gana la del mismo precio
        { id: 3, sku: 'PREPLNAAAA0001', name: 'ABROCHADORA', name_key: 'ABROCHADORA', raw_price: '900', image_url: null, available: true },
        { id: 4, sku: 'PREPLNAAAA0002', name: 'ABROCHADORA', name_key: 'ABROCHADORA', raw_price: '1500', image_url: null, available: true },
        // No viene en la lista nueva
        { id: 5, sku: 'PREPL0999', name: 'YA NO ESTA', name_key: 'YANOESTA', raw_price: '100', image_url: null, available: true },
        // Estaba archivado y vuelve
        { id: 6, sku: 'PREPL0777', name: 'VUELVE', name_key: 'VUELVE', raw_price: '300', image_url: null, available: false },
    ];
    const filas = [
        { codigo: '0030', nombre: 'TOALLA RAYADA', precio: 2700, foto: null },
        { codigo: 'NFFFF0000', nombre: 'FIBRA COLOR', precio: 1000, foto: null },
        { codigo: 'NFFFF0001', nombre: 'ABROCHADORA', precio: 1500, foto: null },
        { codigo: '0777', nombre: 'VUELVE', precio: 300, foto: null },
        { codigo: '1234', nombre: 'NUEVO', precio: 50, foto: { buffer: Buffer.from('x'), ext: 'jpeg' } },
    ];
    const r = resolverFilas(filas, existentes, 'PL');
    assert.deepStrictEqual(r.map(x => [x.sku, x.existente?.id ?? null]), [
        ['PREPL0030', 1],
        ['PREPLN00BAD38E', 2],
        ['PREPLNAAAA0002', 4],
        ['PREPL0777', 6],
        ['PREPL1234', null],
    ]);
    const s = resumir(r, existentes);
    assert.strictEqual(s.nuevos, 1);
    assert.strictEqual(s.suben, 1);
    assert.strictEqual(s.iguales, 3);
    assert.strictEqual(s.reaparecen, 1);
    // La ABROCHADORA de $900 y YA NO ESTA no vinieron
    assert.strictEqual(s.se_archivan, 2);
    assert.strictEqual(s.con_foto, 3);
    assert.strictEqual(s.sin_foto, 2);

    // Un código nuevo que choca con un SKU ya tomado por nombre no lo pisa
    const r2 = resolverFilas(
        [{ codigo: 'X', nombre: 'OTRO', precio: 1 }, { codigo: 'N00BAD38E', nombre: 'DISTINTO', precio: 2 }],
        [{ id: 9, sku: 'PREPLX', name: 'OTRO', name_key: 'OTRO', raw_price: '1', available: true },
         { id: 10, sku: 'PREPLN00BAD38E', name: 'FIBRA', name_key: 'FIBRA', raw_price: '5', available: true }],
        'PL'
    );
    // El SKU PREPLN00BAD38E existe (otra oferta, "FIBRA"): mismo SKU = mismo producto, se actualiza
    assert.deepStrictEqual(r2.map(x => [x.sku, x.existente?.id]), [['PREPLX', 9], ['PREPLN00BAD38E', 10]]);
}

console.log('✅ listaExcel: todo OK');
