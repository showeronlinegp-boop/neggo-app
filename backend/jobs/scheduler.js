const cron = require('node-cron');
const odooSync = require('./odooSync');
const { syncSalesWeekly } = require('./salesWeeklySync');

// Tareas cron registradas, para poder detenerlas en el shutdown
const scheduledTasks = [];

const TZ = { timezone: 'America/Argentina/Buenos_Aires' };

/**
 * Inicializa el scheduler: sync con Odoo cada hora (mientras la app esté prendida)
 * y alerta de proveedores sin scrapear. El scraping se lanza a mano desde /scraping.
 * Las ventas de reposición NO van por cron diario: la app corre local y no está
 * siempre prendida; se sincronizan al arrancar y on-demand al abrir el modal.
 *
 * @param {object} pool — instancia del pg pool
 */
async function initScheduler(pool) {
    console.log('📦 Inicializando scheduler...');

    // Sync Odoo cada 1 hora (solo mientras el worker esté corriendo)
    scheduledTasks.push(cron.schedule('0 * * * *', async () => {
        console.log('📦 Iniciando sync Odoo...');
        try {
            await odooSync.syncOdooProducts();
            console.log('✅ Sync Odoo completado');
        } catch (err) {
            console.error('❌ Error en sync Odoo:', err.message);
        }
    }, TZ));

    console.log('✅ Cron de sync Odoo registrado (cada 1 hora).');

    // Verificación diaria de proveedores sin scraping reciente (>= 7 días)
    scheduledTasks.push(cron.schedule('0 9 * * *', async () => {
        try {
            const { rows: stale } = await pool.query(`
                SELECT id, name, last_scraped_at
                FROM suppliers
                WHERE active = true
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
    }, TZ));

    console.log('✅ Cron de verificación de proveedores inactivos registrado (9:00 AM diario).');

    // Al arrancar (cuando prendés la app): sync Odoo y después ventas para reposición
    setImmediate(async () => {
        console.log('📦 Sync Odoo inicial al arrancar...');
        try {
            await odooSync.syncOdooProducts();
            console.log('✅ Sync Odoo inicial completado');
        } catch (err) {
            console.error('❌ Error en sync Odoo inicial:', err.message);
        }
        try {
            await syncSalesWeekly();
        } catch (err) {
            console.error('❌ Error en sync de ventas al arrancar:', err.message);
        }
    });
}

/**
 * Detiene y destruye todas las tareas programadas.
 * Usar en graceful shutdown.
 */
function stopScheduler() {
    if (scheduledTasks.length === 0) return;

    console.log(`⚠️ Deteniendo ${scheduledTasks.length} tarea(s) del scheduler...`);
    for (const task of scheduledTasks) task.destroy();
    scheduledTasks.length = 0;
    console.log('✅ Scheduler detenido.');
}

module.exports = { initScheduler, stopScheduler };
