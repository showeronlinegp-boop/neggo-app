// API del agente (Grok Bot): validación de query y bodies. Lógica pura, sin I/O.
// Cada validador devuelve { value, errors }, con errors = [{ campo, error }].
// Tests en agenteValidacion.test.js.

const { ETAPAS, CADENCIA, DIAS_DEFAULT, DIAS_MAX } = require('./agenteNuevos');

const ETAPAS_ENVIO = CADENCIA.map((p) => p.etapa);
const ID_EXTERNO_RE = /^[A-Za-z0-9._:-]{1,100}$/;

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;
const TEXTO_MAX = 4000;
const CONTACTO_MAX = 200;
const FEEDBACK_TIPOS = ['falta', 'error', 'mejora', 'comentario'];
// Los mensajes no hablan del IVA ni de impuestos: los precios son finales (nota #93)
const MENCIONA_IVA_RE = /\b(?:iva|i\.v\.a|impuestos?)\b/i;
// Margen para relojes desfasados: una fecha puede estar hasta 5 minutos en el futuro
const FUTURO_MAX_MS = 5 * 60 * 1000;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fechaValida(y, m, d) {
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d;
}

/**
 * Fecha o datetime ISO 8601 → Date. Sin offset se toma la hora de Argentina (UTC−3);
 * una fecha sola es ese día a las 00:00 de Argentina. Null si no es válida.
 */
function parseIso(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(ISO_RE);
    if (!m) return null;
    const [, y, mo, d, hh, mi, ss, tz] = m;
    if (!fechaValida(y, mo, d)) return null;
    if (hh !== undefined && (+hh > 23 || +mi > 59 || (ss !== undefined && +ss > 59))) return null;
    let s = value.trim();
    if (hh === undefined) s += 'T00:00:00-03:00';
    else if (!tz) s += '-03:00';
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms);
}

function esFechaSimple(value) {
    if (typeof value !== 'string') return false;
    const m = value.match(DATE_RE);
    return Boolean(m && fechaValida(m[1], m[2], m[3]));
}

function entero(value, { min, max }) {
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n >= min && n <= max ? n : null;
}

function booleanoQuery(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
}

function camposDesconocidos(body, permitidos) {
    return Object.keys(body)
        .filter((k) => !permitidos.includes(k))
        .map((campo) => ({ campo, error: 'Campo desconocido' }));
}

function esObjeto(body) {
    return body && typeof body === 'object' && !Array.isArray(body);
}

/** ?dias: entero de 1 a 90, por defecto 15. */
function validarDias(value) {
    if (value === undefined || value === '') return { value: DIAS_DEFAULT, errors: [] };
    const n = entero(value, { min: 1, max: DIAS_MAX });
    return n === null
        ? { value: null, errors: [{ campo: 'dias', error: `Tiene que ser un entero de 1 a ${DIAS_MAX}` }] }
        : { value: n, errors: [] };
}

/** ?page y ?limit. */
function validarPaginacion(query = {}) {
    const errors = [];
    let page = 1;
    let limit = LIMIT_DEFAULT;
    if (query.page !== undefined && query.page !== '') {
        page = entero(query.page, { min: 1, max: Number.MAX_SAFE_INTEGER });
        if (page === null) errors.push({ campo: 'page', error: 'Tiene que ser un entero mayor a 0' });
    }
    if (query.limit !== undefined && query.limit !== '') {
        limit = entero(query.limit, { min: 1, max: LIMIT_MAX });
        if (limit === null) errors.push({ campo: 'limit', error: `Tiene que ser un entero de 1 a ${LIMIT_MAX}` });
    }
    return { value: { page, limit, offset: ((page || 1) - 1) * (limit || LIMIT_DEFAULT) }, errors };
}

/** Query de GET clientes/nuevos. */
function validarQueryNuevos(query = {}) {
    const dias = validarDias(query.dias);
    const pag = validarPaginacion(query);
    const errors = [...dias.errors, ...pag.errors];
    // Por defecto no vienen los que pidieron no recibir mensajes (no_contactar=todos los trae a todos)
    const value = { dias: dias.value, ...pag.value, refresh: query.refresh === '1' || query.refresh === 'true', no_contactar: false };
    if (query.etapa !== undefined) {
        if (ETAPAS.includes(query.etapa)) value.etapa = query.etapa;
        else errors.push({ campo: 'etapa', error: `Tiene que ser uno de: ${ETAPAS.join(', ')}` });
    }
    if (query.no_contactar !== undefined) {
        const b = query.no_contactar === 'todos' ? null : booleanoQuery(query.no_contactar);
        if (b === undefined) errors.push({ campo: 'no_contactar', error: 'Tiene que ser true, false o todos' });
        else value.no_contactar = b;
    }
    for (const campo of ['para_hoy', 'con_respuesta_pendiente']) {
        if (query[campo] === undefined) continue;
        const b = booleanoQuery(query[campo]);
        if (b === undefined) errors.push({ campo, error: 'Tiene que ser true o false' });
        else value[campo] = b;
    }
    return { value, errors };
}

/** Query de GET productos. */
function validarQueryProductos(query = {}) {
    const pag = validarPaginacion(query);
    const errors = [...pag.errors];
    const value = { ...pag.value };
    // rubro=Bazar,Tecnología: los 2 o 3 rubros que más compró el cliente
    if (query.rubro !== undefined && String(query.rubro).trim()) {
        value.rubros = String(query.rubro).split(',').map((r) => r.trim()).filter(Boolean);
        if (value.rubros.length > 5) errors.push({ campo: 'rubro', error: 'Hasta 5 rubros separados por coma' });
    }
    if (query.precio_min !== undefined && query.precio_min !== '') {
        const n = Number(query.precio_min);
        if (!Number.isFinite(n) || n < 0) errors.push({ campo: 'precio_min', error: 'Tiene que ser un número mayor o igual a 0' });
        else value.precio_min = n;
    }
    if (query.q !== undefined && String(query.q).trim()) value.q = String(query.q).trim().slice(0, 100);
    if (query.stock !== undefined) {
        const b = booleanoQuery(query.stock);
        if (b === undefined) errors.push({ campo: 'stock', error: 'Tiene que ser true o false' });
        else value.stock = b;
    }
    if (query.solo_publicados !== undefined) {
        const b = booleanoQuery(query.solo_publicados);
        if (b === undefined) errors.push({ campo: 'solo_publicados', error: 'Tiene que ser true o false' });
        else value.solo_publicados = b;
    }
    value.orden = 'facturacion';
    if (query.orden !== undefined) {
        if (['facturacion', 'vendidos', 'nombre'].includes(query.orden)) value.orden = query.orden;
        else errors.push({ campo: 'orden', error: 'Tiene que ser facturacion, vendidos o nombre' });
    }
    if (query.excluir_compras_de !== undefined) {
        const id = entero(query.excluir_compras_de, { min: 1, max: 2147483647 });
        if (id === null) errors.push({ campo: 'excluir_compras_de', error: 'Tiene que ser el id de un cliente' });
        else value.excluir_compras_de = id;
    }
    return { value, errors };
}

/** :id del cliente: entero positivo. */
function validarId(value) {
    const n = entero(value, { min: 1, max: 2147483647 });
    return n === null ? { value: null, errors: [{ campo: 'id', error: 'Tiene que ser un entero positivo' }] } : { value: n, errors: [] };
}

function validarFechaPasada(campo, value, now, errors) {
    const d = parseIso(value);
    if (!d) {
        errors.push({ campo, error: 'Tiene que ser una fecha ISO 8601 (YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss-03:00)' });
        return undefined;
    }
    if (d.getTime() > now.getTime() + FUTURO_MAX_MS) {
        errors.push({ campo, error: 'No puede ser una fecha futura' });
        return undefined;
    }
    return d;
}

/** Body de PATCH clientes/:id/seguimiento: { etapa?, ultimo_contacto?, proxima_accion? }. */
function validarSeguimiento(body, now = new Date()) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const permitidos = ['etapa', 'ultimo_contacto', 'proxima_accion'];
    const errors = camposDesconocidos(body, permitidos);
    const value = {};
    if (!permitidos.some((k) => k in body)) {
        errors.push({ campo: 'body', error: 'Mandá al menos uno de: etapa, ultimo_contacto, proxima_accion' });
    }
    if ('etapa' in body) {
        if (ETAPAS.includes(body.etapa)) value.etapa = body.etapa;
        else errors.push({ campo: 'etapa', error: `Tiene que ser uno de: ${ETAPAS.join(', ')}` });
    }
    if ('ultimo_contacto' in body) {
        // No se borra ni retrocede: el servicio se queda con el más nuevo
        const d = validarFechaPasada('ultimo_contacto', body.ultimo_contacto, now, errors);
        if (d) value.ultimo_contacto = d;
    }
    if ('proxima_accion' in body) {
        if (body.proxima_accion === null || esFechaSimple(body.proxima_accion)) value.proxima_accion = body.proxima_accion;
        else errors.push({ campo: 'proxima_accion', error: 'Tiene que ser una fecha YYYY-MM-DD' });
    }
    return { value, errors };
}

function validarTexto(campo, value, { obligatorio }, errors) {
    if (value === undefined || value === null) {
        if (obligatorio) errors.push({ campo, error: 'Es obligatorio' });
        return null;
    }
    if (typeof value !== 'string') {
        errors.push({ campo, error: 'Tiene que ser texto' });
        return null;
    }
    const s = value.trim();
    if (obligatorio && !s) errors.push({ campo, error: 'No puede estar vacío' });
    // U+FFFD: el texto llegó en otra codificación y se rompieron las tildes
    else if (s.includes('�')) errors.push({ campo, error: 'Tiene caracteres inválidos: mandalo en UTF-8' });
    else if (s.length > TEXTO_MAX) errors.push({ campo, error: `Máximo ${TEXTO_MAX} caracteres` });
    return s || null;
}

function validarIdExterno(value, { obligatorio }, errors) {
    if (value === undefined || value === null) {
        if (obligatorio) errors.push({ campo: 'id_externo', error: 'Es obligatorio' });
        return null;
    }
    if (typeof value !== 'string' || !ID_EXTERNO_RE.test(value)) {
        errors.push({ campo: 'id_externo', error: 'Hasta 100 caracteres: letras, números, punto, guion, guion bajo o dos puntos' });
        return null;
    }
    return value;
}

/** Body de POST clientes/:id/interacciones: { fecha?, tipo, etapa?, mensaje, id_externo? }. */
function validarInteraccion(body, now = new Date()) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = camposDesconocidos(body, ['fecha', 'tipo', 'etapa', 'mensaje', 'id_externo']);
    const value = { fecha: now, etapa: null };
    if (!['enviado', 'recibido'].includes(body.tipo)) {
        errors.push({ campo: 'tipo', error: 'Es obligatorio y tiene que ser enviado o recibido' });
    } else value.tipo = body.tipo;
    value.mensaje = validarTexto('mensaje', body.mensaje, { obligatorio: true }, errors);
    value.id_externo = validarIdExterno(body.id_externo, { obligatorio: false }, errors);
    if (body.etapa !== undefined && body.etapa !== null) {
        if (ETAPAS.includes(body.etapa)) value.etapa = body.etapa;
        else errors.push({ campo: 'etapa', error: `Tiene que ser uno de: ${ETAPAS.join(', ')}` });
    }
    if (body.fecha !== undefined && body.fecha !== null) {
        const d = validarFechaPasada('fecha', body.fecha, now, errors);
        if (d) value.fecha = d;
    }
    return { value, errors };
}

/**
 * Body de POST clientes/:id/envios (reserva): { etapa, mensaje, id_externo, productos_recomendados? }.
 * No lleva fecha: los controles y las fechas usan siempre la hora del servidor.
 */
function validarEnvio(body) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = camposDesconocidos(body, ['etapa', 'mensaje', 'id_externo', 'productos_recomendados']);
    const value = { productos_recomendados: [] };
    if (ETAPAS_ENVIO.includes(body.etapa)) value.etapa = body.etapa;
    else errors.push({ campo: 'etapa', error: `Es obligatorio y tiene que ser uno de: ${ETAPAS_ENVIO.join(', ')}` });
    value.mensaje = validarTexto('mensaje', body.mensaje, { obligatorio: true }, errors);
    if (value.mensaje && MENCIONA_IVA_RE.test(value.mensaje)) {
        errors.push({ campo: 'mensaje', error: 'No menciones el IVA ni impuestos: los precios son finales, poné solo el precio' });
    }
    value.id_externo = validarIdExterno(body.id_externo, { obligatorio: true }, errors);
    if (body.productos_recomendados !== undefined && body.productos_recomendados !== null) {
        const lista = body.productos_recomendados;
        if (!Array.isArray(lista) || lista.length > 20 || !lista.every((x) => Number.isInteger(x) && x > 0)) {
            errors.push({ campo: 'productos_recomendados', error: 'Tiene que ser una lista de hasta 20 product_id' });
        } else value.productos_recomendados = [...new Set(lista)];
    }
    return { value, errors };
}

/** id_externo en la ruta (envios/:idExterno). */
function validarIdExternoRuta(value) {
    const errors = [];
    const v = validarIdExterno(value, { obligatorio: true }, errors);
    return { value: v, errors };
}

/** Body de PATCH clientes/:id: { no_contactar?, contacto? }. */
function validarClientePatch(body) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = camposDesconocidos(body, ['no_contactar', 'contacto']);
    const value = {};
    if (!('no_contactar' in body) && !('contacto' in body)) {
        errors.push({ campo: 'body', error: 'Mandá al menos uno de: no_contactar, contacto' });
    }
    if ('no_contactar' in body) {
        if (typeof body.no_contactar === 'boolean') value.no_contactar = body.no_contactar;
        else errors.push({ campo: 'no_contactar', error: 'Tiene que ser true o false' });
    }
    if ('contacto' in body) {
        if (body.contacto === null) value.contacto = null;
        else if (typeof body.contacto !== 'string') errors.push({ campo: 'contacto', error: 'Tiene que ser texto o null' });
        else if (body.contacto.trim().length > CONTACTO_MAX) errors.push({ campo: 'contacto', error: `Máximo ${CONTACTO_MAX} caracteres` });
        else value.contacto = body.contacto.trim() || null;
    }
    return { value, errors };
}

/** Body de POST feedback: { tipo, endpoint?, mensaje }. Lo que Grok quiere que cambie. */
function validarFeedback(body) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = camposDesconocidos(body, ['tipo', 'endpoint', 'mensaje']);
    const value = {};
    if (FEEDBACK_TIPOS.includes(body.tipo)) value.tipo = body.tipo;
    else errors.push({ campo: 'tipo', error: `Es obligatorio y tiene que ser uno de: ${FEEDBACK_TIPOS.join(', ')}` });
    value.mensaje = validarTexto('mensaje', body.mensaje, { obligatorio: true }, errors);
    if (body.endpoint !== undefined && body.endpoint !== null) {
        if (typeof body.endpoint !== 'string' || body.endpoint.length > 200) {
            errors.push({ campo: 'endpoint', error: 'Tiene que ser texto de hasta 200 caracteres' });
        } else value.endpoint = body.endpoint.trim() || null;
    } else value.endpoint = null;
    return { value, errors };
}

module.exports = {
    LIMIT_DEFAULT,
    LIMIT_MAX,
    TEXTO_MAX,
    FEEDBACK_TIPOS,
    parseIso,
    esFechaSimple,
    validarDias,
    validarPaginacion,
    validarQueryNuevos,
    validarQueryProductos,
    validarId,
    validarSeguimiento,
    validarInteraccion,
    validarEnvio,
    validarIdExternoRuta,
    validarClientePatch,
    validarFeedback,
};
