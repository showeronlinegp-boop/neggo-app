const { getScraperForSupplier, SCRAPER_REGISTRY } = require('../scrapers/registry');
const PythonScraper = require('../scrapers/pythonScraper');
const pool = require('../config/database');
const scrapingLogs = require('./scrapingLogs');

// =============================================
// Semáforo simple para control de concurrencia
// =============================================

let runningCount = 0;
const MAX_CONCURRENT = 2;

// =============================================
// Servicio de scraping
// =============================================

/**
 * Ejecuta el scraper de un proveedor específico.
 * Controla concurrencia máxima con semáforo.
 *
 * @param {object} pool         — pg pool
 * @param {number} supplierId   — ID del proveedor
 * @param {number|null} triggeredBy — ID del usuario que disparó el run, o null si es automático
 * @returns {object} — resultado del run { runId, status, found, new, updated, priceChanges, errors }
 */
async function runScraper(pool, supplierId, triggeredBy) {
    // Verificar límite de concurrencia
    if (runningCount >= MAX_CONCURRENT) {
        const err = new Error(
            `Demasiados scrapers corriendo simultáneamente (máx: ${MAX_CONCURRENT}). Intentá de nuevo en unos minutos.`
        );
        err.statusCode = 429;
        throw err;
    }

    // Buscar el proveedor en la DB
    // Permite correr scraper en staging y active (no en inactive)
    const { rows } = await pool.query(
        `SELECT * FROM suppliers WHERE id = $1 AND active = true AND status != 'inactive'`,
        [supplierId]
    );

    if (rows.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado, inactivo o deshabilitado`);
        err.statusCode = 404;
        throw err;
    }

    const supplier = rows[0];

    // Parsear scrape_config si llega como string
    if (typeof supplier.scrape_config === 'string') {
        try {
            supplier.scrape_config = JSON.parse(supplier.scrape_config);
        } catch (_) {
            supplier.scrape_config = {};
        }
    }

    // Obtener instancia del scraper
    const scraper = getScraperForSupplier(supplier, pool);
    if (!scraper) {
        const err = new Error(
            `No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`
        );
        err.statusCode = 400;
        throw err;
    }

    // Ejecutar scraper con control de concurrencia
    runningCount++;
    console.log(`📦 Iniciando scraper para "${supplier.name}" (corriendo: ${runningCount}/${MAX_CONCURRENT})`);

    try {
        const result = await scraper.run(triggeredBy);
        console.log(`✅ Scraper de "${supplier.name}" finalizado. Status: ${result.status}`);
        return result;
    } catch (err) {
        console.error(`❌ Scraper de "${supplier.name}" falló: ${err.message}`);
        throw err;
    } finally {
        runningCount--;
        console.log(`📦 Scrapers activos tras finalizar: ${runningCount}/${MAX_CONCURRENT}`);
    }
}

/**
 * Retorna el historial de runs de scraping.
 *
 * @param {object} pool
 * @param {object} filters — { supplierId, status, limit }
 * @returns {Array}
 */
async function getRunHistory(pool, { supplierId, status, limit = 50 } = {}) {
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

    // Agregar limit al final como parámetro
    params.push(parseInt(limit, 10) || 50);
    const limitClause = `LIMIT $${idx}`;

    const query = `
        SELECT
            sr.id,
            sr.supplier_id,
            s.name AS supplier_name,
            sr.status,
            sr.products_found,
            sr.products_new,
            sr.products_updated,
            sr.price_changes,
            sr.triggered_by,
            sr.started_at,
            sr.finished_at,
            EXTRACT(EPOCH FROM (sr.finished_at - sr.started_at))::int AS duration_seconds
        FROM scraping_runs sr
        JOIN suppliers s ON s.id = sr.supplier_id
        ${where}
        ORDER BY sr.started_at DESC
        ${limitClause}
    `;

    const { rows } = await pool.query(query, params);
    return rows;
}

/**
 * Retorna el detalle de un run específico, incluyendo los errores.
 *
 * @param {object} pool
 * @param {number} runId
 * @returns {object|null}
 */
async function getRunDetail(pool, runId) {
    const { rows } = await pool.query(
        `SELECT
            sr.*,
            s.name AS supplier_name,
            s.scraper_key,
            EXTRACT(EPOCH FROM (sr.finished_at - sr.started_at))::int AS duration_seconds
         FROM scraping_runs sr
         JOIN suppliers s ON s.id = sr.supplier_id
         WHERE sr.id = $1`,
        [runId]
    );

    if (rows.length === 0) return null;

    const run = rows[0];

    // Parsear errores si vienen como string (JSONB puede venir pre-parseado o como string)
    if (typeof run.errors === 'string') {
        try {
            run.errors = JSON.parse(run.errors);
        } catch (_) {
            run.errors = [];
        }
    }

    return run;
}

/**
 * Expone cuántos scrapers están corriendo actualmente.
 * Útil para el endpoint de status.
 */
function getRunningCount() {
    return runningCount;
}

/**
 * Corre el scraper en modo dry-run (preview).
 * Llama a onProduct(product) por cada producto encontrado — ideal para SSE.
 * No guarda nada en DB (ni run, ni productos, ni alertas).
 *
 * @param {number} supplierId
 * @param {function} onProduct — callback(product) llamado por cada producto
 * @param {number|null} triggeredBy
 * @returns {Promise<{ runId, status, found, newProducts, updated, priceChanges, products, errors }>}
 */
async function previewScraper(supplierId, onProduct, triggeredBy = null) {
    // Buscar el proveedor (no importa su status para el preview)
    const { rows: suppliers } = await pool.query(
        'SELECT * FROM suppliers WHERE id = $1 AND active = true',
        [supplierId]
    );

    if (suppliers.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado o inactivo`);
        err.statusCode = 404;
        throw err;
    }

    const supplier = suppliers[0];

    // Parsear scrape_config si llega como string
    if (typeof supplier.scrape_config === 'string') {
        try {
            supplier.scrape_config = JSON.parse(supplier.scrape_config);
        } catch (_) {
            supplier.scrape_config = {};
        }
    }

    // Obtener la clase scraper sin instanciarla (necesitamos pasar options)
    if (!supplier.scraper_key || !SCRAPER_REGISTRY[supplier.scraper_key]) {
        const err = new Error(
            `No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`
        );
        err.statusCode = 400;
        throw err;
    }

    const ScraperClass = SCRAPER_REGISTRY[supplier.scraper_key];

    // Instanciar con opciones de dry-run y callback de streaming
    const scraper = new ScraperClass(supplier, pool, {
        dryRun: true,
        onProduct
    });

    console.log(`📦 [DRY-RUN] Iniciando preview para "${supplier.name}"`);

    const result = await scraper.run(triggeredBy);

    console.log(`✅ [DRY-RUN] Preview de "${supplier.name}" finalizado: ${result.found} productos`);
    return result;
}

/**
 * Dispara el scraper de forma ASÍNCRONA: crea el run en DB de inmediato y
 * retorna { runId, status: 'running' } sin esperar que el scraper termine.
 * El cliente debe hacer polling a GET /api/scraping/runs/:runId.
 *
 * @param {object} pool
 * @param {number} supplierId
 * @param {number|null} triggeredBy
 * @returns {{ runId, status, supplierName }}
 */
async function startScraperAsync(pool, supplierId, triggeredBy) {
    if (runningCount >= MAX_CONCURRENT) {
        const err = new Error(
            `Demasiados scrapers corriendo simultáneamente (máx: ${MAX_CONCURRENT}). Intentá en unos minutos.`
        );
        err.statusCode = 429;
        throw err;
    }

    const { rows } = await pool.query(
        `SELECT * FROM suppliers WHERE id = $1 AND active = true AND status != 'inactive'`,
        [supplierId]
    );

    if (rows.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado, inactivo o deshabilitado`);
        err.statusCode = 404;
        throw err;
    }

    const supplier = rows[0];
    if (typeof supplier.scrape_config === 'string') {
        try { supplier.scrape_config = JSON.parse(supplier.scrape_config); } catch (_) { supplier.scrape_config = {}; }
    }

    const scraper = getScraperForSupplier(supplier, pool);
    if (!scraper) {
        const err = new Error(
            `No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`
        );
        err.statusCode = 400;
        throw err;
    }

    // Crear el run record AHORA para tener el ID antes de responder al cliente
    const { rows: runRows } = await pool.query(
        `INSERT INTO scraping_runs (supplier_id, status, triggered_by, started_at)
         VALUES ($1, 'running', $2, NOW()) RETURNING id`,
        [supplierId, triggeredBy || null]
    );
    const runId = runRows[0].id;

    // Inyectar el runId pre-creado en el scraper para que no cree otro
    scraper.createRun = async () => {
        scraper.runId = runId;
        return runId;
    };

    // Disparar el scraper en background — no await
    runningCount++;
    console.log(`📦 Scraper async iniciado para "${supplier.name}" (runId: ${runId}, activos: ${runningCount}/${MAX_CONCURRENT})`);

    (async () => {
        try {
            await scraper.run(triggeredBy);
            console.log(`✅ Scraper async de "${supplier.name}" finalizado (runId: ${runId})`);
        } catch (err) {
            console.error(`❌ Scraper async de "${supplier.name}" falló (runId: ${runId}): ${err.message}`);
        } finally {
            runningCount--;
            console.log(`📦 Scrapers activos tras finalizar: ${runningCount}/${MAX_CONCURRENT}`);
        }
    })();

    return { runId, status: 'running', supplierName: supplier.name };
}

/**
 * Pausa el proceso Python de un run activo.
 * El run queda en status 'paused' con el checkpoint de categorías completadas.
 * Se puede reanudar con resumeScraper().
 *
 * @param {number} runId
 * @returns {{ paused: boolean, message: string }}
 */
async function pauseScraper(runId) {
    const killed = PythonScraper.killProcess(runId);

    // Marcar como pausado (el run() en background también lo hará con stats finales)
    const { rowCount } = await pool.query(
        `UPDATE scraping_runs SET status = 'paused', finished_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [runId]
    );

    if (killed || rowCount > 0) {
        scrapingLogs.appendLog(runId, '⏸ Scraping pausado — podés reanudarlo cuando quieras');
        scrapingLogs.markDone(runId, 'paused');
        runningCount = Math.max(0, runningCount - (killed ? 1 : 0));
        console.log(`⏸ Run ${runId} pausado`);
        return { paused: true, message: `Run ${runId} pausado correctamente` };
    }

    return { paused: false, message: `Run ${runId} no estaba activo` };
}

/**
 * Detiene el proceso Python de un run activo y marca el run como 'cancelled'.
 * A diferencia de pauseScraper, no permite reanudar.
 *
 * @param {number} runId
 * @returns {{ stopped: boolean, message: string }}
 */
async function stopScraper(runId) {
    const killed = PythonScraper.killProcess(runId);

    const { rowCount } = await pool.query(
        `UPDATE scraping_runs SET status = 'cancelled', finished_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [runId]
    );

    if (killed || rowCount > 0) {
        scrapingLogs.appendLog(runId, '🛑 Scraping cancelado');
        scrapingLogs.markDone(runId, 'cancelled');
        runningCount = Math.max(0, runningCount - (killed ? 1 : 0));
        console.log(`🛑 Run ${runId} cancelado`);
        return { stopped: true, message: `Run ${runId} cancelado correctamente` };
    }

    return { stopped: false, message: `Run ${runId} no estaba activo` };
}

/**
 * Reanuda el scraping de un proveedor desde el último punto pausado.
 * Busca el run más reciente con status 'paused' para el proveedor y
 * arranca un nuevo run pasando las categorías ya completadas como SKIP_CATEGORIES.
 *
 * @param {object} pool
 * @param {number} supplierId
 * @param {number|null} triggeredBy
 * @returns {{ runId, status, supplierName, resumedFrom, skippedCategories }}
 */
async function resumeScraper(pool, supplierId, triggeredBy) {
    if (runningCount >= MAX_CONCURRENT) {
        const err = new Error(
            `Demasiados scrapers corriendo simultáneamente (máx: ${MAX_CONCURRENT}). Intentá en unos minutos.`
        );
        err.statusCode = 429;
        throw err;
    }

    // Buscar el último run pausado para este proveedor
    const { rows: pausedRuns } = await pool.query(
        `SELECT id, completed_categories, checkpoint
         FROM scraping_runs
         WHERE supplier_id = $1 AND status = 'paused'
         ORDER BY started_at DESC
         LIMIT 1`,
        [supplierId]
    );

    if (pausedRuns.length === 0) {
        const err = new Error(`No hay ningún run pausado para el proveedor ${supplierId}`);
        err.statusCode = 404;
        throw err;
    }

    const pausedRun = pausedRuns[0];
    const completedCategories = pausedRun.completed_categories || [];
    const checkpoint = pausedRun.checkpoint || null; // { category, page } o null

    // Obtener el proveedor
    const { rows } = await pool.query(
        `SELECT * FROM suppliers WHERE id = $1 AND active = true AND status != 'inactive'`,
        [supplierId]
    );

    if (rows.length === 0) {
        const err = new Error(`Proveedor con ID ${supplierId} no encontrado, inactivo o deshabilitado`);
        err.statusCode = 404;
        throw err;
    }

    const supplier = rows[0];
    if (typeof supplier.scrape_config === 'string') {
        try { supplier.scrape_config = JSON.parse(supplier.scrape_config); } catch (_) { supplier.scrape_config = {}; }
    }

    // Obtener el scraper con las categorías ya completadas inyectadas como env var
    const scraper = getScraperForSupplier(supplier, pool);
    if (!scraper) {
        const err = new Error(
            `No hay scraper disponible para el proveedor "${supplier.name}" (key: "${supplier.scraper_key}")`
        );
        err.statusCode = 400;
        throw err;
    }

    // Inyectar vars de reanudación en el pythonEnv del scraper
    const originalPythonEnv = scraper.pythonEnv || {};
    Object.defineProperty(scraper, 'pythonEnv', {
        get: () => ({
            ...originalPythonEnv,
            SKIP_CATEGORIES: JSON.stringify(completedCategories),
            ...(checkpoint ? {
                RESUME_CATEGORY: checkpoint.category,
                RESUME_PAGE:     String(checkpoint.page),
            } : {}),
        })
    });

    if (checkpoint) {
        console.log(`▶ Checkpoint: categoría "${checkpoint.category}", reanudando desde página ${checkpoint.page + 1}`);
    }

    // Crear el run record AHORA para tener el ID antes de responder al cliente
    const { rows: runRows } = await pool.query(
        `INSERT INTO scraping_runs (supplier_id, status, triggered_by, started_at)
         VALUES ($1, 'running', $2, NOW()) RETURNING id`,
        [supplierId, triggeredBy || null]
    );
    const runId = runRows[0].id;

    // Inyectar runId pre-creado
    scraper.createRun = async () => {
        scraper.runId = runId;
        return runId;
    };

    // Disparar el scraper en background
    runningCount++;
    console.log(`▶ Reanudando scraper para "${supplier.name}" (runId: ${runId}, saltando: ${completedCategories.length} categorías)`);

    (async () => {
        try {
            await scraper.run(triggeredBy);
            console.log(`✅ Scraper reanudado de "${supplier.name}" finalizado (runId: ${runId})`);
        } catch (err) {
            console.error(`❌ Scraper reanudado de "${supplier.name}" falló (runId: ${runId}): ${err.message}`);
        } finally {
            runningCount--;
        }
    })();

    return {
        runId,
        status: 'running',
        supplierName: supplier.name,
        resumedFrom: pausedRun.id,
        skippedCategories: completedCategories.length
    };
}

/**
 * Mata todos los procesos Python activos, resetea el contador de concurrencia
 * y marca todos los runs 'running' en DB como 'cancelled'.
 * Endpoint de emergencia para casos donde la app quedó en estado inválido.
 *
 * @param {object} pool
 * @returns {{ killed, cancelledRuns }}
 */
async function cancelAll(pool) {
    const killed = PythonScraper.killAllProcesses();

    // Marcar todos los runs activos en DB como cancelados
    const { rows } = await pool.query(
        `UPDATE scraping_runs
         SET status = 'cancelled', finished_at = NOW()
         WHERE status IN ('running', 'paused')
         RETURNING id`
    );

    for (const run of rows) {
        scrapingLogs.appendLog(run.id, '🛑 Cancelado por admin (force cancel-all)');
        scrapingLogs.markDone(run.id, 'cancelled');
    }

    runningCount = 0;
    console.log(`🛑 cancel-all: ${killed} procesos Python terminados, ${rows.length} runs cancelados en DB`);

    return { killed, cancelledRuns: rows.length };
}

/**
 * Limpieza al iniciar el servidor: si quedaron runs en 'running' de
 * una sesión anterior (crash, restart), los marca como 'cancelled'.
 * No mata procesos Python — al reiniciar el server ya no existen.
 *
 * @param {object} pool
 */
async function startupCleanup(pool) {
    const { rows } = await pool.query(
        `UPDATE scraping_runs
         SET status = 'cancelled', finished_at = NOW()
         WHERE status = 'running'
         RETURNING id`
    );
    if (rows.length > 0) {
        console.log(`⚠️ startup: ${rows.length} runs bloqueados encontrados y marcados como cancelled`);
        for (const run of rows) {
            scrapingLogs.appendLog(run.id, '⚠️ Run cancelado automáticamente al reiniciar el servidor');
            scrapingLogs.markDone(run.id, 'cancelled');
        }
    }
    runningCount = 0;
}

module.exports = {
    runScraper,
    startScraperAsync,
    pauseScraper,
    stopScraper,
    resumeScraper,
    cancelAll,
    startupCleanup,
    getRunHistory,
    getRunDetail,
    getRunningCount,
    previewScraper
};
