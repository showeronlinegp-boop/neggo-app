// API del agente (Grok Bot): cadencia de mensajes a posibles clientes (crm_leads).
// Lógica pura, sin base ni Odoo. Tests en agenteLeads.test.js.
//
// Cadencia: presentacion → recordatorio (7 días después de la presentación) → cierre (14 días
// después del recordatorio). Al confirmar el cierre la cadencia termina (sin_respuesta).
// La etapa guardada es la ÚLTIMA ENVIADA. Si el posible cliente contesta, la cadencia se frena:
// sigue la charla y Grok marca el resultado (interesado, no_interesado o no_contactar).
// Una presentación mandada a mano desde la app (nota #81) cuenta como la presentación.

const health = require('./clientHealth');

const ETAPAS = ['pendiente', 'presentacion', 'recordatorio', 'cierre', 'finalizado'];
const CADENCIA = [
    { etapa: 'presentacion', despuesDe: 'pendiente', dias: 0 },
    { etapa: 'recordatorio', despuesDe: 'presentacion', dias: 7 },
    { etapa: 'cierre', despuesDe: 'recordatorio', dias: 14 },
];
const ETAPAS_ENVIO = CADENCIA.map((p) => p.etapa);
// Lo que Grok puede marcar después de una charla. sin_respuesta y ya_en_odoo los pone la API.
const RESULTADOS_AGENTE = ['interesado', 'no_interesado'];
const RESULTADOS = ['interesado', 'no_interesado', 'no_contactar', 'sin_respuesta', 'ya_en_odoo'];

// Tope de mensajes de la cadencia por día (todas las etapas juntas). 0 apaga los envíos.
const TOPE_DEFAULT = 15;
const TOPE_MAX = 200;

// Dentro de la zona, quién va primero según el estado que traía la agenda.
// Churn (nos bloquearon o no quieren que los contactemos) no entra nunca.
const PRIORIDAD_ESTADO = { recuperar: 1, cliente: 2, lead: 3, sin_estado: 4, nri: 5 };
const ESTADOS_EXCLUIDOS = ['churn'];

/** Zona de config/leadsZona.json: { prefijo: { prioridad, localidad } }. */
function cargarZona(cfg = require('../config/leadsZona.json')) {
    const out = new Map();
    for (const [prioridad, clave] of [[1, 'prioridad_1'], [2, 'prioridad_2']]) {
        for (const [prefijo, localidad] of Object.entries(cfg[clave] || {})) {
            if (/^\d{2,4}$/.test(prefijo)) out.set(prefijo, { prioridad, localidad });
        }
    }
    return out;
}

const ZONA = cargarZona();

/**
 * Zona de un celular (característica + número, 10 dígitos): { prioridad, localidad, caracteristica }
 * o null si está fuera de la zona. Las características argentinas no se pisan entre sí, así que
 * alcanza con buscar de la más larga a la más corta.
 */
function zonaDe(phoneKey, zona = ZONA) {
    if (!phoneKey) return null;
    for (const len of [4, 3, 2]) {
        const hit = zona.get(String(phoneKey).slice(0, len));
        if (hit) return { ...hit, caracteristica: String(phoneKey).slice(0, len) };
    }
    return null;
}

function topeDiario(env = process.env) {
    const n = parseInt(env.AGENTE_LEADS_TOPE_DIARIO, 10);
    if (Number.isNaN(n) || n < 0) return TOPE_DEFAULT;
    return Math.min(n, TOPE_MAX);
}

function ordenEtapa(etapa) {
    return ETAPAS.indexOf(etapa);
}

/**
 * La etapa que cuenta para la cadencia: la guardada, o 'presentacion' si todavía está en
 * pendiente pero se le mandó la presentación a mano desde la app.
 * @returns {{ etapa: string, fecha: string|null }} fecha (YYYY-MM-DD) del último envío de la cadencia
 */
function etapaEfectiva({ etapa = 'pendiente', fechaUltimoEnvio = null, presentacionManual = null }) {
    if (etapa === 'pendiente' && presentacionManual) return { etapa: 'presentacion', fecha: presentacionManual };
    return { etapa, fecha: fechaUltimoEnvio };
}

/** Fecha (YYYY-MM-DD) desde la que se puede mandar el mensaje siguiente a `etapa`, o null si no hay más. */
function proximaFecha(etapa, fechaUltimoEnvio, hoy) {
    const paso = CADENCIA.find((p) => p.despuesDe === etapa);
    if (!paso) return null;
    if (etapa === 'pendiente') return hoy;
    return fechaUltimoEnvio ? health.addDays(fechaUltimoEnvio, paso.dias) : null;
}

/**
 * Qué mensaje de la cadencia le toca hoy, o null.
 * bloqueado: ya está en Odoo, o el equipo lo movió de Frío (lo sigue una persona).
 */
function tocaHoy({ etapa = 'pendiente', fechaUltimoEnvio = null, presentacionManual = null, hoy, noContactar = false, respondio = false, bloqueado = false }) {
    if (noContactar || respondio || bloqueado || etapa === 'finalizado') return null;
    const ef = etapaEfectiva({ etapa, fechaUltimoEnvio, presentacionManual });
    const paso = CADENCIA.find((p) => p.despuesDe === ef.etapa);
    if (!paso) return null;
    const desde = proximaFecha(ef.etapa, ef.fecha, hoy);
    if (!desde || health.daysBetween(desde, hoy) < 0) return null;
    return paso.etapa;
}

/** Envíos que quedan hoy contra el tope. */
function quedanHoy(tope, enviadosHoy) {
    return Math.max(0, tope - enviadosHoy);
}

/**
 * Por qué el bot no le escribe nunca (aunque no haya pedido nada), o null.
 * fuera_de_zona: la característica no está en config/leadsZona.json.
 * churn: la agenda lo tiene como Churn (nos bloqueó o no quiere que lo contactemos).
 */
function motivoExcluido({ phoneKey, estadoAgenda, zona = ZONA }) {
    if (ESTADOS_EXCLUIDOS.includes(estadoAgenda)) return 'churn';
    if (!zonaDe(phoneKey, zona)) return 'fuera_de_zona';
    return null;
}

/**
 * Orden de la cola: primero los seguimientos (recordatorio y cierre, el más atrasado primero),
 * después las presentaciones: zona (prioridad 1 antes que 2), estado de la agenda, con nombre
 * antes que sin nombre, y por id para que sea estable.
 */
function compararCola(a, b) {
    const seguimientoA = a.toca_hoy && a.toca_hoy !== 'presentacion' ? 0 : 1;
    const seguimientoB = b.toca_hoy && b.toca_hoy !== 'presentacion' ? 0 : 1;
    if (seguimientoA !== seguimientoB) return seguimientoA - seguimientoB;
    if (!seguimientoA) {
        const fa = a.desde || '';
        const fb = b.desde || '';
        if (fa !== fb) return fa < fb ? -1 : 1;
    } else {
        const za = a.zona ? a.zona.prioridad : 9;
        const zb = b.zona ? b.zona.prioridad : 9;
        if (za !== zb) return za - zb;
        const pa = PRIORIDAD_ESTADO[a.estado_agenda || 'sin_estado'] || 9;
        const pb = PRIORIDAD_ESTADO[b.estado_agenda || 'sin_estado'] || 9;
        if (pa !== pb) return pa - pb;
        const na = a.nombre ? 0 : 1;
        const nb = b.nombre ? 0 : 1;
        if (na !== nb) return na - nb;
    }
    return a.id - b.id;
}

/**
 * Qué resultado puede marcar el agente. Devuelve un mensaje de error (409) o null si vale.
 * no_contactar es definitivo; ya_en_odoo también (lo sigue el flujo de clientes).
 */
function errorResultado(actual, nuevo) {
    if (!actual || actual === nuevo || actual === 'sin_respuesta') return null;
    if (actual === 'no_contactar') return 'Pidió no recibir mensajes: el resultado solo lo cambia el equipo';
    if (actual === 'ya_en_odoo') return 'Ya está en Odoo: se sigue como cliente';
    return null;
}

module.exports = {
    ETAPAS,
    CADENCIA,
    ETAPAS_ENVIO,
    RESULTADOS,
    RESULTADOS_AGENTE,
    TOPE_DEFAULT,
    TOPE_MAX,
    PRIORIDAD_ESTADO,
    ESTADOS_EXCLUIDOS,
    cargarZona,
    zonaDe,
    motivoExcluido,
    topeDiario,
    ordenEtapa,
    etapaEfectiva,
    proximaFecha,
    tocaHoy,
    quedanHoy,
    compararCola,
    errorResultado,
};
