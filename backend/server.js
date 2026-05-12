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

        // Limpiar runs bloqueados de sesiones anteriores (crash, restart, etc.)
        const { startupCleanup } = require('./services/scrapingService');
        await startupCleanup(pool);

        // Inicializar datos (admin, proveedores, config)
        const initDatabase = require('./initDatabase');
        await initDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Neggo App Backend corriendo en puerto ${PORT}`);
            console.log(`📦 Entorno: ${process.env.NODE_ENV || 'development'}`);
        });

        // Inicializar scheduler de scrapers
        const { initScheduler, stopScheduler } = require('./jobs/scheduler');
        await initScheduler(pool);

        // Graceful shutdown del scheduler
        process.on('SIGTERM', async () => {
            stopScheduler();
        });
        process.on('SIGINT', async () => {
            stopScheduler();
        });
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
