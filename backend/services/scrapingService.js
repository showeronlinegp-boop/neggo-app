const { getScraperForSupplier, SCRAPER_REGISTRY } = require('../scrapers/registry');
const PythonScraper = require('../scrapers/pythonScraper');
const pool = require('../config/database');
const scrapingLogs = require('./scrapingLogs');

// =============================================
// Arquitectura
// =============================================
// Los scrapers corren en el contenedor scraper-worker (worker.js), no en el backend:
// reiniciar el backend no corta ningún scraping.
//
//   backend → enqueueRun()                       INSERT scraping_runs (status 'queued')
//   worker  → claimNextRun() + executeRun()      'queued' → 'running' → completed / partial / failed / paused
//   backend → pauseScraper() / stopScraper()     UPDATE scraping_runs SET control = 'pause' | 'stop'
//   worker  → applyControls()                    mata el proceso Python del run pedido
//
// El preview (dry-run por SSE) sigue corriendo en el backend: es corto y no guarda nada.

/**
 * Corta si el proveedor tiene el scraping pausado (suppliers.scrape_enabled = false).
 * El preview (dry-run) no pasa por acá: se puede previsualizar aunque esté pausado.
 */
function assertScrapeEnabled(supplier) {
    if (!supplier.scrape_enabled) {
        const err = new Error(`El scraping de "${supplier.name}" está pausado. Activalo desde Proveedores para poder scrapear.`);
        err.statusCode = 409;
        throw err;
    }
}

function parseConfig(supplier) {
    if (typeof supplier.scrape_config === 'string') {
        try { supplier.scrape_config = JSON.parse(supplier.scrape_config); } catch (_) { supplier.scrape_config = {}; }
    }
    return supplier;
}

/**
 * Valida el proveedor y devuelve la fila lista para scrapear.
 */
async function getScrapeableSupplier(db, supplierId) {
    const { rows } = await db.query(
        `SELECT * FROM suppliers WHERE id = $1 AND active = true`,
        [supplierId]
    );
    if (rows.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado, inactivo o deshabilitado`);
        err.statusCode = 404;
        throw err;
    }
    const supplier = parseConfig(rows[0]);
    assertScrapeEnabled(supplier);
    if (!supplier.scraper_key || !SCRAPER_REGISTRY[supplier.scraper_key]) {
        const err = new Error(`No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`);
        err.statusCode = 400;
        throw err;
    }
    return supplier;
}

// =============================================
// Backend: encolar y controlar
// =============================================

/**
 * Encola un run para que lo ejecute el scraper-worker. Responde enseguida con el runId;
 * el cliente hace polling a GET /api/scraping/runs/:runId mientras status sea queued/running.
 *
 * @param {object} db
 * @param {number} supplierId
 * @param {number|null} triggeredBy — usuario, o null si es automático (scheduler)
 * @param {object} [opts]
 * @param {number} [opts.resumeFrom] — run pausado desde el que se reanuda
 * @returns {{ runId, status: 'queued', supplierName }}
 */
async function enqueueRun(db, supplierId, triggeredBy, { resumeFrom = null } = {}) {
    const supplier = await getScrapeableSupplier(db, supplierId);

    const { rows: activos } = await db.query(
        `SELECT id, status FROM scraping_runs WHERE supplier_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
        [supplierId]
    );
    if (activos.length > 0) {
        const err = new Error(`"${supplier.name}" ya tiene un scraping ${activos[0].status === 'queued' ? 'en cola' : 'corriendo'} (run ${activos[0].id})`);
        err.statusCode = 409;
        throw err;
    }

    const { rows } = await db.query(
        `INSERT INTO scraping_runs (supplier_id, status, triggered_by, resume_from, started_at)
         VALUES ($1, 'queued', $2, $3, NOW()) RETURNING id`,
        [supplierId, triggeredBy || null, resumeFrom]
    );
    const runId = rows[0].id;
    scrapingLogs.appendLog(runId, `📦 En cola: "${supplier.name}" — lo toma el scraper-worker en unos segundos`);
    console.log(`📦 Run ${runId} encolado para "${supplier.name}"${resumeFrom ? ` (reanuda run ${resumeFrom})` : ''}`);
    return { runId, status: 'queued', supplierName: supplier.name };
}

// Compatibilidad con la ruta POST /api/scraping/:supplierId/run
async function startScraperAsync(db, supplierId, triggeredBy) {
    return enqueueRun(db, supplierId, triggeredBy);
}

/**
 * Reanuda el último run pausado del proveedor: encola uno nuevo que saltea las categorías
 * ya completadas (y retoma la página del checkpoint).
 */
async function resumeScraper(db, supplierId, triggeredBy) {
    const { rows: pausedRuns } = await db.query(
        `SELECT id, completed_categories FROM scraping_runs
         WHERE supplier_id = $1 AND status = 'paused'
         ORDER BY started_at DESC LIMIT 1`,
        [supplierId]
    );
    if (pausedRuns.length === 0) {
        const err = new Error(`No hay ningún run pausado para el proveedor ${supplierId}`);
        err.statusCode = 404;
        throw err;
    }
    const paused = pausedRuns[0];
    const result = await enqueueRun(db, supplierId, triggeredBy, { resumeFrom: paused.id });
    return {
        ...result,
        resumedFrom: paused.id,
        skippedCategories: (paused.completed_categories || []).length,
    };
}

/**
 * Pide pausar un run. Si está en cola se pausa directo; si está corriendo lo corta el worker.
 */
async function pauseScraper(runId) {
    const { rowCount: enCola } = await pool.query(
        `UPDATE scraping_runs SET status = 'paused', finished_at = NOW() WHERE id = $1 AND status = 'queued'`,
        [runId]
    );
    if (enCola) {
        scrapingLogs.appendLog(runId, '⏸ Pausado antes de empezar');
        return { paused: true, message: `Run ${runId} pausado` };
    }
    const { rowCount } = await pool.query(
        `UPDATE scraping_runs SET control = 'pause' WHERE id = $1 AND status = 'running'`, [runId]);
    if (rowCount) {
        scrapingLogs.appendLog(runId, '⏸ Pausa pedida — el worker corta el proceso en unos segundos');
        return { paused: true, message: `Run ${runId} pausándose` };
    }
    return { paused: false, message: `Run ${runId} no estaba activo` };
}

/**
 * Pide cancelar un run (no se puede reanudar).
 */
async function stopScraper(runId) {
    const { rowCount: enCola } = await pool.query(
        `UPDATE scraping_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND status = 'queued'`,
        [runId]
    );
    if (enCola) {
        scrapingLogs.appendLog(runId, '🛑 Cancelado antes de empezar');
        return { stopped: true, message: `Run ${runId} cancelado` };
    }
    const { rowCount } = await pool.query(
        `UPDATE scraping_runs SET control = 'stop' WHERE id = $1 AND status = 'running'`, [runId]);
    if (rowCount) {
        scrapingLogs.appendLog(runId, '🛑 Cancelación pedida — el worker corta el proceso en unos segundos');
        return { stopped: true, message: `Run ${runId} cancelándose` };
    }
    return { stopped: false, message: `Run ${runId} no estaba activo` };
}

/**
 * Emergencia: cancela todo lo encolado/pausado y pide cortar todo lo que está corriendo.
 */
async function cancelAll(db) {
    const { rows: directos } = await db.query(
        `UPDATE scraping_runs SET status = 'cancelled', finished_at = NOW()
         WHERE status IN ('queued', 'paused') RETURNING id`
    );
    const { rows: corriendo } = await db.query(
        `UPDATE scraping_runs SET control = 'stop' WHERE status = 'running' RETURNING id`
    );
    for (const run of [...directos, ...corriendo]) {
        scrapingLogs.appendLog(run.id, '🛑 Cancelado por admin (force cancel-all)');
    }
    console.log(`🛑 cancel-all: ${directos.length} runs cancelados, ${corriendo.length} pedidos al worker`);
    return { killed: corriendo.length, cancelledRuns: directos.length + corriendo.length };
}

/**
 * Cuántos runs hay corriendo y en cola (sale de la base: los ejecuta el worker).
 */
async function getRunningCount(db = pool) {
    const { rows } = await db.query(
        `SELECT status, array_agg(id ORDER BY id) AS ids FROM scraping_runs
         WHERE status IN ('queued', 'running') GROUP BY status`
    );
    const running = rows.find(r => r.status === 'running');
    const queued = rows.find(r => r.status === 'queued');
    return {
        running: running ? running.ids.length : 0,
        queued: queued ? queued.ids.length : 0,
        activeRunIds: running ? running.ids : [],
    };
}

// =============================================
// Worker: tomar runs de la cola y ejecutarlos
// =============================================

/**
 * Toma el run en cola más viejo (FOR UPDATE SKIP LOCKED: seguro con más de un worker).
 * @returns {object|null} el run, ya en status 'running'
 */
async function claimNextRun(db) {
    const { rows } = await db.query(`
        UPDATE scraping_runs SET status = 'running', started_at = NOW()
        WHERE id = (
            SELECT id FROM scraping_runs WHERE status = 'queued'
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING *`);
    return rows[0] || null;
}

/**
 * Ejecuta un run ya tomado por el worker. Resuelve cuando termina (cualquiera sea el resultado).
 */
async function executeRun(db, run) {
    let supplier;
    try {
        const { rows } = await db.query('SELECT * FROM suppliers WHERE id = $1', [run.supplier_id]);
        if (rows.length === 0) throw new Error(`Proveedor ${run.supplier_id} no existe`);
        supplier = parseConfig(rows[0]);
        if (!supplier.scrape_enabled) throw new Error(`El scraping de "${supplier.name}" está pausado`);

        const scraper = getScraperForSupplier(supplier, db);
        if (!scraper) throw new Error(`No hay scraper disponible para "${supplier.name}" (key: "${supplier.scraper_key}")`);

        // Usar el run ya creado por enqueueRun (no crear otro)
        scraper.createRun = async () => {
            scraper.runId = run.id;
            return run.id;
        };

        // Reanudación: saltear categorías completadas y retomar la página del checkpoint
        if (run.resume_from) {
            const { rows: prev } = await db.query(
                'SELECT completed_categories, checkpoint FROM scraping_runs WHERE id = $1', [run.resume_from]);
            const completed = prev[0]?.completed_categories || [];
            const checkpoint = prev[0]?.checkpoint || null;
            const original = scraper.pythonEnv || {};
            Object.defineProperty(scraper, 'pythonEnv', {
                get: () => ({
                    ...original,
                    SKIP_CATEGORIES: JSON.stringify(completed),
                    ...(checkpoint ? { RESUME_CATEGORY: checkpoint.category, RESUME_PAGE: String(checkpoint.page) } : {}),
                }),
            });
            // Arrastrar las categorías ya hechas para que una nueva pausa siga acumulando
            await db.query('UPDATE scraping_runs SET completed_categories = $1 WHERE id = $2',
                [JSON.stringify(completed), run.id]);
            scrapingLogs.appendLog(run.id, `▶ Reanudando run ${run.resume_from}: saltea ${completed.length} categorías`
                + (checkpoint ? `, retoma "${checkpoint.category}" desde la página ${checkpoint.page + 1}` : ''));
        }

        console.log(`📦 Worker: iniciando "${supplier.name}" (run ${run.id})`);
        const result = await scraper.run(run.triggered_by);
        console.log(`✅ Worker: "${supplier.name}" terminó (run ${run.id}): ${result.status}, ${result.found} productos`);
    } catch (err) {
        console.error(`❌ Worker: run ${run.id}${supplier ? ` de "${supplier.name}"` : ''} falló: ${err.message}`);
        scrapingLogs.appendLog(run.id, `❌ ${err.message}`);
        await db.query(
            `UPDATE scraping_runs SET status = 'failed', finished_at = NOW(),
                 errors = COALESCE(errors, '[]'::jsonb) || $2::jsonb
             WHERE id = $1 AND status = 'running'`,
            [run.id, JSON.stringify([{ phase: 'worker', error: err.message }])]
        ).catch(() => {});
    } finally {
        // Si se pidió cancelar, el run termina como 'cancelled' (el scraper lo deja 'paused' al cortarlo)
        const { rows } = await db.query(
            `UPDATE scraping_runs SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW())
             WHERE id = $1 AND control = 'stop' RETURNING id`, [run.id]).catch(() => ({ rows: [] }));
        if (rows.length) scrapingLogs.appendLog(run.id, '🛑 Scraping cancelado');
        await db.query('UPDATE scraping_runs SET control = NULL WHERE id = $1', [run.id]).catch(() => {});
        await scrapingLogs.markDone(run.id);
    }
}

/**
 * Corta los procesos de los runs del worker que tienen pausa o cancelación pedida.
 * @param {number[]} runIds — runs que está ejecutando este worker
 */
async function applyControls(db, runIds) {
    if (runIds.length === 0) return;
    const { rows } = await db.query(
        `SELECT id, control FROM scraping_runs
         WHERE id = ANY($1::int[]) AND status = 'running' AND control IS NOT NULL`, [runIds]);
    for (const r of rows) {
        if (PythonScraper.killProcess(r.id)) {
            console.log(`${r.control === 'stop' ? '🛑' : '⏸'} Worker: corté el proceso del run ${r.id} (${r.control})`);
        }
    }
}

/**
 * Al arrancar el worker: los runs que quedaron 'running' (worker anterior cortado) pasan a
 * 'paused' para poder reanudarlos desde la última categoría completada.
 */
async function workerStartupCleanup(db) {
    const { rows } = await db.query(
        `UPDATE scraping_runs SET status = 'paused', control = NULL, finished_at = NOW()
         WHERE status = 'running' RETURNING id`
    );
    for (const run of rows) {
        scrapingLogs.appendLog(run.id, '⏸ Pausado: el scraper-worker se reinició. Se puede reanudar desde la última categoría completa.');
    }
    if (rows.length > 0) {
        console.log(`⚠️ Worker: ${rows.length} run(s) cortados por un reinicio quedaron pausados: ${rows.map(r => r.id).join(', ')}`);
    }
    await scrapingLogs.markDone(rows[0]?.id);
    return rows.map(r => r.id);
}

// =============================================
// Consultas e historial
// =============================================

async function getRunHistory(db, { supplierId, status, limit = 50 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (supplierId) {
        conditions.push(`sr.supplier_id = $${idx++}`);
        params.push(supplierId);
    }
    if (status) {
        conditions.push(`sr.status = $${idx++}`);
        params.push(status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit, 10) || 50);

    const { rows } = await db.query(`
        SELECT
            sr.id, sr.supplier_id, s.name AS supplier_name, sr.status,
            sr.products_found, sr.products_new, sr.products_updated, sr.price_changes,
            sr.triggered_by, sr.started_at, sr.finished_at,
            EXTRACT(EPOCH FROM (sr.finished_at - sr.started_at))::int AS duration_seconds
        FROM scraping_runs sr
        JOIN suppliers s ON s.id = sr.supplier_id
        ${where}
        ORDER BY sr.started_at DESC
        LIMIT $${idx}
    `, params);
    return rows;
}

async function getRunDetail(db, runId) {
    const { rows } = await db.query(
        `SELECT sr.*, s.name AS supplier_name, s.scraper_key,
                EXTRACT(EPOCH FROM (sr.finished_at - sr.started_at))::int AS duration_seconds
         FROM scraping_runs sr
         JOIN suppliers s ON s.id = sr.supplier_id
         WHERE sr.id = $1`,
        [runId]
    );
    if (rows.length === 0) return null;
    const run = rows[0];
    if (typeof run.errors === 'string') {
        try { run.errors = JSON.parse(run.errors); } catch (_) { run.errors = []; }
    }
    return run;
}

// =============================================
// Preview (dry-run) — corre en el backend
// =============================================

/**
 * Corre el scraper en modo dry-run (preview) en el proceso del backend.
 * Llama a onProduct(product) por cada producto encontrado — ideal para SSE. No guarda nada.
 */
async function previewScraper(supplierId, onProduct, triggeredBy = null) {
    const { rows: suppliers } = await pool.query(
        'SELECT * FROM suppliers WHERE id = $1 AND active = true',
        [supplierId]
    );
    if (suppliers.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado o inactivo`);
        err.statusCode = 404;
        throw err;
    }
    const supplier = parseConfig(suppliers[0]);

    if (!supplier.scraper_key || !SCRAPER_REGISTRY[supplier.scraper_key]) {
        const err = new Error(`No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`);
        err.statusCode = 400;
        throw err;
    }

    const ScraperClass = SCRAPER_REGISTRY[supplier.scraper_key];
    const scraper = new ScraperClass(supplier, pool, { dryRun: true, onProduct });

    console.log(`📦 [DRY-RUN] Iniciando preview para "${supplier.name}"`);
    const result = await scraper.run(triggeredBy);
    console.log(`✅ [DRY-RUN] Preview de "${supplier.name}" finalizado: ${result.found} productos`);
    return result;
}

module.exports = {
    // Backend
    enqueueRun,
    startScraperAsync,
    resumeScraper,
    pauseScraper,
    stopScraper,
    cancelAll,
    getRunningCount,
    getRunHistory,
    getRunDetail,
    previewScraper,
    // Worker
    claimNextRun,
    executeRun,
    applyControls,
    workerStartupCleanup,
};
