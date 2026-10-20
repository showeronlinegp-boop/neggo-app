require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const pool = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// Middlewares globales
// =============================================

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('short'));

// =============================================
// Health check
// =============================================

app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT NOW() as time');
        return res.json({
            success: true,
            data: {
                status: 'ok',
                timestamp: dbResult.rows[0].time,
                version: '1.0.0'
            }
        });
    } catch (error) {
        return res.status(503).json({
            success: false,
            error: 'Base de datos no disponible',
            details: error.message
        });
    }
});

// =============================================
// Middlewares de app
// =============================================

const activityLog = require('./middleware/activityLog');
app.use('/api', activityLog);

// =============================================
// Rutas
// =============================================

// Agente 02: Auth y usuarios
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/activity-log', require('./routes/activityLog'));

// Agente 04: Proveedores y reglas
const suppliersRouter = require('./routes/suppliers');
const supplierRulesRouter = require('./routes/supplierRules');
app.use('/api/suppliers', suppliersRouter);
app.use('/api/suppliers', supplierRulesRouter);

// Agente 05: Scraping
app.use('/api/scraping', require('./routes/scraping'));

// Agente 03: Integración Odoo — productos cache y sync
app.use('/api/products', require('./routes/products'));

// Agente 06: Mappings y alertas
app.use('/api/mappings', require('./routes/productMappings'));
app.use('/api/alerts', require('./routes/priceAlerts'));

// Agente 07: Preventas y catálogos
app.use('/api/preventas', require('./routes/preventas'));
app.use('/api/catalogs', require('./routes/catalogs'));
app.use('/api/preventas-sync', require('./routes/preventasSync'));

// Módulo de ingreso de mercadería
app.use('/api/ingreso', require('./routes/ingreso'));

// Listas de precios especiales para clientes
app.use('/api/pricelists', require('./routes/pricelists'));

// Publicación en grupos de WhatsApp (Evolution API)
app.use('/api/whatsapp', require('./routes/whatsapp'));

// Cola de reposición de Neggo (archivados y "queda poco")
app.use('/api/reposicion', require('./routes/reposicion'));

// Armado y control de pedidos (2-step en la app; Odoo al saldar)
app.use('/api/pedido-envios', require('./routes/pedidoEnvios'));

// Backup de la base: estado y "Hacer backup ahora" (lo ejecuta el contenedor db-backup)
app.use('/api/backup', require('./routes/backup'));

// Notas de prueba (marcar en pantalla + Claude Code). Sin la flag la ruta no existe → 404,
// y el frontend esconde la herramienta.
if (process.env.TEST_NOTES_ENABLED === '1') {
    app.use('/api/test-notes', require('./routes/testNotes'));
    console.log('📦 Notas de prueba habilitadas (/api/test-notes)');
}

// 404 para rutas no encontradas
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
    });
});

// =============================================
// Manejo global de errores
// =============================================

app.use((err, req, res, _next) => {
    console.error('❌ Error no manejado:', err.message);
    console.error(err.stack);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production'
            ? 'Error interno del servidor'
            : err.message
    });
});

// =============================================
// Iniciar servidor
// =============================================

async function start() {
    try {
        // Verificar conexión a PostgreSQL
        const result = await pool.query('SELECT NOW()');
        console.log('✅ PostgreSQL conectado:', result.rows[0].now);

        // Los runs de scraping NO se tocan acá: los ejecuta el scraper-worker (worker.js),
        // así reiniciar el backend no corta ningún scraping.

        // Inicializar datos (admin, proveedores, config)
        const initDatabase = require('./initDatabase');
        await initDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Neggo App Backend corriendo en puerto ${PORT}`);
            console.log(`📦 Entorno: ${process.env.NODE_ENV || 'development'}`);
        });

        // El scheduler (sync Odoo, alertas) corre en el scraper-worker.
        // Acá solo arranca la cola de WhatsApp.
        const { startWhatsappWorker, stopWhatsappWorker } = require('./jobs/whatsappWorker');
        startWhatsappWorker(pool);
        process.on('SIGTERM', stopWhatsappWorker);
        process.on('SIGINT', stopWhatsappWorker);
    } catch (error) {
        console.error('❌ Error al iniciar el servidor:', error.message);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM recibido. Cerrando...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('⚠️ SIGINT recibido. Cerrando...');
    await pool.end();
    process.exit(0);
});

start();

module.exports = app;
