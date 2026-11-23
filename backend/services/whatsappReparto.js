// Reparto de las publicaciones del grupo de WhatsApp en el día. Lógica pura, sin base.
// Tests en whatsappReparto.test.js.
//
// Ventana: lunes a sábado de 9 a 18 (hora de Argentina, sin horario de verano).
// Cada tanda reparte sus mensajes desde su hora de inicio hasta las 18 de ese día. Cuando hay
// varias tandas, sus mensajes se intercalan por hora ideal, así lo que se suma en el día va
// ocupando los huecos. Nunca dos publicaciones a menos de minGap segundos (90 por defecto).
// Lo que no entra hasta las 18 no se publica (queda omitido).

const AR_OFFSET_MS = -3 * 60 * 60 * 1000;
const HORA_INICIO = 9;
const HORA_FIN = 18;
// 0 = domingo. Lunes a sábado.
const DIAS = new Set([1, 2, 3, 4, 5, 6]);
const MIN_GAP_DEFAULT = 90;
// Cada mensaje cae al azar dentro de su lugar: ±35 % del espacio entre mensajes de su tanda.
const JITTER = 0.35;
const VENTANA_TEXTO = 'lunes a sábado de 9 a 18';

/** Partes de la fecha en hora de Argentina. */
function arParts(date) {
    const d = new Date(date.getTime() + AR_OFFSET_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

/** Date para una fecha y hora de Argentina. */
function arDate(y, m, d, h, min = 0) {
    return new Date(Date.UTC(y, m, d, h, min) - AR_OFFSET_MS);
}

/**
 * Ventana de publicación que contiene a `desde` o la siguiente: { inicio, fin }.
 * Antes de las 9 arranca a las 9; después de las 18 o en domingo, el próximo día hábil a las 9.
 */
function ventanaDesde(desde) {
    let p = arParts(desde);
    let dia = arDate(p.y, p.m, p.d, 0);
    let inicio = desde;
    for (let i = 0; i < 8; i++) {
        const q = arParts(dia);
        const abre = arDate(q.y, q.m, q.d, HORA_INICIO);
        const cierra = arDate(q.y, q.m, q.d, HORA_FIN);
        if (DIAS.has(q.dow) && inicio < cierra) {
            return { inicio: inicio > abre ? inicio : abre, fin: cierra };
        }
        dia = arDate(q.y, q.m, q.d + 1, 0);
        inicio = dia;
    }
    throw new Error('No encontré una ventana de publicación');
}

/** Número estable en [0, 1) a partir del id: la variación no cambia en cada reacomodo. */
function azarDe(id) {
    const x = Math.imul(Number(id) | 0, 2654435761) >>> 0;
    return x / 4294967296;
}

/**
 * Hora ideal de un mensaje: los pendientes de la tanda en partes iguales entre `desde` y las 18
 * (rango = su lugar entre los pendientes), cada uno al azar dentro de su lugar.
 */
function horaIdeal({ desde, fin, pendientes, rango, id, azar = azarDe }) {
    const paso = Math.max(0, fin.getTime() - desde.getTime()) / Math.max(pendientes, 1);
    const factor = 0.5 + (azar(id) - 0.5) * 2 * JITTER;
    return desde.getTime() + (rango + factor) * paso;
}

/**
 * Plan del día para los mensajes pendientes del grupo. Lo pendiente de cada tanda se reparte
 * desde ahora (o desde su inicio, si todavía no llegó) hasta las 18: si la cola se atrasó (backend
 * caído, Evolution ocupado), lo atrasado se vuelve a repartir en lo que queda del día en vez de
 * salir todo junto.
 * @param {object} p
 * @param {Array<{batchId, inicio: Date}>} p.tandas — inicio = hora elegida (o de creación)
 * @param {Array<{id, batchId, position}>} p.mensajes — los que hay que ubicar
 * @param {Date|null} p.ultimoEnvio — último intento de envío (cuenta para los 90 s)
 * @param {Date} p.ahora
 * @returns {Array<{id, scheduledAt: Date|null, deadline: Date, omitido: boolean}>}
 */
function planificar({ tandas, mensajes, ultimoEnvio = null, ahora, minGap = MIN_GAP_DEFAULT, azar = azarDe }) {
    const ventanas = new Map(tandas.map((t) => [t.batchId, ventanaDesde(t.inicio)]));
    const porTanda = new Map();
    for (const m of [...mensajes].sort((a, b) => a.position - b.position)) {
        if (!porTanda.has(m.batchId)) porTanda.set(m.batchId, []);
        porTanda.get(m.batchId).push(m);
    }
    const conIdeal = [];
    for (const [batchId, lista] of porTanda) {
        const v = ventanas.get(batchId);
        const desde = new Date(Math.max(v.inicio.getTime(), ahora.getTime()));
        lista.forEach((m, rango) => conIdeal.push({
            ...m, v, ideal: horaIdeal({ desde, fin: v.fin, pendientes: lista.length, rango, id: m.id, azar }),
        }));
    }
    conIdeal.sort((a, b) => a.ideal - b.ideal || a.batchId - b.batchId || a.position - b.position);
    const gapMs = minGap * 1000;
    let prev = ultimoEnvio ? ultimoEnvio.getTime() : null;
    return conIdeal.map((m) => {
        const t = Math.max(m.ideal, ahora.getTime(), m.v.inicio.getTime(), prev == null ? -Infinity : prev + gapMs);
        const at = Math.ceil(t / 1000) * 1000;
        if (at > m.v.fin.getTime()) return { id: m.id, scheduledAt: null, deadline: m.v.fin, omitido: true };
        prev = at;
        return { id: m.id, scheduledAt: new Date(at), deadline: m.v.fin, omitido: false };
    });
}

module.exports = {
    HORA_INICIO,
    HORA_FIN,
    MIN_GAP_DEFAULT,
    VENTANA_TEXTO,
    arParts,
    arDate,
    ventanaDesde,
    azarDe,
    horaIdeal,
    planificar,
};
