// Preguntas frecuentes del CRM y los mensajes que van como respuesta (066). Las carga el equipo en
// Clientes › Respuestas; Grok las lee por GET /api/agente/respuestas. Validación en crmRespuestas.js.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { validarRespuesta, usables } = require('./crmRespuestas');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '066_crm_respuestas.sql'), 'utf8');

let schemaReady = null;
function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

class RespuestaError extends Error {
    constructor(message, status = 400, errors = null) {
        super(message);
        this.status = status;
        this.errors = errors;
    }
}

function formatear(r) {
    return {
        id: r.id,
        pregunta: r.pregunta,
        respuesta: r.respuesta,
        informar_a_todos: r.informar_a_todos,
        activa: r.activa,
        orden: r.orden,
        actualizado_at: r.updated_at,
    };
}

/** Todas, en el orden en que se muestran. */
async function listar(db = pool) {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM crm_respuestas ORDER BY orden, id');
    return rows.map(formatear);
}

/** Solo las que se pueden mandar (activas y con texto), para el agente. */
async function listarUsables(db = pool) {
    return usables(await listar(db));
}

function validar(body, opts) {
    const { value, errors } = validarRespuesta(body, opts);
    if (errors.length) throw new RespuestaError(errors[0].error, 422, errors);
    return value;
}

async function crear(body, userId, db = pool) {
    const v = validar(body);
    await ensureSchema(db);
    const { rows: [r] } = await db.query(
        `INSERT INTO crm_respuestas (pregunta, respuesta, informar_a_todos, activa, orden, updated_by)
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(orden), 0) + 1 FROM crm_respuestas), $5)
         RETURNING *`,
        [v.pregunta, v.respuesta || '', v.informar_a_todos ?? false, v.activa ?? true, userId || null],
    );
    return formatear(r);
}

async function editar(id, body, userId, db = pool) {
    const v = validar(body, { parcial: true });
    await ensureSchema(db);
    const { rows: [r] } = await db.query(
        `UPDATE crm_respuestas
            SET pregunta = COALESCE($2, pregunta),
                respuesta = COALESCE($3, respuesta),
                informar_a_todos = COALESCE($4, informar_a_todos),
                activa = COALESCE($5, activa),
                updated_by = $6, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, v.pregunta ?? null, v.respuesta ?? null, v.informar_a_todos ?? null, v.activa ?? null, userId || null],
    );
    if (!r) throw new RespuestaError('No existe esa pregunta', 404);
    return formatear(r);
}

async function borrar(id, db = pool) {
    await ensureSchema(db);
    const { rowCount } = await db.query('DELETE FROM crm_respuestas WHERE id = $1', [id]);
    if (!rowCount) throw new RespuestaError('No existe esa pregunta', 404);
    return { id };
}

/** Sube (-1) o baja (+1) una pregunta un lugar. Devuelve la lista en el orden nuevo. */
async function mover(id, direccion, db = pool) {
    if (direccion !== -1 && direccion !== 1) throw new RespuestaError('La dirección tiene que ser -1 o 1', 422);
    const lista = await listar(db);
    const i = lista.findIndex((r) => r.id === id);
    if (i === -1) throw new RespuestaError('No existe esa pregunta', 404);
    const j = i + direccion;
    if (j < 0 || j >= lista.length) return lista;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    // Renumera todo: así no quedan empates aunque alguien haya cargado varias a la vez
    await db.query(
        `UPDATE crm_respuestas c SET orden = v.orden
           FROM unnest($1::int[]) WITH ORDINALITY AS v(id, orden)
          WHERE c.id = v.id`,
        [lista.map((r) => r.id)],
    );
    return listar(db);
}

module.exports = { ensureSchema, listar, listarUsables, crear, editar, borrar, mover, RespuestaError };
