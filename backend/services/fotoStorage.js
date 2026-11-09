// Fotos guardadas en la app (volumes/storage, servidas en /storage/...).
// Las listas de proveedores (PDF / Excel) dejan sus fotos ahí: un fetch desde el backend
// no las encuentra porque /storage es una ruta de nginx, así que se leen del disco (nota 175).

const fs = require('fs');
const path = require('path');

const PREFIJO = '/storage/';

function storageRoot() {
    return process.env.STORAGE_PATH || path.join(__dirname, '..', 'storage');
}

function esFotoStorage(imageUrl) {
    return typeof imageUrl === 'string' && imageUrl.startsWith(PREFIJO);
}

/**
 * Ruta en disco de una URL /storage/..., o null si se sale de la carpeta (../).
 * @param {string} imageUrl
 * @param {string} [root]
 */
function rutaEnDisco(imageUrl, root = storageRoot()) {
    if (!esFotoStorage(imageUrl)) return null;
    const base = path.resolve(root);
    const relativa = decodeURIComponent(imageUrl.slice(PREFIJO.length).split(/[?#]/)[0]);
    const completa = path.resolve(base, relativa);
    if (completa !== base && !completa.startsWith(base + path.sep)) return null;
    return completa;
}

/**
 * Bytes de una foto guardada en /storage, o null si no existe.
 * @param {string} imageUrl
 * @param {string} [root]
 * @returns {Promise<Buffer|null>}
 */
async function leerFotoStorage(imageUrl, root) {
    const ruta = rutaEnDisco(imageUrl, root);
    if (!ruta) return null;
    try {
        return await fs.promises.readFile(ruta);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/** URL descargable desde el backend: "//cdn..." no tiene protocolo y fetch la rechaza */
function urlDescargable(imageUrl) {
    return typeof imageUrl === 'string' && imageUrl.startsWith('//') ? `https:${imageUrl}` : imageUrl;
}

module.exports = { storageRoot, esFotoStorage, rutaEnDisco, leerFotoStorage, urlDescargable };
