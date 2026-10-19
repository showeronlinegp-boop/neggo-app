require('dotenv').config();

// scraper-worker: ejecuta los scrapers fuera del backend (contenedor aparte en docker-compose).
// Reiniciar el backend no corta ningún scraping; reiniciar el worker deja los runs en curso
// pausados, listos para reanudar desde la última categoría completa.
//
//   - toma runs en cola (status 'queued') de a MAX_CONCURRENT
//   - aplica pausas/cancelaciones pedidas desde el backend (scraping_runs.control)
//   - corre el scheduler: scraping programado, sync con Odoo cada hora y alerta de proveedores sin scrapear

const pool = require('./config/database');
const PythonScraper = require('./scrapers/pythonScraper');
const scrapingLogs = require('./services/scrapingLogs');
const { claimNextRun, executeRun, applyControls, workerStartupCleanup } = require('./services/scrapingService');
const { initScheduler, stopScheduler } = require('./jobs/scheduler');

const MAX_CONCURRENT = parseInt(process.env.SCRAPER_MAX_CONCURRENT, 10) || 2;
const POLL_MS = 3000;

// Sin el log de cada conexión nueva del pool (el worker hace polling seguido)
pool.removeAllListeners('connect');

const activos = new Map(); // runId → Promise
let cerrando = false;

// Espera a que el backend haya creado las tablas (initDatabase corre en el backend)
async function esperarBase() {
    for (let intento = 1; ; intento++) {
        try {
            await pool.query('SELECT 1 FROM scraping_run_logs LIMIT 1');
            await pool.query('SELECT control, resume_from FROM scraping_runs LIMIT 1');
            return;
        } catch (err) {
            if (intento % 10 === 1) console.log(`⚠️ Worker: esperando la base (${err.message})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function tomarTrabajo() {
    while (!cerrando && activos.size < MAX_CONCURRENT) {
        const run = await claimNextRun(pool);
        if (!run) return;
        const p = executeRun(pool, run).finally(() => activos.delete(run.id));
        activos.set(run.id, p);
        console.log(`📦 Worker: run ${run.id} tomado (activos: ${activos.size}/${MAX_CONCURRENT})`);
    }
}

async function loop() {
    try {
        await applyControls(pool, [...activos.keys()]);
        await tomarTrabajo();
    } catch (err) {
        console.error('❌ Worker: error en el ciclo:', err.message);
    }
    if (!cerrando) setTimeout(loop, POLL_MS);
}

async function cerrar(signal) {
    if (cerrando) return;
    cerrando = true;
    console.log(`⚠️ Worker: ${signal} recibido. Pausando ${activos.size} run(s) en curso...`);
    stopScheduler();
    // Cortar los procesos Python: el scraper deja el run 'paused' (reanudable)
    for (const runId of activos.keys()) {
        scrapingLogs.appendLog(runId, '⏸ El scraper-worker se está reiniciando: pausado, se puede reanudar');
        PythonScraper.killProcess(runId);
    }
    await Promise.race([
        Promise.allSettled([...activos.values()]),
        new Promise(r => setTimeout(r, 15000)),
    ]);
    await scrapingLogs.flush();
    await pool.end().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));

(async () => {
    console.log('📦 Scraper-worker iniciando...');
    await esperarBase();
    await workerStartupCleanup(pool);
    const borrados = await scrapingLogs.purgeOld(14).catch(() => 0);
    if (borrados) console.log(`🧹 Worker: ${borrados} líneas de log viejas borradas`);
    await initScheduler(pool);
    console.log(`✅ Scraper-worker listo (máx ${MAX_CONCURRENT} scrapers a la vez)`);
    loop();
})().catch(err => {
    console.error('❌ Worker: no pudo arrancar:', err.message);
    process.exit(1);
});
