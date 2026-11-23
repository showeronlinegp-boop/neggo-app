// CRM sobre WhatsApp: ficha comercial del prospecto (067). Lógica pura, sin base ni Odoo.
// Tests en leadObjetivos.test.js. La lectura y el guardado están en crmFichaService.js.
//
// Objetivos de nutrición (decisión de Mariano, 2026-11-22):
// - Presentar (nota 227, va primero): mandarle el mensaje de presentación. Cuenta la que se anota
//   desde la app, la que manda Grok y la que aparece en el chat del negocio.
// - Conocer: lo que tenemos que saber de él → dónde está (ciudad) y su rubro o interés.
// - Informar: lo que tiene que saber de nosotros → cada pregunta frecuente marcada "Contárselo a
//   todos" (mínimo de compra, horario, ubicación del local…). Se tilda a mano, o sola cuando el
//   texto aparece en algo que le mandamos (el chat del negocio o un mensaje de Grok).
// Con todo completo está listo para recibir precios.

const DIA_MS = 86400000;
// Grupos de la pantalla Contactos, según el último mensaje del chat
const DIAS_ACTIVO = 7;      // la charla todavía se puede leer (la depuración borra a los 7 días)
const DIAS_ABIERTA = 15;    // igual que la etapa Sin respuesta
const GRUPOS = ['activos', 'abiertos', 'dormidos', 'sinchat'];

/** activos (≤ 7 días) · abiertos (≤ 15) · dormidos (más) · sinchat (nunca hubo mensajes). */
function grupoDeCharla(ultimoMensajeAt, ahora = new Date()) {
    if (!ultimoMensajeAt) return 'sinchat';
    const dias = (ahora.getTime() - new Date(ultimoMensajeAt).getTime()) / DIA_MS;
    if (dias <= DIAS_ACTIVO) return 'activos';
    if (dias <= DIAS_ABIERTA) return 'abiertos';
    return 'dormidos';
}

/** Minúsculas, sin acentos ni signos, espacios simples. */
function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9$]+/g, ' ').trim();
}

/**
 * ¿Este mensaje que le mandamos ya le cuenta esta respuesta? Alcanza con que tenga el 80 % de las
 * palabras de 4 letras o más de la respuesta (o los números, como "$50.000"): el bot y las personas
 * suelen cambiar el saludo o el orden.
 */
function cuentaLaRespuesta(respuesta, mensaje) {
    const r = normalizar(respuesta);
    const m = ` ${normalizar(mensaje)} `;
    if (!r || !m.trim()) return false;
    const palabras = [...new Set(r.split(' ').filter((w) => w.length >= 4 || /\d/.test(w)))];
    if (!palabras.length) return m.includes(` ${r} `);
    const estan = palabras.filter((w) => m.includes(` ${w} `)).length;
    return estan / palabras.length >= 0.8;
}

/**
 * Respuestas "Contárselo a todos" que ya aparecen en lo que le mandamos.
 * @param {Array<{ id: number, respuesta: string }>} respuestas
 * @param {Array<{ texto: string, fuente: 'chat'|'bot', fecha: string|Date }>} enviados
 * @returns {Map<number, { fuente: string, fecha: string|Date }>}
 */
function informadosEnMensajes(respuestas, enviados) {
    const out = new Map();
    for (const r of respuestas || []) {
        const m = (enviados || []).find((e) => cuentaLaRespuesta(r.respuesta, e.texto));
        if (m) out.set(r.id, { fuente: m.fuente, fecha: m.fecha });
    }
    return out;
}

// Frase fija del mensaje de presentación (frontend clientesUi.js → mensajePresentacion): si aparece
// en algo que le mandamos por el chat del negocio, ya se presentó.
const FRASE_PRESENTACION = 'Soy Mariano de Neggo Mayorista, polirrubros de Pergamino. Te dejo nuestro contacto por si algún día precisás algo';

/** El primer mensaje que le mandamos que es la presentación (o null). */
function presentacionEnMensajes(enviados) {
    const lista = (enviados || []).filter((e) => cuentaLaRespuesta(FRASE_PRESENTACION, e.texto));
    if (!lista.length) return null;
    return lista.reduce((a, b) => (new Date(b.fecha) < new Date(a.fecha) ? b : a));
}

const CONOCER = [
    { id: 'ubicacion', titulo: 'Saber dónde está', ayuda: 'Ciudad, y si tiene local o vende online',
      pregunta: '¿De qué ciudad sos? ¿Tenés local o vendés online?' },
    { id: 'rubro', titulo: 'Saber su rubro e interés', ayuda: 'Qué negocio tiene y qué rubros o productos busca',
      pregunta: '¿Qué tipo de negocio tenés? ¿Qué rubros te interesan más?' },
];

/**
 * Objetivos de nutrición de un prospecto.
 * @param {{ perfil?: object|null, lead?: object|null, respuestas: Array<{ id, pregunta, respuesta }>,
 *           informados: Map<number, { fuente: string, fecha: any }>,
 *           presentacion?: { fecha: any, fuente: 'app'|'bot'|'chat' }|null }} datos
 *   respuestas = solo las "Contárselo a todos" activas y con texto.
 *   presentacion = cuándo se le mandó el mensaje de presentación (null si todavía no).
 */
function objetivos({ perfil, lead, respuestas, informados, presentacion = null }) {
    const p = perfil || {};
    const l = lead || {};
    const ciudad = p.ciudad || l.city || null;
    const rubro = [p.rubro || l.rubro, p.intereses].filter(Boolean).join(' · ') || null;
    const conocer = CONOCER.map((o) => {
        const valor = o.id === 'ubicacion'
            ? [ciudad, etiquetaLocal(p.tiene_local)].filter(Boolean).join(' · ') || null
            : rubro;
        const hecho = o.id === 'ubicacion' ? Boolean(ciudad) : Boolean(rubro);
        return { ...o, hecho, valor };
    });
    const informar = (respuestas || []).map((r) => {
        const inf = informados && informados.get(r.id);
        return {
            id: r.id, titulo: r.pregunta, respuesta: r.respuesta, hecho: Boolean(inf),
            fuente: inf ? inf.fuente : null, fecha: inf ? inf.fecha : null,
        };
    });
    const presentar = [{
        id: 'presentacion', titulo: 'Mandarle la presentación', ayuda: 'Quiénes somos, la web, el mínimo de compra y el horario',
        hecho: Boolean(presentacion), fuente: presentacion ? presentacion.fuente : null, fecha: presentacion ? presentacion.fecha : null,
    }];
    const todos = [
        ...presentar.map((o) => ({ grupo: 'presentar', ...o })),
        ...conocer.map((o) => ({ grupo: 'conocer', ...o })),
        ...informar.map((o) => ({ grupo: 'informar', ...o })),
    ];
    const pendiente = todos.find((o) => !o.hecho) || null;
    return {
        presentar,
        conocer,
        informar,
        hechos: todos.filter((o) => o.hecho).length,
        total: todos.length,
        listo_para_precios: todos.length > 0 && !pendiente,
        siguiente: pendiente ? { grupo: pendiente.grupo, id: pendiente.id, titulo: pendiente.titulo } : null,
    };
}

function etiquetaLocal(v) {
    return { local: 'tiene local', online: 'vende online', los_dos: 'local y online' }[v] || null;
}

// ── Resumen para vender (lo escribe Claude cada noche, o una persona) ─────────────────────────

const CAMPOS_PERFIL = {
    ciudad: 120, rubro: 120, intereses: 300, proveedor_actual: 200, trabas: 300, volumen: 200, compromisos: 300,
};
const TIENE_LOCAL = ['local', 'online', 'los_dos'];
const RESUMEN_MAX = 2000;

/**
 * Valida lo que se guarda del perfil (a mano o el resumen de Claude). Solo los campos que vienen;
 * '' o null borran el campo. resumen: hasta 2000 caracteres.
 * @returns {{ value: object, errors: Array<{ campo, error }> }}
 */
function validarPerfil(body) {
    const errors = [];
    const value = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { value, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    }
    for (const [campo, max] of Object.entries({ ...CAMPOS_PERFIL, resumen: RESUMEN_MAX })) {
        if (body[campo] === undefined) continue;
        if (body[campo] === null) { value[campo] = null; continue; }
        if (typeof body[campo] !== 'string') { errors.push({ campo, error: 'Tiene que ser texto' }); continue; }
        const v = body[campo].replace(/\r\n/g, '\n').trim();
        if (v.length > max) errors.push({ campo, error: `Máximo ${max} caracteres` });
        else value[campo] = v || null;
    }
    if (body.tiene_local !== undefined) {
        if (body.tiene_local === null || body.tiene_local === '') value.tiene_local = null;
        else if (!TIENE_LOCAL.includes(body.tiene_local)) errors.push({ campo: 'tiene_local', error: `Tiene que ser ${TIENE_LOCAL.join(', ')} o null` });
        else value.tiene_local = body.tiene_local;
    }
    if (!errors.length && !Object.keys(value).length) errors.push({ campo: 'body', error: 'No hay nada para guardar' });
    return { value, errors };
}

/**
 * Una línea de la respuesta de Claude para `registrar`: { lead_id, hasta, resumen, ...campos }.
 * hasta = el "hasta" que imprimió la tanda para ese prospecto (hasta qué mensaje leyó).
 */
function validarLineaResumen(obj, ahora = new Date()) {
    const errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { value: null, errors: ['no es un objeto JSON'] };
    const leadId = Number(obj.lead_id);
    if (!Number.isInteger(leadId) || leadId < 1) errors.push('lead_id inválido');
    const hasta = new Date(obj.hasta);
    if (!obj.hasta || Number.isNaN(hasta.getTime()) || hasta.getTime() > ahora.getTime() + 60000) errors.push('hasta inválido');
    const { lead_id: _l, hasta: _h, ...resto } = obj;
    if (typeof resto.resumen !== 'string' || !resto.resumen.trim()) errors.push('falta el resumen');
    const p = validarPerfil(resto);
    errors.push(...p.errors.map((e) => `${e.campo}: ${e.error}`));
    return { value: errors.length ? null : { lead_id: leadId, hasta, perfil: p.value }, errors };
}

// ── Lo que pidió ──────────────────────────────────────────────────────────────────────────

/** Item anotado: { texto, cantidad?, product_id?, product_name?, chat?, mensaje_id? }. */
function validarItem(body, { parcial = false } = {}) {
    const errors = [];
    const value = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { value, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    if (body.texto !== undefined || !parcial) {
        const t = typeof body.texto === 'string' ? body.texto.trim() : '';
        if (!t) errors.push({ campo: 'texto', error: 'Escribí qué pidió' });
        else if (t.length > 300) errors.push({ campo: 'texto', error: 'Máximo 300 caracteres' });
        else value.texto = t;
    }
    if (body.cantidad !== undefined) {
        if (body.cantidad === null || body.cantidad === '') value.cantidad = null;
        else {
            const n = Number(String(body.cantidad).replace(',', '.'));
            if (!Number.isFinite(n) || n <= 0 || n > 100000) errors.push({ campo: 'cantidad', error: 'Tiene que ser un número mayor a 0' });
            else value.cantidad = Math.round(n * 100) / 100;
        }
    }
    if (body.product_id !== undefined) {
        if (body.product_id === null) value.product_id = null;
        else if (!Number.isInteger(body.product_id) || body.product_id < 1) errors.push({ campo: 'product_id', error: 'Tiene que ser el id del producto de Odoo' });
        else value.product_id = body.product_id;
    }
    for (const [campo, max] of [['chat', 80], ['mensaje_id', 100]]) {
        if (body[campo] === undefined || body[campo] === null) continue;
        if (typeof body[campo] !== 'string' || body[campo].length > max) errors.push({ campo, error: 'Inválido' });
        else value[campo] = body[campo];
    }
    if (parcial && !errors.length && !Object.keys(value).length) errors.push({ campo: 'body', error: 'No hay nada para cambiar' });
    return { value, errors };
}

/** "12 vasos térmicos" → { cantidad: 12, texto: 'vasos térmicos' }; sin número, la cantidad queda null. */
function separarCantidad(texto) {
    const t = String(texto || '').trim();
    const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(?:u\.?|unidades|x)?\s+(.+)$/i);
    if (!m) return { cantidad: null, texto: t };
    return { cantidad: Number(m[1].replace(',', '.')), texto: m[2].trim() };
}

module.exports = {
    DIAS_ACTIVO,
    DIAS_ABIERTA,
    GRUPOS,
    CONOCER,
    FRASE_PRESENTACION,
    presentacionEnMensajes,
    grupoDeCharla,
    normalizar,
    cuentaLaRespuesta,
    informadosEnMensajes,
    objetivos,
    validarPerfil,
    validarLineaResumen,
    validarItem,
    separarCantidad,
};
