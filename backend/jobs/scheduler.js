const cron = require('node-cron');
const scrapingService = require('../services/scrapingService');
const odooSync = require('./odooSync');

// Mapa de tareas registradas: supplierId → tarea cron
// Útil para debugging y para no registrar duplicados
const scheduledTasks = new Map();

/**
 * Inicializa el scheduler de scrapers.
 * Lee todos los proveedores con scrape_schedule definido y los registra en cron.
 *
 * @param {object} pool — instancia del pg pool
 */
async function initScheduler(pool) {
    console.log('📦 Inicializando scheduler de scrapers...');

    let suppliers;

    try {
        const { rows } = await pool.query(
            `SELECT id, name, scraper_key, scrape_schedule
             FROM suppliers
             WHERE scrape_schedule IS NOT NULL
               AND active = true
               AND status = 'active'
               AND scrape_enabled = true`
        );
        suppliers = rows;
    } catch (err) {
        console.error('❌ Error al cargar proveedores para el scheduler:', err.message);
        suppliers = [];
    }

    // Sin proveedores programados igual se registran los crons de abajo (sync Odoo, alertas)
    if (suppliers.length === 0) {
        console.log('⚠️ No hay proveedores con scrape_schedule configurado. Scraping automático inactivo.');
    }

    for (const supplier of suppliers) {
        // Validar que la expresión cron es válida antes de registrar
        if (!cron.validate(supplier.scrape_schedule)) {
            console.warn(`⚠️ Expresión cron inválida para "${supplier.name}": "${supplier.scrape_schedule}". Omitiendo.`);
            continue;
        }

        // Si ya estaba registrado (restart del proceso), destruir la tarea anterior
        if (scheduledTasks.has(supplier.id)) {
            scheduledTasks.get(supplier.id).destroy();
            console.log(`⚠️ Tarea anterior de "${supplier.name}" destruida para re-registrar.`);
        }

        const task = cron.schedule(supplier.scrape_schedule, async () => {
            console.log(`📦 Scheduler: iniciando scraper automático para "${supplier.name}" (ID: ${supplier.id})`);

            try {
                // triggeredBy = null indica que es una ejecución automática
                const result = await scrapingService.runScraper(pool, supplier.id, null);
                console.log(
                    `✅ Scheduler: scraper de "${supplier.name}" completado. ` +
                    `Status: ${result.status}, encontrados: ${result.found}`
                );
            } catch (err) {
                console.error(`❌ Scheduler: error en scraper de "${supplier.name}": ${err.message}`);
            }
        }, {
            // Zona horaria de Argentina
            timezone: 'America/Argentina/Buenos_Aires'
        });

        scheduledTasks.set(supplier.id, task);
        console.log(`✅ Scheduled: "${supplier.name}" → "${supplier.scrape_schedule}"`);
    }

    console.log(`✅ Scheduler inicializado con ${scheduledTasks.size} tarea(s) activa(s).`);

    // Sync Odoo cada 1 hora
    cron.schedule('0 * * * *', async () => {
        console.log('📦 Iniciando sync Odoo...');
        try {
            await odooSync.syncOdooProducts();
            console.log('✅ Sync Odoo completado');
        } catch (err) {
            console.error('❌ Error en sync Odoo:', err.message);
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    console.log('✅ Cron de sync Odoo registrado (cada 1 hora).');

    // Verificación diaria de proveedores sin scraping reciente (>= 7 días)
    cron.schedule('0 9 * * *', async () => {
        try {
            const { rows: stale } = await pool.query(`
                SELECT id, name, last_scraped_at
                FROM suppliers
                WHERE status = 'active'
                  AND active = true
                  AND scrape_enabled = true
                  AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '7 days')
                ORDER BY last_scraped_at ASC NULLS FIRST
            `);

            if (stale.length === 0) return;

            console.warn(`⚠️ ALERTA: ${stale.length} proveedor(es) sin scraping en más de 7 días:`);
            for (const s of stale) {
                const dias = s.last_scraped_at
                    ? Math.floor((Date.now() - new Date(s.last_scraped_at)) / 86400000)
                    : null;
                console.warn(`   ❌ ${s.name} — ${dias !== null ? `hace ${dias} días` : 'nunca scrapeado'}`);
            }
        } catch (err) {
            console.error('❌ Error en verificación de proveedores inactivos:', err.message);
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    console.log('✅ Cron de verificación de proveedores inactivos registrado (9:00 AM diario).');

    // Sync inmediato al arrancar (no bloquea el startup)
    setImmediate(async () => {
        console.log('📦 Sync Odoo inicial al arrancar...');
        try {
            await odooSync.syncOdooProducts();
            console.log('✅ Sync Odoo inicial completado');
        } catch (err) {
            console.error('❌ Error en sync Odoo inicial:', err.message);
        }
    });
}

/**
 * Detiene y destruye todas las tareas programadas.
 * Usar en graceful shutdown.
 */
function stopScheduler() {
    if (scheduledTasks.size === 0) return;

    console.log(`⚠️ Deteniendo ${scheduledTasks.size} tarea(s) del scheduler...`);
    for (const [id, task] of scheduledTasks) {
        task.destroy();
        console.log(`⚠️ Tarea del proveedor ID ${id} detenida.`);
    }
    scheduledTasks.clear();
    console.log('✅ Scheduler detenido.');
}

module.exports = { initScheduler, stopScheduler };
