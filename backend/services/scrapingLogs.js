/**
 * scrapingLogs.js — Logs de scraping por runId, guardados en la base (scraping_run_logs).
 *
 * Los scrapers corren en el contenedor scraper-worker y el frontend lee los logs por SSE desde el
 * backend: la base es el punto de encuentro entre los dos procesos.
 *
 *   - appendLog / markDone: los usa el worker (escritura en lotes cada 500 ms)
 *   - getLogs / subscribe:  los usa el backend (lectura + polling de líneas nuevas)
 *
 * Un run se considera terminado cuando su status en scraping_runs ya no es queued ni running.
 */
const pool = require('../config/database');

const FLUSH_MS = 500;
const POLL_MS = 1000;
const MAX_LINES_INICIALES = 3000; // al conectarse, solo las últimas N líneas

// Escritura en lotes para no hacer un INSERT por línea
let pendientes = [];      // [{ runId, line }]
let flushTimer = null;
let flushEnCurso = Promise.resolve();

function flush() {
    flushTimer = null;
    if (pendientes.length === 0) return flushEnCurso;
    const lote = pendientes;
    pendientes = [];
    flushEnCurso = flushEnCurso.then(() => pool.query(
        `INSERT INTO scraping_run_logs (run_id, line)
         SELECT * FROM unnest($1::int[], $2::text[])`,
        [lote.map(l => l.runId), lote.map(l => l.line)]
    )).catch(err => console.error('⚠️ No se pudieron guardar logs de scraping:', err.message));
    return flushEnCurso;
}

/**
 * Agrega líneas de log a un run.
 * @param {number} runId
 * @param {string} text — puede incluir saltos de línea
 */
function appendLog(runId, text) {
    if (!runId || runId === 'preview') return;
    for (const line of String(text).split('\n')) {
        if (line.trim()) pendientes.push({ runId: Number(runId), line: line.slice(0, 2000) });
    }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/**
 * Fuerza la escritura de lo pendiente. El fin del run lo marca su status en scraping_runs.
 */
function markDone(runId) {
    if (!runId || runId === 'preview') return Promise.resolve();
    if (flushTimer) clearTimeout(flushTimer);
    return flush();
}

async function estadoRun(runId) {
    const { rows } = await pool.query('SELECT status FROM scraping_runs WHERE id = $1', [runId]);
    return rows[0]?.status || null;
}

const terminado = status => !status || !['queued', 'running'].includes(status);

/**
 * Líneas acumuladas de un run (las últimas MAX_LINES_INICIALES).
 * @returns {Promise<{ lines: string[], lastId: number, done: boolean, status: string|null }>}
 */
async function getLogs(runId) {
    const [{ rows }, status] = await Promise.all([
        pool.query(
            `SELECT id, line FROM (
                 SELECT id, line FROM scraping_run_logs WHERE run_id = $1 ORDER BY id DESC LIMIT $2
             ) t ORDER BY id`,
            [runId, MAX_LINES_INICIALES]
        ),
        estadoRun(runId),
    ]);
    return {
        lines: rows.map(r => r.line),
        lastId: rows.length ? Number(rows[rows.length - 1].id) : 0,
        done: terminado(status),
        status,
    };
}

/**
 * Avisa las líneas nuevas desde lastId. El callback recibe { type: 'log', line } o
 * { type: 'done', status }. Retorna la función para desuscribirse.
 */
function subscribe(runId, callback, lastId = 0) {
    let activo = true;
    let ultimo = lastId;

    const tick = async () => {
        if (!activo) return;
        try {
            const { rows } = await pool.query(
                'SELECT id, line FROM scraping_run_logs WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 1000',
                [runId, ultimo]
            );
            for (const r of rows) {
                ultimo = Number(r.id);
                callback({ type: 'log', line: r.line });
            }
            if (rows.length === 0) {
                const status = await estadoRun(runId);
                if (terminado(status)) {
                    activo = false;
                    callback({ type: 'done', status });
                    return;
                }
            }
        } catch (err) {
            console.error('⚠️ Error leyendo logs de scraping:', err.message);
        }
        if (activo) setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);

    return () => { activo = false; };
}

/** Borra logs viejos (los llama el worker al arrancar) */
async function purgeOld(dias = 14) {
    const { rowCount } = await pool.query(
        `DELETE FROM scraping_run_logs WHERE created_at < NOW() - make_interval(days => $1::INTEGER)`, [dias]);
    return rowCount;
}

module.exports = { appendLog, markDone, subscribe, getLogs, purgeOld, flush };
