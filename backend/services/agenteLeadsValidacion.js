// Validación de los pedidos de la API del agente para posibles clientes (/api/agente/leads).
// Sin base. Tests en agenteLeads.test.js. Errores como en agenteValidacion: [{ campo, error }].

const v = require('./agenteValidacion');
const leads = require('./agenteLeads');

const ID_EXTERNO_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const CONTACTO_MAX = 200;
const NOTA_MAX = 500;
const FUTURO_MAX_MS = 5 * 60 * 1000;
// Los mensajes no hablan del IVA ni de impuestos: los precios son finales (nota #93)
const MENCIONA_IVA_RE = /\b(?:iva|i\.v\.a|impuestos?)\b/i;

function esObjeto(body) {
    return body && typeof body === 'object' && !Array.isArray(body);
}

function desconocidos(body, permitidos) {
    return Object.keys(body).filter((k) => !permitidos.includes(k)).map((campo) => ({ campo, error: 'Campo desconocido' }));
}

function texto(campo, value, { obligatorio, max = v.TEXTO_MAX }, errors) {
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
    else if (s.includes('�')) errors.push({ campo, error: 'Tiene caracteres inválidos: mandalo en UTF-8' });
    else if (s.length > max) errors.push({ campo, error: `Máximo ${max} caracteres` });
    return s || null;
}

function idExterno(value, { obligatorio }, errors) {
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

function booleano(query, campo, errors) {
    const value = query[campo];
    if (value === undefined || value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    errors.push({ campo, error: 'Tiene que ser true o false' });
    return undefined;
}

/** GET leads: ?para_hoy=&con_respuesta_pendiente=&respondio=&etapa=&resultado=&no_contactar=false|true|todos&page=&limit= */
function validarQueryLeads(query = {}) {
    const pag = v.validarPaginacion(query);
    const errors = [...pag.errors];
    const value = { ...pag.value };
    value.para_hoy = booleano(query, 'para_hoy', errors);
    value.con_respuesta_pendiente = booleano(query, 'con_respuesta_pendiente', errors);
    value.respondio = booleano(query, 'respondio', errors);
    if (query.etapa) {
        if (leads.ETAPAS.includes(query.etapa)) value.etapa = query.etapa;
        else errors.push({ campo: 'etapa', error: `Tiene que ser uno de: ${leads.ETAPAS.join(', ')}` });
    }
    if (query.resultado) {
        const validos = [...leads.RESULTADOS, 'ninguno'];
        if (validos.includes(query.resultado)) value.resultado = query.resultado;
        else errors.push({ campo: 'resultado', error: `Tiene que ser uno de: ${validos.join(', ')}` });
    }
    const nc = query.no_contactar;
    if (nc === undefined || nc === '') value.no_contactar = undefined;
    else if (nc === 'todos') value.no_contactar = null;
    else if (nc === 'true' || nc === 'false') value.no_contactar = nc === 'true';
    else errors.push({ campo: 'no_contactar', error: 'Tiene que ser true, false o todos' });
    return { value, errors };
}

/** POST leads/:id/envios: { etapa, mensaje, id_externo }. */
function validarEnvioLead(body) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = desconocidos(body, ['etapa', 'mensaje', 'id_externo']);
    const value = {};
    if (leads.ETAPAS_ENVIO.includes(body.etapa)) value.etapa = body.etapa;
    else errors.push({ campo: 'etapa', error: `Es obligatorio y tiene que ser uno de: ${leads.ETAPAS_ENVIO.join(', ')}` });
    value.mensaje = texto('mensaje', body.mensaje, { obligatorio: true }, errors);
    if (value.mensaje && MENCIONA_IVA_RE.test(value.mensaje)) {
        errors.push({ campo: 'mensaje', error: 'No menciones el IVA ni impuestos: los precios son finales' });
    }
    value.id_externo = idExterno(body.id_externo, { obligatorio: true }, errors);
    return { value, errors };
}

/** POST leads/:id/mensajes: { tipo, mensaje, fecha?, id_externo? }. */
function validarMensajeLead(body, now = new Date()) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const errors = desconocidos(body, ['tipo', 'mensaje', 'fecha', 'id_externo']);
    const value = { fecha: now };
    if (['enviado', 'recibido'].includes(body.tipo)) value.tipo = body.tipo;
    else errors.push({ campo: 'tipo', error: 'Es obligatorio y tiene que ser enviado o recibido' });
    value.mensaje = texto('mensaje', body.mensaje, { obligatorio: true }, errors);
    value.id_externo = idExterno(body.id_externo, { obligatorio: false }, errors);
    if (body.fecha !== undefined && body.fecha !== null) {
        const d = v.parseIso(body.fecha);
        if (!d) errors.push({ campo: 'fecha', error: 'Tiene que ser una fecha ISO 8601 (YYYY-MM-DDTHH:mm:ss-03:00)' });
        else if (d.getTime() > now.getTime() + FUTURO_MAX_MS) errors.push({ campo: 'fecha', error: 'No puede ser una fecha futura' });
        else value.fecha = d;
    }
    return { value, errors };
}

/** PATCH leads/:id: { no_contactar?, contacto?, resultado?, nota? }. */
function validarLeadPatch(body) {
    if (!esObjeto(body)) return { value: null, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    const permitidos = ['no_contactar', 'contacto', 'resultado', 'nota'];
    const errors = desconocidos(body, permitidos);
    const value = {};
    if (!['no_contactar', 'contacto', 'resultado'].some((k) => k in body)) {
        errors.push({ campo: 'body', error: 'Mandá al menos uno de: no_contactar, contacto, resultado' });
    }
    if ('no_contactar' in body) {
        if (typeof body.no_contactar === 'boolean') value.no_contactar = body.no_contactar;
        else errors.push({ campo: 'no_contactar', error: 'Tiene que ser true o false' });
    }
    if ('contacto' in body) {
        if (body.contacto === null) value.contacto = null;
        else value.contacto = texto('contacto', body.contacto, { obligatorio: false, max: CONTACTO_MAX }, errors);
    }
    if ('resultado' in body) {
        if (leads.RESULTADOS_AGENTE.includes(body.resultado)) value.resultado = body.resultado;
        else errors.push({ campo: 'resultado', error: `Tiene que ser uno de: ${leads.RESULTADOS_AGENTE.join(', ')} (para no contactar usá no_contactar: true)` });
    }
    if (value.resultado && value.no_contactar === true) {
        errors.push({ campo: 'resultado', error: 'No mandes resultado junto con no_contactar: true' });
    }
    value.nota = texto('nota', body.nota, { obligatorio: false, max: NOTA_MAX }, errors);
    return { value, errors };
}

module.exports = {
    validarQueryLeads,
    validarEnvioLead,
    validarMensajeLead,
    validarLeadPatch,
};
