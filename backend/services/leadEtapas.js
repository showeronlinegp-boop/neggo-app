// Etapa de un posible cliente con chat de WhatsApp (CRM WhatsApp, L3 provisoria). Lógica pura, sin
// base. Tests en leadEtapas.test.js. Cada etapa tiene un objetivo: cumplirlo la hace avanzar.
//
// Automático, de la señal más fuerte a la más débil:
// - no_contactar: Churn de la agenda o se lo pidió al bot. Gana siempre, también sobre lo manual.
// - descartado: lo descartó el equipo (CRM) o Grok marcó no_interesado.
// - interesado: Grok marcó interesado. (Por ahora una persona también lo marca a mano: el criterio de
//   "calificado" no está definido.)
// - conversando: escribió alguna vez (al negocio o a Grok).
// - sin_respuesta: le escribimos, nunca contestó y pasaron 15 días desde nuestro último mensaje.
// - contactado: le escribimos y todavía no contestó.
// - sin_contactar: nada de lo anterior.
// Lo que marca una persona (interesado, descartado, conversando, contactado) gana sobre lo automático
// hasta que la vuelva a "automático". no_contactar siempre gana.

const DIAS_SIN_RESPUESTA = 15;

const ETAPAS = [
    { id: 'sin_contactar', label: 'Sin contactar', objetivo: 'Primer contacto' },
    { id: 'contactado', label: 'Contactado', objetivo: 'Que responda' },
    { id: 'conversando', label: 'Conversando', objetivo: 'Saber si le interesa comprar' },
    { id: 'interesado', label: 'Interesado', objetivo: 'Mandarle precios o una cotización' },
    { id: 'sin_respuesta', label: 'Sin respuesta', objetivo: 'Volver a intentar más adelante' },
    { id: 'descartado', label: 'Descartado', objetivo: null },
    { id: 'no_contactar', label: 'No contactar', objetivo: null },
];
const IDS = ETAPAS.map((e) => e.id);
const MANUALES = ['contactado', 'conversando', 'interesado', 'descartado'];

function ms(fecha) {
    if (!fecha) return null;
    const t = new Date(fecha).getTime();
    return Number.isNaN(t) ? null : t;
}

function masReciente(...fechas) {
    const v = fechas.map(ms).filter((t) => t !== null);
    return v.length ? Math.max(...v) : null;
}

/**
 * @param {object} s señales
 * @param {string|null} s.manual etapa que marcó una persona (o null = automático)
 * @param {boolean} s.churn agenda en Churn
 * @param {boolean} s.noContactar lo pidió al bot
 * @param {boolean} s.descartadoCrm etapa Descartado del CRM
 * @param {string|null} s.resultadoGrok interesado | no_interesado | sin_respuesta | …
 * @param {Date|string|null} s.ultimoDeEllos último mensaje suyo al negocio
 * @param {Date|string|null} s.ultimoNuestro último mensaje del negocio
 * @param {Date|string|null} s.ultimoRecibidoGrok último mensaje suyo que informó Grok
 * @param {Date|string|null} s.ultimoEnviadoGrok último mensaje de Grok (o presentación anotada)
 * @param {Date} [ahora]
 * @returns {{ etapa: string, automatica: string, manual: boolean, espera_respuesta: boolean, ultimo_mensaje_at: number|null }}
 */
function calcularEtapa(s, ahora = new Date()) {
    const deEllos = masReciente(s.ultimoDeEllos, s.ultimoRecibidoGrok);
    const nuestro = masReciente(s.ultimoNuestro, s.ultimoEnviadoGrok);
    let automatica;
    if (s.churn || s.noContactar) automatica = 'no_contactar';
    else if (s.descartadoCrm || s.resultadoGrok === 'no_interesado') automatica = 'descartado';
    else if (s.resultadoGrok === 'interesado') automatica = 'interesado';
    else if (deEllos !== null) automatica = 'conversando';
    else if (nuestro !== null && ahora.getTime() - nuestro >= DIAS_SIN_RESPUESTA * 86400000) automatica = 'sin_respuesta';
    else if (nuestro !== null) automatica = 'contactado';
    else automatica = 'sin_contactar';

    const manual = automatica !== 'no_contactar' && MANUALES.includes(s.manual) ? s.manual : null;
    return {
        etapa: manual || automatica,
        automatica,
        manual: Boolean(manual),
        // Conversación abierta: lo último lo escribió él
        espera_respuesta: deEllos !== null && (nuestro === null || deEllos > nuestro),
        ultimo_mensaje_at: masReciente(deEllos, nuestro),
    };
}

/** Agrupa por etapa en el orden del embudo; dentro, primero los que esperan respuesta y los más recientes. */
function agruparPorEtapa(items) {
    const grupos = ETAPAS.map((e) => ({ ...e, items: [] }));
    const por = new Map(grupos.map((g) => [g.id, g]));
    for (const it of items || []) (por.get(it.etapa) || por.get('sin_contactar')).items.push(it);
    for (const g of grupos) {
        g.items.sort((a, b) => Number(b.espera_respuesta) - Number(a.espera_respuesta)
            || (b.ultimo_mensaje_at || 0) - (a.ultimo_mensaje_at || 0) || a.id - b.id);
    }
    return grupos;
}

module.exports = { DIAS_SIN_RESPUESTA, ETAPAS, IDS, MANUALES, calcularEtapa, agruparPorEtapa };
