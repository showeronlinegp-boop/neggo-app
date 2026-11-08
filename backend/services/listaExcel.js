// Lectura de listas de precios en Excel (nota 175).
// Algunos proveedores (Pan Lin) no tienen web: mandan cada tanto un Excel con nombre, precio,
// categoría y foto. Este módulo lo convierte en filas de producto, sin tocar la base.
// Lo usa el scraper de listas (scrapers/listaScraper.js) igual que un scraper lee una web.

const crypto = require('crypto');
const XLSX = require('xlsx');

// =============================================
// Columnas: se reconocen por el encabezado
// =============================================

const normalizarEncabezado = s => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Cada campo con los encabezados que lo identifican (el primero que aparece gana)
const COLUMNAS = {
    zh:        [/chino/],
    nombre:    [/nombre de producto/, /^producto$/, /descripcion/, /articulo/, /^nombre$/, /nombre/],
    precio:    [/precio/],
    categoria: [/clase/, /categoria/, /rubro/],
    codigo:    [/^codigo$/, /^cod\.?$/, /codigo/],
};

/**
 * Busca la fila de encabezados (la primera con "precio" y algo de nombre) y la columna de cada campo.
 * @param {Array<Array>} filas
 * @returns {{ filaEncabezado: number, columnas: object } | null}
 */
function detectarColumnas(filas) {
    for (let i = 0; i < Math.min(filas.length, 15); i++) {
        const celdas = (filas[i] || []).map(normalizarEncabezado);
        if (!celdas.some(c => /precio/.test(c))) continue;
        const columnas = {};
        const usadas = new Set();
        for (const [campo, patrones] of Object.entries(COLUMNAS)) {
            for (const re of patrones) {
                const idx = celdas.findIndex((c, j) => c && !usadas.has(j) && re.test(c)
                    && !(campo === 'nombre' && /chino/.test(c)));
                if (idx >= 0) { columnas[campo] = idx; usadas.add(idx); break; }
            }
        }
        if (columnas.nombre != null && columnas.precio != null) return { filaEncabezado: i, columnas };
    }
    return null;
}

// =============================================
// Valores
// =============================================

function texto(v) {
    if (v == null) return '';
    return String(v).replace(/\s+/g, ' ').trim();
}

// Precio en número: acepta 2500, "2500", "2.500,50", "$ 2.500"
function precio(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = texto(v).replace(/[^\d.,]/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Pan Lin pone su código (3 a 5 dígitos) adelante del nombre, pegado o con un espacio:
// "0030TOALLA RAYADA", "6691 50PC GLOBO PASTEL". No es código si sigue una medida ("150CM").
const CODIGO_EN_NOMBRE = /^(\d{3,5})(?!\s*(?:CM|MM|ML|MTS?|M|PCS?|GR?|KG|LT?|W|V|CC)\b)(?:\s+(?=\S)|(?=[A-Z]))/i;

/**
 * Separa el código pegado adelante del nombre.
 * @returns {{ codigo: string|null, nombre: string }}
 */
function separarCodigo(nombreCrudo) {
    const t = texto(nombreCrudo);
    const m = t.match(CODIGO_EN_NOMBRE);
    if (!m) return { codigo: null, nombre: t };
    return { codigo: m[1], nombre: t.slice(m[0].length).trim() };
}

// Número al final del nombre chino (código de fábrica): "小胶带座20051" → "20051"
function numeroChino(zh) {
    const m = texto(zh).match(/(\d{4,})\s*$/);
    return m ? m[1] : null;
}

// Clave de nombre igual a la de baseScraper (name_key)
function claveNombre(nombre) {
    return String(nombre || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// =============================================
// Códigos (SKU sin PRE + prefijo)
// =============================================

/**
 * Código propio de cada fila, único dentro de la lista:
 *   1. el código del proveedor, si no se repite en la lista ("0030")
 *   2. CH + número del nombre chino, si no se repite ("CH20051")
 *   3. N + hash del nombre chino y el nombre (8 caracteres)
 * El código del proveedor se repite entre productos distintos: por eso no alcanza solo.
 * @param {Array<{codigo, zh, nombre}>} filas
 * @returns {string[]}
 */
function asignarCodigos(filas) {
    const contar = vals => vals.reduce((m, v) => (v ? m.set(v, (m.get(v) || 0) + 1) : m), new Map());
    const porCodigo = contar(filas.map(f => f.codigo));
    const porChino = contar(filas.map(f => numeroChino(f.zh)));
    const usados = new Set();
    return filas.map(f => {
        const ch = numeroChino(f.zh);
        let cod = null;
        if (f.codigo && porCodigo.get(f.codigo) === 1) cod = f.codigo;
        else if (ch && porChino.get(ch) === 1) cod = `CH${ch}`;
        if (!cod || usados.has(cod)) {
            const hash = crypto.createHash('md5').update(`${texto(f.zh)}|${texto(f.nombre)}`).digest('hex');
            cod = `N${hash.slice(0, 8).toUpperCase()}`;
            for (let i = 2; usados.has(cod); i++) cod = `N${hash.slice(0, 8).toUpperCase()}${i}`;
        }
        usados.add(cod);
        return cod;
    });
}

// =============================================
// Fotos: dibujos anclados a cada fila
// =============================================

function archivoZip(zip, ruta) {
    const f = XLSX.CFB.find(zip, '/' + ruta.replace(/^\/+/, ''));
    return f && f.content ? Buffer.from(f.content) : null;
}

// Resuelve "../media/x.jpeg" relativo a la carpeta del archivo que lo nombra
function resolverRuta(desde, target) {
    if (target.startsWith('/')) return target.slice(1);
    const partes = desde.split('/').slice(0, -1);
    for (const p of target.split('/')) {
        if (p === '..') partes.pop();
        else if (p !== '.') partes.push(p);
    }
    return partes.join('/');
}

function relaciones(zip, ruta) {
    const dir = ruta.split('/').slice(0, -1).join('/');
    const nombre = ruta.split('/').pop();
    const xml = archivoZip(zip, `${dir}/_rels/${nombre}.rels`);
    const mapa = new Map();
    if (!xml) return mapa;
    for (const m of xml.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
        const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
        const target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
        if (id && target) mapa.set(id, resolverRuta(ruta, target));
    }
    return mapa;
}

/**
 * Fotos de la primera hoja por fila (0 = primera fila de la hoja).
 * Lee el XML del dibujo a mano: además de imágenes (xdr:pic) Pan Lin usa rectángulos
 * rellenos con la foto (xdr:sp con blipFill), que las librerías no leen.
 * @returns {Map<number, { buffer: Buffer, ext: string }>}
 */
function fotosPorFila(buffer, rutaHoja) {
    const fotos = new Map();
    const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
    const dibujos = [...relaciones(zip, rutaHoja).values()].filter(r => /drawings\/[^/]+\.xml$/.test(r));
    for (const rutaDibujo of dibujos) {
        const xml = archivoZip(zip, rutaDibujo);
        if (!xml) continue;
        const rels = relaciones(zip, rutaDibujo);
        const anclas = xml.toString('utf8').match(/<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g) || [];
        for (const ancla of anclas) {
            const fila = ancla.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
            const embed = ancla.match(/r:embed="([^"]+)"/);
            if (!fila || !embed) continue;
            const rutaFoto = rels.get(embed[1]);
            const bytes = rutaFoto && archivoZip(zip, rutaFoto);
            const n = Number(fila[1]);
            if (!bytes || fotos.has(n)) continue;
            fotos.set(n, { buffer: bytes, ext: (rutaFoto.split('.').pop() || 'jpg').toLowerCase() });
        }
    }
    return fotos;
}

// Ruta de la primera hoja dentro del zip (xl/worksheets/sheet1.xml)
function rutaPrimeraHoja(buffer) {
    const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
    const wb = archivoZip(zip, 'xl/workbook.xml');
    const rid = wb && (wb.toString('utf8').match(/<sheet\b[^>]*r:id="([^"]+)"/) || [])[1];
    return (rid && relaciones(zip, 'xl/workbook.xml').get(rid)) || 'xl/worksheets/sheet1.xml';
}

// =============================================
// Lectura completa
// =============================================

/**
 * Lee la lista (primera hoja).
 * @param {Buffer} buffer — el .xlsx
 * @param {{ conFotos?: boolean }} [opciones]
 * @returns {{ hoja: string, filas: Array<{ fila, codigo, codigo_proveedor, zh, nombre, precio,
 *            categoria, foto }>, salteadas: Array<{ fila, motivo }> }}
 */
function leerLista(buffer, { conFotos = true } = {}) {
    let wb;
    try {
        wb = XLSX.read(buffer, { type: 'buffer' });
    } catch (err) {
        throw new Error(`No se pudo leer el Excel: ${err.message}`);
    }
    const hoja = wb.SheetNames[0];
    const ws = wb.Sheets[hoja];
    if (!ws || !ws['!ref']) throw new Error('La primera hoja del Excel está vacía');
    const inicio = XLSX.utils.decode_range(ws['!ref']).s.r;
    const crudas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });

    const det = detectarColumnas(crudas);
    if (!det) throw new Error('No encontré los encabezados: hace falta una columna de nombre y otra de precio');
    const { filaEncabezado, columnas: c } = det;

    let fotos = new Map();
    if (conFotos) {
        try {
            fotos = fotosPorFila(buffer, rutaPrimeraHoja(buffer));
        } catch (err) {
            console.warn(`⚠️ No se pudieron leer las fotos del Excel: ${err.message}`);
        }
    }

    const filas = [];
    const salteadas = [];
    for (let i = filaEncabezado + 1; i < crudas.length; i++) {
        const r = crudas[i] || [];
        const filaHoja = inicio + i; // 0 = primera fila de la hoja (como en el dibujo)
        const nombreCrudo = texto(r[c.nombre]);
        const p = precio(r[c.precio]);
        if (!nombreCrudo && !p) continue; // fila vacía
        if (!nombreCrudo || typeof r[c.nombre] === 'number') {
            salteadas.push({ fila: filaHoja + 1, motivo: 'sin nombre (¿fila de totales?)' });
            continue;
        }
        if (!p) {
            salteadas.push({ fila: filaHoja + 1, motivo: `"${nombreCrudo}" sin precio` });
            continue;
        }
        const columnaCodigo = c.codigo != null ? texto(r[c.codigo]) : '';
        const { codigo, nombre } = columnaCodigo
            ? { codigo: columnaCodigo, nombre: nombreCrudo }
            : separarCodigo(nombreCrudo);
        const categoria = c.categoria != null ? texto(r[c.categoria]) : '';
        filas.push({
            fila: filaHoja + 1,
            codigo_proveedor: codigo,
            zh: c.zh != null ? texto(r[c.zh]) : '',
            nombre,
            precio: p,
            // "Sin Foto" en la columna de clase es una marca del proveedor, no una categoría
            categoria: categoria && !/^sin foto$/i.test(categoria) ? categoria : null,
            foto: fotos.get(filaHoja) || null,
        });
    }

    const codigos = asignarCodigos(filas.map(f => ({ codigo: f.codigo_proveedor, zh: f.zh, nombre: f.nombre })));
    filas.forEach((f, i) => { f.codigo = codigos[i]; });
    return { hoja, filas, salteadas };
}

module.exports = {
    leerLista,
    detectarColumnas,
    separarCodigo,
    numeroChino,
    asignarCodigos,
    claveNombre,
    precio,
};
