// Preguntas frecuentes del CRM (066): validación pura. Tests en crmRespuestas.test.js.
// La lectura y el guardado están en crmRespuestasService.js.

const PREGUNTA_MAX = 200;
const RESPUESTA_MAX = 4000;

/**
 * Body de alta o edición: { pregunta, respuesta?, informar_a_todos?, activa? }.
 * En la edición (parcial = true) todo es opcional, pero tiene que venir algo.
 * @returns {{ value: object, errors: Array<{ campo: string, error: string }> }}
 */
function validarRespuesta(body, { parcial = false } = {}) {
    const errors = [];
    const value = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { value, errors: [{ campo: 'body', error: 'Tiene que ser un objeto JSON' }] };
    }
    if (body.pregunta !== undefined || !parcial) {
        const p = typeof body.pregunta === 'string' ? body.pregunta.trim() : '';
        if (!p) errors.push({ campo: 'pregunta', error: 'Escribí la pregunta' });
        else if (p.length > PREGUNTA_MAX) errors.push({ campo: 'pregunta', error: `Máximo ${PREGUNTA_MAX} caracteres` });
        else value.pregunta = p;
    }
    if (body.respuesta !== undefined && body.respuesta !== null) {
        if (typeof body.respuesta !== 'string') errors.push({ campo: 'respuesta', error: 'Tiene que ser texto' });
        else {
            // Se respetan los renglones (van tal cual al WhatsApp); solo se sacan los espacios de los bordes
            const r = body.respuesta.replace(/\r\n/g, '\n').trim();
            if (r.length > RESPUESTA_MAX) errors.push({ campo: 'respuesta', error: `Máximo ${RESPUESTA_MAX} caracteres` });
            else value.respuesta = r;
        }
    }
    for (const campo of ['informar_a_todos', 'activa']) {
        if (body[campo] === undefined) continue;
        if (typeof body[campo] !== 'boolean') errors.push({ campo, error: 'Tiene que ser true o false' });
        else value[campo] = body[campo];
    }
    if (parcial && !errors.length && !Object.keys(value).length) {
        errors.push({ campo: 'body', error: 'No hay nada para cambiar' });
    }
    return { value, errors };
}

/** Las que se pueden usar: activas y con texto de respuesta. */
function usables(respuestas) {
    return (respuestas || []).filter((r) => r.activa && String(r.respuesta || '').trim());
}

module.exports = { PREGUNTA_MAX, RESPUESTA_MAX, validarRespuesta, usables };
