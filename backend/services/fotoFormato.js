// Formato de las fotos de proveedores antes de mandarlas a Odoo (nota 183).
// Algunas webs (Alif, Nurcell/Babu) sirven AVIF aunque el archivo diga ".jpg". Odoo no lo toma
// y la app lo rechazaba como "no es una foto". Acá se pasa a JPG: primero con sharp y, si sharp
// no puede (AVIF de 10 bits: su decodificador solo lee 8 bits), con avifdec (paquete libavif-apps).
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { detectMime } = require('./whatsappMessage');

const CALIDAD_JPG = 90;
const AVIFDEC_TIMEOUT_MS = 30 * 1000;

// AVIF / AVIF animado: caja "ftyp" con marca avif o avis
function esAvif(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 12
        && buf.toString('ascii', 4, 8) === 'ftyp'
        && /^avi[fs]$/.test(buf.toString('ascii', 8, 12));
}

// La web devolvió una página (login, error, "no encontrado") en vez de la foto
function esHtml(buf) {
    const inicio = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    return inicio.startsWith('<!doctype html') || inicio.startsWith('<html') || (inicio.startsWith('<?xml') && inicio.includes('<html'));
}

function errorDeFormato(mensaje) {
    return Object.assign(new Error(mensaje), { status: 502 });
}

async function conSharp(buf) {
    const sharp = require('sharp');
    return sharp(buf).rotate().jpeg({ quality: CALIDAD_JPG }).toBuffer();
}

async function conAvifdec(buf) {
    const base = path.join(os.tmpdir(), `foto-${crypto.randomBytes(8).toString('hex')}`);
    const entrada = `${base}.avif`;
    const salida = `${base}.jpg`;
    try {
        await fsp.writeFile(entrada, buf);
        await new Promise((resolve, reject) => {
            execFile('avifdec', ['-q', String(CALIDAD_JPG), entrada, salida], { timeout: AVIFDEC_TIMEOUT_MS },
                (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
        });
        return await fsp.readFile(salida);
    } finally {
        await Promise.all([fsp.rm(entrada, { force: true }), fsp.rm(salida, { force: true })]);
    }
}

/**
 * Devuelve la foto en un formato que Odoo acepta (JPG, PNG, WebP o GIF).
 * Si viene en AVIF la pasa a JPG. Si no es una foto, tira un error con status 502 y un mensaje
 * que dice qué llegó.
 * @param {Buffer} buf bytes de la foto
 * @param {{ convertidores?: Array<(buf: Buffer) => Promise<Buffer>> }} [deps] para los tests
 * @returns {Promise<{ buffer: Buffer, mime: string, convertida: boolean }>}
 */
async function fotoCompatible(buf, deps = {}) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw errorDeFormato('El proveedor devolvió un archivo vacío en vez de la foto');
    const mime = detectMime(buf);
    if (mime) return { buffer: buf, mime, convertida: false };

    if (esAvif(buf)) {
        const convertidores = deps.convertidores || [conSharp, conAvifdec];
        const fallas = [];
        for (const convertir of convertidores) {
            try {
                const jpg = await convertir(buf);
                if (detectMime(jpg) === 'image/jpeg') return { buffer: jpg, mime: 'image/jpeg', convertida: true };
                fallas.push('no salió un JPG');
            } catch (err) {
                fallas.push(String(err.message).split('\n')[0]);
            }
        }
        console.warn(`⚠️ No se pudo pasar a JPG una foto AVIF: ${fallas.join(' / ')}`);
        throw errorDeFormato('La foto del proveedor está en formato AVIF y no se pudo pasar a JPG');
    }
    if (esHtml(buf)) throw errorDeFormato('La web del proveedor devolvió una página en vez de la foto');
    throw errorDeFormato('Lo que devolvió el proveedor no es una foto (ni JPG, PNG, WebP, GIF ni AVIF)');
}

// Igual que fotoCompatible pero de base64 a base64 (como lo usa Odoo en image_1920)
async function fotoCompatibleBase64(base64, deps) {
    const { buffer, convertida } = await fotoCompatible(Buffer.from(base64, 'base64'), deps);
    return convertida ? buffer.toString('base64') : base64;
}

module.exports = { fotoCompatible, fotoCompatibleBase64, esAvif, esHtml, conSharp, conAvifdec };
