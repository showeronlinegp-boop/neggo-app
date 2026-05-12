/**
 * scrapingLogs.js — Buffer en memoria de logs de scraping por runId.
 *
 * Permite que el frontend reciba logs en tiempo real via SSE mientras
 * el script Python (o el orquestador Node) va escribiendo progreso.
 *
 * Ciclo de vida de una entrada:
 *   1. Se crea cuando llega la primera línea (appendLog)
 *   2. Acumula líneas hasta MAX_LINES
 *   3. markDone() notifica fin a todos los suscriptores activos
 *   4. La entrada se limpia automáticamente 10 minutos después de done
 */

const MAX_LINES_PER_RUN = 3000;

// runId (number) → { lines: string[], subscribers: Set<Function>, done: boolean }
const store = new Map();

function _getOrCreate(runId) {
    if (!store.has(runId)) {
        store.set(runId, { lines: [], subscribers: new Set(), done: false });
    }
    return store.get(runId);
}

/**
 * Agrega una línea de log al buffer de un run y notifica a los suscriptores activos.
 * @param {number} runId
 * @param {string} text — puede incluir saltos de línea, se split por línea
 */
function appendLog(runId, text) {
    if (!runId || runId === 'preview') return;

    const entry = _getOrCreate(runId);
    const lines = String(text).split('\n').filter(l => l.trim());

    for (const line of lines) {
        if (entry.lines.length < MAX_LINES_PER_RUN) {
            entry.lines.push(line);
        }
        for (const cb of entry.subscribers) {
            try { cb({ type: 'log', line }); } catch (_) {}
        }
    }
}

/**
 * Marca el run como terminado. Notifica a los suscriptores con { type: 'done' }
 * y limpia el store después de 10 minutos.
 * @param {number} runId
 * @param {'completed'|'failed'|'partial'} status
 */
function markDone(runId, status = 'completed') {
    if (!runId || runId === 'preview') return;

    const entry = store.get(runId);
    if (!entry) return;

    entry.done = true;

    for (const cb of entry.subscribers) {
        try { cb({ type: 'done', status }); } catch (_) {}
    }
    entry.subscribers.clear();

    // Limpiar después de 10 minutos para liberar memoria
    setTimeout(() => store.delete(runId), 10 * 60 * 1000);
}

/**
 * Suscribe un callback a los logs de un run.
 * El callback recibe objetos { type: 'log', line } o { type: 'done', status }.
 * Retorna una función de unsuscripción.
 * @param {number} runId
 * @param {Function} callback
 * @returns {Function} unsubscribe
 */
function subscribe(runId, callback) {
    const entry = _getOrCreate(runId);
    entry.subscribers.add(callback);
    return () => entry.subscribers.delete(callback);
}

/**
 * Retorna el estado actual del buffer para un run.
 * @param {number} runId
 * @returns {{ lines: string[], done: boolean }}
 */
function getLogs(runId) {
    return store.get(runId) || { lines: [], done: false };
}

module.exports = { appendLog, markDone, subscribe, getLogs };
