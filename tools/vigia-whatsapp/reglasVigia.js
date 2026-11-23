// Reglas del vigía de WhatsApp (nota 247): lógica pura, sin Docker ni red.
// Cuenta en el log de Evolution lo que significa tráfico hacia los servidores de WhatsApp y decide
// si está normal, si se está por desmadrar (aviso) o si hay que cortar (frenar Evolution).

// Qué se cuenta. Cada patrón es una línea del log de Evolution v2.3.7 (sin colores ANSI).
const SENALES = {
    // createClient: cada intento de conexión abre un socket nuevo contra WhatsApp
    conexiones: /Browser: /,
    // Parche 6 de evolution/parcheEvolution.js: la conexión se cerró y se agenda un reintento
    cierres: /Parche Neggo: conexión cerrada/,
    // WhatsApp avisa que estamos pidiendo demasiado (HTTP 429)
    limite: /rate-overlimit/,
    // Pedidos de datos de grupos (groupMetadata) que hace Evolution
    grupos: /Updating cache for group|Cache request for group/,
    // WhatsApp desvinculó el número
    desvinculado: /Log out instance|"statusCode":401|statusCode: 401/,
};

// Topes en la ventana (por defecto 5 minutos). Con el parche de reconexión lo normal es 1 o 2
// conexiones por despertar de la PC; el 22/11 hubo 1.548 en un minuto.
const TOPES = {
    conexiones: 12,
    cierres: 12,
    limite: 3,
    grupos: 100,
    desvinculado: 1,
};

const VENTANA_MS = 5 * 60 * 1000;

/** Saca los colores ANSI que mete el logger de Evolution. */
function limpiar(linea) {
    // eslint-disable-next-line no-control-regex
    return String(linea || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Qué señales aparecen en una línea (puede ser más de una). */
function senalesDe(linea) {
    const l = limpiar(linea);
    return Object.keys(SENALES).filter((k) => SENALES[k].test(l));
}

/**
 * Agrega los eventos nuevos a la ventana y tira los viejos.
 * @param {Array<{t:number, s:string}>} ventana — eventos guardados (t = ms, s = señal)
 * @param {Array<{t:number, linea:string}>} lineas — líneas nuevas del log
 */
function acumular(ventana, lineas, ahora, ventanaMs = VENTANA_MS) {
    const out = ventana.filter((e) => e.t > ahora - ventanaMs);
    for (const { t, linea } of lineas) {
        for (const s of senalesDe(linea)) out.push({ t, s });
    }
    return out.filter((e) => e.t > ahora - ventanaMs);
}

function contar(ventana) {
    const c = Object.fromEntries(Object.keys(SENALES).map((k) => [k, 0]));
    for (const e of ventana) c[e.s] = (c[e.s] || 0) + 1;
    return c;
}

/**
 * ¿Cómo viene? 'normal' | 'aviso' (alguna señal pasó la mitad del tope) | 'cortar'.
 * @returns {{nivel:string, motivos:string[], cuentas:object}}
 */
function evaluar(ventana, topes = TOPES) {
    const cuentas = contar(ventana);
    const cortar = [];
    const avisar = [];
    for (const [k, tope] of Object.entries(topes)) {
        const n = cuentas[k] || 0;
        if (n >= tope) cortar.push(`${k}: ${n} (tope ${tope})`);
        else if (tope > 1 && n >= Math.ceil(tope / 2)) avisar.push(`${k}: ${n} (tope ${tope})`);
    }
    if (cortar.length) return { nivel: 'cortar', motivos: cortar, cuentas };
    if (avisar.length) return { nivel: 'aviso', motivos: avisar, cuentas };
    return { nivel: 'normal', motivos: [], cuentas };
}

/**
 * Líneas útiles para el reporte: solo las de cabecera del logger y los errores, nunca el
 * contenido de mensajes (los objetos que Evolution vuelca en varias líneas se saltean).
 */
function lineasParaReporte(lineas, max = 300) {
    const utiles = [];
    for (const { linea } of lineas) {
        const l = limpiar(linea).trimEnd();
        if (/^\[Evolution API\]/.test(l) || /^(Error|\s+at |  data: |    statusCode)/.test(l)) {
            utiles.push(l.length > 300 ? `${l.slice(0, 300)}…` : l);
        }
    }
    return utiles.slice(-max);
}

/**
 * Desarma el stream de logs de la API de Docker (contenedor sin TTY): bloques con cabecera de
 * 8 bytes (tipo, 0, 0, 0, largo de 32 bits big endian). Devuelve el texto y lo que sobró.
 */
function desmultiplexar(buffer) {
    let off = 0;
    const partes = [];
    while (buffer.length - off >= 8) {
        const largo = buffer.readUInt32BE(off + 4);
        if (buffer.length - off - 8 < largo) break;
        partes.push(buffer.subarray(off + 8, off + 8 + largo).toString('utf8'));
        off += 8 + largo;
    }
    return { texto: partes.join(''), resto: buffer.subarray(off) };
}

/** "2026-11-23T13:41:56.123456789Z linea" → { t, linea } (con timestamps=1 de Docker). */
function separarTimestamp(raw) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/.exec(raw);
    if (!m) return null;
    return { ts: normalizarTs(m[1]), t: Date.parse(m[1].replace(/(\.\d{3})\d+Z$/, '$1Z')), linea: m[2] };
}

/** Docker recorta los ceros finales de los nanosegundos: se completan para poder comparar como texto. */
function normalizarTs(ts) {
    const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(String(ts || ''));
    if (!m) return String(ts || '');
    return `${m[1]}.${(m[2] || '').padEnd(9, '0').slice(0, 9)}Z`;
}

module.exports = {
    SENALES,
    TOPES,
    VENTANA_MS,
    limpiar,
    senalesDe,
    acumular,
    contar,
    evaluar,
    lineasParaReporte,
    desmultiplexar,
    separarTimestamp,
    normalizarTs,
};
