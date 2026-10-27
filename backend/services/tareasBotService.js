// Tareas del bot: notas de prueba que crea el bot por la API del agente para que Claude Code
// haga investigación, diseño o búsquedas (nunca cambios de código de la app).
// Flujo: indicación → discusión → acuerdo → ejecución → respuesta final.
//   - El bot crea la tarea (fase discusion, modo debatir) y pide ejecutarla.
//   - El vigía de Windows (tools/claude-link/vigia-bot.ps1) toma el pedido con
//     scripts/notaPrueba.js bot-siguiente y abre Claude Code con la nota.
//   - Claude contesta (consulta) y el bot sigue la charla con mensajes; con acordado: true la
//     tarea pasa a fase acordada (modo directo) y en la próxima ejecución Claude la hace y
//     deja la respuesta final (para_revisar).
// Todo vive en test_notes; la conversación, la fase y la ejecución van en contexto (JSONB).

const notas = require('./testNotesService');

const AUTOR = 'Bot (tareas)';
const MAX_MENSAJES = 30;
const LOCK_EJECUCION = 9696;
// Una ejecución lanzada que no contestó en este tiempo deja de bloquear a las demás
const BLOQUEO_MIN = 180;
const VENTANA_DIA_MS = 24 * 60 * 60 * 1000;
const ESTADOS_CERRADOS = ['corregida', 'descartada'];

function maxPorDia() {
    const n = parseInt(process.env.AGENTE_TAREAS_MAX_DIA, 10);
    return Number.isInteger(n) && n > 0 ? n : 10;
}

function tareaError(status, message, codigo) {
    const err = new Error(message);
    err.statusCode = status;
    err.codigo = codigo;
    return err;
}

function esTarea(n) {
    return Boolean(n && n.contexto && n.contexto.origen === 'agente' && n.contexto.tarea === true);
}

/** Quién tiene que mover ahora: claude (pendiente de ejecutar o trabajando), bot o nadie. */
function esperando(n) {
    if (ESTADOS_CERRADOS.includes(n.estado)) return 'nadie';
    if (n.estado === 'abierta' || n.estado === 'en_curso') return 'claude';
    return 'bot';
}

async function enTransaccion(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Lee la tarea bloqueándola. 404 si no existe o no es del bot (el bot no ve las notas del equipo). */
async function tomarTarea(client, id) {
    const { rows: [n] } = await client.query('SELECT * FROM test_notes WHERE id = $1 FOR UPDATE', [id]);
    if (!esTarea(n)) throw tareaError(404, 'Tarea inexistente', 'no_encontrado');
    return n;
}

async function guardar(client, id, { contexto, estado, modo }) {
    const sets = ['contexto = $2', 'updated_at = NOW()'];
    const params = [id, JSON.stringify(contexto)];
    if (estado) {
        params.push(estado);
        sets.push(`estado = $${params.length}`);
        sets.push(ESTADOS_CERRADOS.includes(estado) ? 'resuelta_at = NOW()' : 'resuelta_at = NULL');
    }
    if (modo) {
        params.push(modo);
        sets.push(`modo = $${params.length}`);
    }
    await client.query(`UPDATE test_notes SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Crea la tarea con la indicación del bot. Arranca en discusión. */
async function crear(pool, { tipo, texto, titulo }) {
    const ahora = new Date().toISOString();
    return notas.crear(pool, {
        tipo,
        texto,
        modo: ['debatir'],
        pantalla: titulo ? `Tarea del bot · ${titulo}` : 'Tarea del bot',
        contexto: {
            origen: 'agente',
            autor: AUTOR,
            tarea: true,
            fase: 'discusion',
            hilo: [{ autor: 'bot', fecha: ahora, texto }],
            ejecucion: { estado: 'sin_pedir', pedidas: [] },
        },
    }, null);
}

/**
 * El bot sigue la charla. Con acordado: true la tarea pasa a la fase acordada (modo directo):
 * en la próxima ejecución Claude hace lo acordado.
 */
async function agregarMensaje(pool, id, { texto, acordado }) {
    return enTransaccion(pool, async (client) => {
        const n = await tomarTarea(client, id);
        if (ESTADOS_CERRADOS.includes(n.estado)) throw tareaError(409, 'La tarea está cerrada: creá una nueva', 'tarea_cerrada');
        if (n.estado === 'en_curso') throw tareaError(409, 'Claude la está trabajando: esperá su respuesta', 'en_curso');
        const ctx = n.contexto;
        const hilo = Array.isArray(ctx.hilo) ? ctx.hilo : [];
        if (hilo.length >= MAX_MENSAJES) throw tareaError(409, `La conversación llegó a ${MAX_MENSAJES} mensajes: creá una tarea nueva`, 'hilo_lleno');
        hilo.push({ autor: 'bot', fecha: new Date().toISOString(), texto, ...(acordado ? { acordado: true } : {}) });
        const fase = acordado ? 'acordada' : ctx.fase;
        // Un mensaje nuevo deja la ejecución sin pedir: el bot decide cuándo pedirla
        const ejecucion = { ...(ctx.ejecucion || {}), estado: 'sin_pedir' };
        await guardar(client, id, {
            contexto: { ...ctx, hilo, fase, ejecucion },
            estado: 'abierta',
            modo: acordado ? [] : undefined,
        });
        return notas.obtener(client, id);
    });
}

/** Pedidos de ejecución de todas las tareas en las últimas 24 horas. */
async function pedidasUltimoDia(client, ahora) {
    const { rows } = await client.query(
        `SELECT contexto->'ejecucion'->'pedidas' AS pedidas FROM test_notes
         WHERE contexto->>'tarea' = 'true' AND updated_at >= NOW() - INTERVAL '2 days'`);
    return rows.flatMap(r => Array.isArray(r.pedidas) ? r.pedidas : [])
        .filter(f => ahora - new Date(f).getTime() < VENTANA_DIA_MS).length;
}

/**
 * El bot pide que Claude trabaje la tarea. Solo si hay algo nuevo para Claude (estado abierta),
 * no está ya pedida y no se pasó del máximo diario.
 */
async function pedirEjecucion(pool, id) {
    return enTransaccion(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_EJECUCION]);
        const n = await tomarTarea(client, id);
        const ctx = n.contexto;
        const ejecucion = ctx.ejecucion || {};
        if (ESTADOS_CERRADOS.includes(n.estado)) throw tareaError(409, 'La tarea está cerrada: creá una nueva', 'tarea_cerrada');
        if (n.estado === 'en_curso') throw tareaError(409, 'Claude ya la está trabajando', 'en_curso');
        if (n.estado !== 'abierta') {
            throw tareaError(409, 'No hay nada nuevo para Claude: contestale con POST /notas/{id}/mensajes antes de pedir otra ejecución', 'sin_novedad');
        }
        // Abierta y lanzada: Claude ya la abrió y todavía no la tomó
        if (ejecucion.estado === 'lanzada') throw tareaError(409, 'Claude ya la está trabajando', 'en_curso');
        if (ejecucion.estado === 'pedida') throw tareaError(409, 'Ya está pedida: esperá que Claude la tome', 'ya_pedida');
        const ahora = Date.now();
        const max = maxPorDia();
        if (await pedidasUltimoDia(client, ahora) >= max) {
            throw tareaError(429, `Se llegó al máximo de ${max} ejecuciones en 24 horas`, 'limite_diario');
        }
        const pedidas = [...(ejecucion.pedidas || []), new Date(ahora).toISOString()].slice(-50);
        await guardar(client, id, {
            contexto: { ...ctx, ejecucion: { ...ejecucion, estado: 'pedida', pedida_at: new Date(ahora).toISOString(), pedidas } },
        });
        return notas.obtener(client, id);
    });
}

/**
 * Para el vigía: toma la tarea pedida más vieja y la marca lanzada. De a una: si hay otra
 * lanzada sin contestar (de las últimas 3 horas), no devuelve nada. Devuelve el id o null.
 */
async function tomarSiguiente(pool) {
    return enTransaccion(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_EJECUCION]);
        const { rows: [ocupada] } = await client.query(
            `SELECT id FROM test_notes
             WHERE contexto->>'tarea' = 'true'
               AND contexto->'ejecucion'->>'estado' = 'lanzada'
               AND estado IN ('abierta', 'en_curso')
               AND (contexto->'ejecucion'->>'lanzada_at')::timestamptz > NOW() - make_interval(mins => $1)
             LIMIT 1`, [BLOQUEO_MIN]);
        if (ocupada) return null;
        const { rows: [n] } = await client.query(
            `SELECT * FROM test_notes
             WHERE contexto->>'tarea' = 'true'
               AND contexto->'ejecucion'->>'estado' = 'pedida'
               AND estado = 'abierta'
             ORDER BY (contexto->'ejecucion'->>'pedida_at')::timestamptz
             LIMIT 1
             FOR UPDATE`);
        if (!n) return null;
        await guardar(client, n.id, {
            contexto: { ...n.contexto, ejecucion: { ...n.contexto.ejecucion, estado: 'lanzada', lanzada_at: new Date().toISOString() } },
        });
        return n.id;
    });
}

/** El bot cierra la tarea: ok (corregida) o descartada. */
async function cerrar(pool, id, { resultado }) {
    return enTransaccion(pool, async (client) => {
        const n = await tomarTarea(client, id);
        if (n.estado === 'en_curso') throw tareaError(409, 'Claude la está trabajando: esperá su respuesta', 'en_curso');
        const ejecucion = { ...(n.contexto.ejecucion || {}), estado: 'sin_pedir' };
        await guardar(client, id, {
            contexto: { ...n.contexto, ejecucion },
            estado: resultado === 'descartada' ? 'descartada' : 'corregida',
        });
        return notas.obtener(client, id);
    });
}

async function obtener(pool, id) {
    const n = await notas.obtener(pool, id);
    if (!esTarea(n)) throw tareaError(404, 'Tarea inexistente', 'no_encontrado');
    return n;
}

async function listar(pool, { vivas, limit, offset }) {
    const where = [`n.contexto->>'tarea' = 'true'`];
    if (vivas) where.push(`n.estado <> ALL('{corregida,descartada}'::text[])`);
    const { rows: [count] } = await pool.query(`SELECT COUNT(*)::int AS total FROM test_notes n WHERE ${where.join(' AND ')}`);
    const { rows } = await pool.query(
        `SELECT n.* FROM test_notes n WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT $1 OFFSET $2`,
        [limit, offset]);
    return { rows, total: count.total };
}

module.exports = {
    AUTOR,
    MAX_MENSAJES,
    esTarea,
    esperando,
    crear,
    agregarMensaje,
    pedirEjecucion,
    tomarSiguiente,
    cerrar,
    obtener,
    listar,
};
