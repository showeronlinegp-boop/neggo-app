const cron = require('node-cron');
const odooSync = require('./odooSync');
const { syncSalesWeekly } = require('./salesWeeklySync');

// Tareas cron registradas, para poder detenerlas en el shutdown
const scheduledTasks = [];

const TZ = { timezone: 'America/Argentina/Buenos_Aires' };

/**
 * Inicializa el scheduler: sync con Odoo cada hora, ventas semanales diarias
 * y alerta de proveedores sin scrapear. El scraping se lanza a mano desde /scraping.
 *
 * @param {object} pool — instancia del pg pool
 */
async function initScheduler(pool) {
    console.log('📦 Inicializando scheduler...');

    // Sync Odoo cada 1 hora
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

    // Ventas semanales (reposición): todos los días a las 2:00 AM
    scheduledTasks.push(cron.schedule('0 2 * * *', async () => {
        console.log('📈 Iniciando sync de ventas semanales...');
        try {
            await syncSalesWeekly();
        } catch (err) {
            console.error('❌ Error en sync de ventas semanales:', err.message);
        }
    }, TZ));

    console.log('✅ Cron de ventas semanales registrado (2:00 AM diario).');

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
    if (scheduledTasks.length === 0) return;

    console.log(`⚠️ Deteniendo ${scheduledTasks.length} tarea(s) del scheduler...`);
    for (const task of scheduledTasks) task.destroy();
    scheduledTasks.length = 0;
    console.log('✅ Scheduler detenido.');
}

module.exports = { initScheduler, stopScheduler };
