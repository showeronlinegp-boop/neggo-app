const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { startScraperAsync, pauseScraper, stopScraper, resumeScraper, cancelAll, getRunHistory, getRunDetail, getRunningCount, previewScraper } = require('../services/scrapingService');
const scrapingLogs = require('../services/scrapingLogs');
const pool = require('../config/database');

// =============================================
// POST /api/scraping/:supplierId/run
// Dispara el scraper de un proveedor (solo admin)
// =============================================

router.post(
    '/:supplierId/run',
    authenticate,
    requireRole('admin'),
    async (req, res) => {
        const supplierId = parseInt(req.params.supplierId, 10);

        if (isNaN(supplierId) || supplierId <= 0) {
            return res.status(400).json({
                success: false,
                error: 'ID de proveedor inválido'
            });
        }

        try {
            // Dispara el scraper en background y retorna el runId de inmediato.
            // El cliente hace polling a GET /api/scraping/runs/:runId hasta que status !== 'running'.
            const result = await startScraperAsync(pool, supplierId, req.user.id);

            return res.json({
                success: true,
                data: result
            });
        } catch (err) {
            const statusCode = err.statusCode || 500;
            console.error(`❌ Error al iniciar scraper para proveedor ${supplierId}:`, err.message);

            return res.status(statusCode).json({
                success: false,
                error: err.message
            });
        }
    }
);

// =============================================
// GET /api/scraping/runs
// Lista de runs con filtros opcionales
// Query params: supplierId, status, limit
// =============================================

router.get('/runs', authenticate, async (req, res) => {
    const { supplierId, status, limit } = req.query;

    // Validar supplierId si fue enviado
    const supplierIdParsed = supplierId ? parseInt(supplierId, 10) : undefined;
    if (supplierId && isNaN(supplierIdParsed)) {
        return res.status(400).json({
            success: false,
            error: 'supplierId debe ser un número entero'
        });
    }

    // Validar status si fue enviado
    const validStatuses = ['running', 'completed', 'failed', 'partial'];
    if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            error: `status inválido. Valores aceptados: ${validStatuses.join(', ')}`
        });
    }

    try {
        const runs = await getRunHistory(pool, {
            supplierId: supplierIdParsed,
            status,
            limit: limit ? parseInt(limit, 10) : 50
        });

        return res.json({
            success: true,
            data: runs
        });
    } catch (err) {
        console.error('❌ Error al obtener historial de runs:', err.message);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// =============================================
// GET /api/scraping/runs/:runId
// Detalle completo de un run (incluye errores)
// =============================================

router.get('/runs/:runId', authenticate, async (req, res) => {
    const runId = parseInt(req.params.runId, 10);

    if (isNaN(runId) || runId <= 0) {
        return res.status(400).json({
            success: false,
            error: 'ID de run inválido'
        });
    }

    try {
        const run = await getRunDetail(pool, runId);

        if (!run) {
            return res.status(404).json({
                success: false,
                error: `Run con ID ${runId} no encontrado`
            });
        }

        return res.json({
            success: true,
            data: run
        });
    } catch (err) {
        console.error(`❌ Error al obtener detalle del run ${runId}:`, err.message);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// =============================================
// POST /api/scraping/:supplierId/run-preview
// Corre el scraper en dry-run y devuelve resultados via Server-Sent Events.
// Cada producto encontrado se envía como evento SSE en tiempo real.
// Al finalizar envía un evento 'done' con el resumen total.
// =============================================

router.post('/:supplierId/run-preview', authenticate, requireRole('admin'), async (req, res) => {
    const supplierId = parseInt(req.params.supplierId, 10);

    if (isNaN(supplierId) || supplierId <= 0) {
        return res.status(400).json({
            success: false,
            error: 'ID de proveedor inválido'
        });
    }

    // Headers SSE — deshabilitar cualquier buffering intermedio
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // importante para Nginx: evita que bufferee los eventos
    });

    // Helper para enviar un evento SSE con nombre y payload JSON
    const sendEvent = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Notificar inicio
    sendEvent('start', { supplierId, message: 'Iniciando preview...' });

    let productCount = 0;

    try {
        const result = await previewScraper(
            supplierId,
            // Callback llamado por cada producto scrapeado
            (product) => {
                productCount++;
                sendEvent('product', { ...product, index: productCount });
            },
            req.user?.id || null
        );

        // Resumen final
        sendEvent('done', {
            found: result.found,
            errors: result.errors,
            message: `Preview completado: ${result.found} producto(s) encontrado(s)`
        });

    } catch (err) {
        console.error(`❌ Error en preview para proveedor ${supplierId}:`, err.message);
        sendEvent('error', { message: err.message });
    } finally {
        res.end();
    }
});

// =============================================
// POST /api/scraping/runs/:runId/pause
// Pausa un scraper en ejecución — guarda checkpoint para poder reanudar (admin)
// =============================================

router.post('/runs/:runId/pause', authenticate, requireRole('admin'), async (req, res) => {
    const runId = parseInt(req.params.runId, 10);

    if (isNaN(runId) || runId <= 0) {
        return res.status(400).json({ success: false, error: 'runId inválido' });
    }

    try {
        const result = await pauseScraper(runId);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error(`❌ Error al pausar run ${runId}:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// POST /api/scraping/:supplierId/resume
// Reanuda el scraping desde el último checkpoint pausado (admin)
// =============================================

router.post('/:supplierId/resume', authenticate, requireRole('admin'), async (req, res) => {
    const supplierId = parseInt(req.params.supplierId, 10);

    if (isNaN(supplierId) || supplierId <= 0) {
        return res.status(400).json({ success: false, error: 'ID de proveedor inválido' });
    }

    try {
        const result = await resumeScraper(pool, supplierId, req.user.id);
        return res.json({ success: true, data: result });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        console.error(`❌ Error al reanudar scraper para proveedor ${supplierId}:`, err.message);
        return res.status(statusCode).json({ success: false, error: err.message });
    }
});

// =============================================
// POST /api/scraping/runs/:runId/stop
// Cancela definitivamente un scraper en ejecución (no se puede reanudar) (admin)
// =============================================

router.post('/runs/:runId/stop', authenticate, requireRole('admin'), async (req, res) => {
    const runId = parseInt(req.params.runId, 10);

    if (isNaN(runId) || runId <= 0) {
        return res.status(400).json({ success: false, error: 'runId inválido' });
    }

    try {
        const result = await stopScraper(runId);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error(`❌ Error al cancelar run ${runId}:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// GET /api/scraping/status
// Estado actual del motor de scraping (cuántos corriendo, qué runIds)
// =============================================

router.get('/status', authenticate, requireRole('admin'), async (req, res) => {
    try {
        // Los scrapers corren en el scraper-worker: el estado sale de la base
        const { running, queued, activeRunIds } = await getRunningCount(pool);
        res.json({
            success: true,
            data: { runningCount: running, queuedCount: queued, activeRunIds }
        });
    } catch (err) {
        console.error('❌ Error al obtener estado del scraping:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// POST /api/scraping/cancel-all
// Mata todos los procesos activos y resetea el estado (emergencia, solo admin)
// =============================================

router.post('/cancel-all', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const result = await cancelAll(pool);
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error('❌ Error en cancel-all:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/scraping/runs/:runId/logs
// Streaming de logs en tiempo real via SSE.
// Primero envía las líneas ya acumuladas en buffer,
// luego hace push de nuevas líneas a medida que llegan.
// Cierra la conexión cuando el run termina.
// IMPORTANTE: definir ANTES del wildcard /runs/:runId para no colisionar.
// =============================================

router.get('/runs/:runId/logs', authenticate, async (req, res) => {
    const runId = parseInt(req.params.runId, 10);

    if (isNaN(runId) || runId <= 0) {
        return res.status(400).json({ success: false, error: 'runId inválido' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Los logs los escribe el scraper-worker en la base; acá se leen y se transmiten
    let logs;
    try {
        logs = await scrapingLogs.getLogs(runId);
    } catch (err) {
        console.error(`❌ Error leyendo logs del run ${runId}:`, err.message);
        res.write(`event: done\ndata: ${JSON.stringify({ status: 'failed' })}\n\n`);
        return res.end();
    }

    // Enviar líneas ya acumuladas
    for (const line of logs.lines) {
        res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }

    // Si ya terminó, cerrar de inmediato
    if (logs.done) {
        res.write(`event: done\ndata: ${JSON.stringify({ status: logs.status })}\n\n`);
        res.end();
        return;
    }

    // Suscribir a logs futuros (polling a la base)
    const unsubscribe = scrapingLogs.subscribe(runId, (event) => {
        if (event.type === 'done') {
            res.write(`event: done\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({ line: event.line })}\n\n`);
        }
    }, logs.lastId);

    // Limpiar suscripción si el cliente se desconecta
    req.on('close', unsubscribe);
});

module.exports = router;
