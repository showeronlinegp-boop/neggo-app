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

// Origen del posible cliente para el agente. Los que da de alta el bot (POST /leads) se guardan
// con source = SOURCE_MANUAL_AGENTE y salen como origen "manual"; todos los demás (la agenda de
// Google y las altas a mano desde la app) salen como "agenda" y siguen con el filtro de zona.
const SOURCE_MANUAL_AGENTE = 'agente_manual';
const ORIGENES = ['manual', 'agenda'];
// Fuera del mapa de zona, un lead manual ordena como prioridad 2 (no se excluye)
const PRIORIDAD_FUERA_DE_MAPA = 2;
// Características de 3 dígitos (el resto, salvo 11, son de 4). Solo para informar la
// característica de un lead manual que no está en config/leadsZona.json.
const CARACTERISTICAS_3 = new Set([
    '220', '221', '223', '230', '236', '237', '249', '260', '261', '263', '264', '266', '280', '291',
    '294', '297', '298', '299', '336', '341', '342', '343', '345', '348', '351', '353', '358', '362',
    '364', '370', '376', '379', '380', '381', '383', '385', '387', '388',
]);

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

/** Característica de un celular (10 dígitos sin 0 ni 15), esté o no en la zona. */
function caracteristicaDe(phoneKey) {
    const d = String(phoneKey || '');
    if (!/^\d{10}$/.test(d)) return null;
    if (d.startsWith('11')) return '11';
    if (CARACTERISTICAS_3.has(d.slice(0, 3))) return d.slice(0, 3);
    return d.slice(0, 4);
}

function origenDe(source) {
    return source === SOURCE_MANUAL_AGENTE ? 'manual' : 'agenda';
}

/**
 * Zona como la ve el agente. Los de agenda: la del mapa o null (quedan fuera de zona).
 * Los manuales fuera del mapa: la característica igual, localidad = ciudad y prioridad 2.
 */
function zonaLead({ phoneKey, origen = 'agenda', ciudad = null, zona = ZONA }) {
    const hit = zonaDe(phoneKey, zona);
    if (hit || origen !== 'manual' || !phoneKey) return hit;
    const caracteristica = caracteristicaDe(phoneKey);
    return caracteristica ? { prioridad: PRIORIDAD_FUERA_DE_MAPA, localidad: ciudad || null, caracteristica } : null;
}

/**
 * Ciudad de un alta manual: la del body gana siempre; si no, la localidad del mapa de zona
 * (2477 → Pergamino). { ciudad, inferida }: inferida=false si no se pudo (ciudad null).
 */
function ciudadAlta({ ciudad, phoneKey, zona = ZONA }) {
    if (ciudad) return { ciudad, inferida: true };
    const hit = zonaDe(phoneKey, zona);
    if (hit && hit.localidad) return { ciudad: hit.localidad, inferida: true };
    return { ciudad: null, inferida: false };
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
 * fuera_de_zona: la característica no está en config/leadsZona.json (no aplica a los manuales).
 * churn: la agenda lo tiene como Churn (nos bloqueó o no quiere que lo contactemos).
 */
function motivoExcluido({ phoneKey, estadoAgenda, origen = 'agenda', zona = ZONA }) {
    if (ESTADOS_EXCLUIDOS.includes(estadoAgenda)) return 'churn';
    if (origen !== 'manual' && !zonaDe(phoneKey, zona)) return 'fuera_de_zona';
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
    SOURCE_MANUAL_AGENTE,
    ORIGENES,
    PRIORIDAD_FUERA_DE_MAPA,
    cargarZona,
    zonaDe,
    zonaLead,
    caracteristicaDe,
    origenDe,
    ciudadAlta,
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
