// API del agente: tareas para Claude Code (investigación, diseño, búsquedas; nunca cambios de
// código de la app). Capa fina sobre tareasBotService: formato de respuesta y errores con código.
// Flujo: crear → ejecutar → (Claude consulta → mensajes → ejecutar)* → acordado → ejecutar → respuesta final.

const pool = require('../config/database');
const tareas = require('./tareasBotService');
const { AgenteError } = require('./agenteService');
const { toArIso } = require('./agenteNuevos');

function isoAr(v) {
    return v ? toArIso(new Date(v)) : null;
}

/** test_notes → tarea para el bot. */
function formatTarea(n) {
    const ctx = n.contexto || {};
    const ej = ctx.ejecucion || {};
    return {
        id: n.id,
        tipo: n.tipo,
        titulo: n.pantalla && n.pantalla.startsWith('Tarea del bot · ') ? n.pantalla.slice('Tarea del bot · '.length) : null,
        estado: n.estado,
        fase: ctx.fase || 'discusion',
        esperando: tareas.esperando(n),
        texto: n.texto,
        respuesta: n.respuesta || null,
        hilo: (ctx.hilo || []).map(m => ({
            autor: m.autor,
            fecha: isoAr(m.fecha),
            texto: m.texto,
            ...(m.estado ? { estado: m.estado } : {}),
            ...(m.acordado ? { acordado: true } : {}),
        })),
        ejecucion: {
            estado: ej.estado || 'sin_pedir',
            pedida_at: isoAr(ej.pedida_at),
            lanzada_at: isoAr(ej.lanzada_at),
        },
        creada: isoAr(n.created_at),
        actualizada: isoAr(n.updated_at),
    };
}

async function conCodigo(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err.codigo && err.statusCode) throw new AgenteError(err.statusCode, err.message, err.codigo);
        throw err;
    }
}

async function crear(value) {
    const n = await tareas.crear(pool, value);
    console.log(`📦 Agente: tarea nueva para Claude → nota #${n.id}`);
    return formatTarea(n);
}

async function obtener(id) {
    return conCodigo(async () => formatTarea(await tareas.obtener(pool, id)));
}

async function listar({ vivas, page, limit, offset }) {
    const { rows, total } = await tareas.listar(pool, { vivas, limit, offset });
    return { data: rows.map(formatTarea), total, page, limit };
}

async function agregarMensaje(id, value) {
    return conCodigo(async () => formatTarea(await tareas.agregarMensaje(pool, id, value)));
}

async function pedirEjecucion(id) {
    return conCodigo(async () => {
        const n = await tareas.pedirEjecucion(pool, id);
        console.log(`📦 Agente: piden ejecutar la tarea #${id} (${n.contexto.fase})`);
        return formatTarea(n);
    });
}

async function cerrar(id, value) {
    return conCodigo(async () => formatTarea(await tareas.cerrar(pool, id, value)));
}

module.exports = {
    crear,
    obtener,
    listar,
    agregarMensaje,
    pedirEjecucion,
    cerrar,
    // Puro, para tests
    formatTarea,
};
