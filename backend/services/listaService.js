// Listas de precios en Excel como fuente de un proveedor (nota 175).
// Cargar una lista = hacer un scrapeo: se reconoce cada fila contra lo que ya estaba cargado
// (mismo código → mismo producto; si no, mismo nombre), lo nuevo se crea y lo que no vino
// queda "no disponible" (no se borra). La lista vale hasta que llegue la próxima.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { leerLista, claveNombre } = require('./listaExcel');
const { storageRoot } = require('./fotoStorage');

// scraper_key de los proveedores cuya fuente es una lista en Excel
const LISTA_KEY = 'lista_excel';

const esLista = supplier => supplier?.scraper_key === LISTA_KEY;

// =============================================
// Archivos
// =============================================

function carpetaListas(supplierId) {
    return path.join(storageRoot(), 'listas', String(Number(supplierId)));
}

// Carpeta de fotos del proveedor: "Pan Lin" → photos/panlin (la misma de la carga del 2/11)
function carpetaFotos(supplier) {
    const slug = String(supplier.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '') || `proveedor${supplier.id}`;
    return slug;
}

/** Ruta en disco de la lista vigente del proveedor (scrape_config.lista.archivo), o null */
function rutaListaVigente(supplier) {
    const archivo = supplier?.scrape_config?.lista?.archivo;
    if (!archivo) return null;
    const ruta = path.resolve(storageRoot(), archivo);
    const base = path.resolve(storageRoot(), 'listas');
    return ruta.startsWith(base + path.sep) ? ruta : null;
}

/** Guarda una lista subida como pendiente de confirmar (pisa la pendiente anterior) */
async function guardarPendiente(supplierId, buffer) {
    const dir = carpetaListas(supplierId);
    await fs.promises.mkdir(dir, { recursive: true });
    const ruta = path.join(dir, 'pendiente.xlsx');
    await fs.promises.writeFile(ruta, buffer);
    return ruta;
}

/** Pasa la pendiente a vigente con nombre fechado. Devuelve la ruta relativa a storage */
async function confirmarPendiente(supplierId) {
    const dir = carpetaListas(supplierId);
    const pendiente = path.join(dir, 'pendiente.xlsx');
    const sello = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const destino = path.join(dir, `lista-${sello}.xlsx`);
    await fs.promises.rename(pendiente, destino);
    return path.relative(storageRoot(), destino).split(path.sep).join('/');
}

async function leerPendiente(supplierId) {
    try {
        return await fs.promises.readFile(path.join(carpetaListas(supplierId), 'pendiente.xlsx'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

// =============================================
// Reconocer cada fila
// =============================================

async function cargarExistentes(db, supplierId) {
    const { rows } = await db.query(
        `SELECT id, sku, name, name_key, raw_price, image_url, available
         FROM supplier_products
         WHERE supplier_id = $1 AND source = 'web'
         ORDER BY id`,
        [supplierId]
    );
    return rows;
}

/**
 * Une cada fila de la lista con la oferta que ya existía (o ninguna = nueva).
 *   1. mismo SKU (PRE + prefijo + código)
 *   2. mismo nombre entre las que quedaron libres; si hay varias con ese nombre, la del mismo precio
 * Una oferta existente se usa una sola vez.
 * @param {Array} filas — de leerLista
 * @param {Array} existentes — de cargarExistentes
 * @param {string} prefix — prefijo del proveedor
 * @returns {Array<fila & { sku, existente }>}
 */
function resolverFilas(filas, existentes, prefix) {
    const pre = `PRE${String(prefix || '').toUpperCase()}`;
    const porSku = new Map(existentes.map(e => [e.sku, e]));
    const usadas = new Set();
    const res = filas.map(f => {
        const sku = `${pre}${f.codigo}`;
        const e = porSku.get(sku);
        if (e) { usadas.add(e.id); return { ...f, sku, existente: e }; }
        return { ...f, sku, existente: null };
    });

    const porNombre = new Map();
    for (const e of existentes) {
        if (usadas.has(e.id)) continue;
        const k = e.name_key || claveNombre(e.name);
        if (!porNombre.has(k)) porNombre.set(k, []);
        porNombre.get(k).push(e);
    }
    for (const r of res) {
        if (r.existente) continue;
        const libres = (porNombre.get(claveNombre(r.nombre)) || []).filter(e => !usadas.has(e.id));
        if (libres.length === 0) continue;
        const elegida = libres.find(e => Number(e.raw_price) === r.precio) || libres[0];
        usadas.add(elegida.id);
        // Conserva el SKU que ya tenía: así siguen sus vínculos, su foto y su producto de Preventas
        r.existente = elegida;
        r.sku = elegida.sku;
    }

    // Dos filas no pueden terminar con el mismo SKU (una nueva cuyo código ya lo tomó otra por nombre)
    const vistos = new Set(res.filter(r => r.existente).map(r => r.sku));
    for (const r of res) {
        if (r.existente) continue;
        let sku = r.sku;
        for (let i = 2; vistos.has(sku) || porSku.has(sku); i++) sku = `${r.sku}V${i}`;
        r.sku = sku;
        vistos.add(sku);
    }
    return res;
}

/**
 * Qué va a pasar si se carga la lista.
 * @returns {{ filas, nuevos, iguales, suben, bajan, reaparecen, se_archivan, con_foto, sin_foto,
 *            salteadas, ejemplos }}
 */
function resumir(resueltas, existentes, salteadas = []) {
    const usadas = new Set(resueltas.filter(r => r.existente).map(r => r.existente.id));
    const archivan = existentes.filter(e => e.available && !usadas.has(e.id));
    const cuenta = { nuevos: 0, iguales: 0, suben: 0, bajan: 0, reaparecen: 0 };
    const ejemplos = { nuevos: [], suben: [], bajan: [], se_archivan: [] };
    const ej = (k, v) => { if (ejemplos[k].length < 8) ejemplos[k].push(v); };
    for (const r of resueltas) {
        const e = r.existente;
        if (!e) { cuenta.nuevos++; ej('nuevos', { nombre: r.nombre, precio: r.precio }); continue; }
        if (!e.available) cuenta.reaparecen++;
        const antes = Number(e.raw_price);
        if (!antes || antes === r.precio) cuenta.iguales++;
        else if (r.precio > antes) { cuenta.suben++; ej('suben', { nombre: r.nombre, antes, ahora: r.precio }); }
        else { cuenta.bajan++; ej('bajan', { nombre: r.nombre, antes, ahora: r.precio }); }
    }
    for (const e of archivan) ej('se_archivan', { nombre: e.name, precio: Number(e.raw_price) || null });
    return {
        filas: resueltas.length,
        ...cuenta,
        se_archivan: archivan.length,
        con_foto: resueltas.filter(r => r.foto || r.existente?.image_url).length,
        sin_foto: resueltas.filter(r => !r.foto && !r.existente?.image_url).length,
        salteadas,
        ejemplos,
    };
}

/** Lee una lista y la compara con lo cargado, sin escribir nada */
async function previsualizar(db, supplier, buffer) {
    const { hoja, filas, salteadas } = leerLista(buffer, { conFotos: true });
    if (filas.length === 0) throw new Error('La lista no tiene productos con nombre y precio');
    const existentes = await cargarExistentes(db, supplier.id);
    const resueltas = resolverFilas(filas, existentes, supplier.prefix);
    return { hoja, ...resumir(resueltas, existentes, salteadas) };
}

// =============================================
// Fotos
// =============================================

/**
 * Guarda la foto de cada fila en storage/photos/<proveedor>/<sku>.jpg y devuelve su URL.
 * Si la fila no trae foto, queda la que ya tenía (una lista sin foto no borra la anterior).
 * @returns {Promise<Map<string, string|null>>} sku → image_url
 */
async function guardarFotos(resueltas, supplier, { sharp = null } = {}) {
    const carpeta = carpetaFotos(supplier);
    const dir = path.join(storageRoot(), 'photos', carpeta);
    await fs.promises.mkdir(dir, { recursive: true });
    const urls = new Map();
    for (const r of resueltas) {
        const anterior = r.existente?.image_url || null;
        if (!r.foto) { urls.set(r.sku, anterior); continue; }
        const nombre = `${r.sku.toLowerCase()}.jpg`;
        const ruta = path.join(dir, nombre);
        let bytes = r.foto.buffer;
        if (!['jpg', 'jpeg'].includes(r.foto.ext) && sharp) {
            try { bytes = await sharp(bytes).jpeg({ quality: 85 }).toBuffer(); } catch (_) { /* se guarda como vino */ }
        }
        let igual = false;
        try {
            const actual = await fs.promises.readFile(ruta);
            igual = crypto.createHash('md5').update(actual).digest('hex')
                === crypto.createHash('md5').update(bytes).digest('hex');
        } catch (_) { /* no existe */ }
        if (!igual) await fs.promises.writeFile(ruta, bytes);
        urls.set(r.sku, `/storage/photos/${carpeta}/${nombre}`);
    }
    return urls;
}

module.exports = {
    LISTA_KEY,
    esLista,
    carpetaFotos,
    rutaListaVigente,
    guardarPendiente,
    confirmarPendiente,
    leerPendiente,
    cargarExistentes,
    resolverFilas,
    resumir,
    previsualizar,
    guardarFotos,
};
