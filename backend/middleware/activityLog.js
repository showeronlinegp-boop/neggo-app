const pool = require('../config/database');

// Mapeo de ruta a módulo para el log
function getModule(path) {
    if (path.includes('/auth')) return 'auth';
    if (path.includes('/users')) return 'users';
    if (path.includes('/suppliers')) return 'suppliers';
    if (path.includes('/scraping')) return 'scraping';
    if (path.includes('/products')) return 'products';
    if (path.includes('/mappings')) return 'mappings';
    if (path.includes('/alerts')) return 'alerts';
    if (path.includes('/preventas')) return 'preventas';
    if (path.includes('/catalogs')) return 'catalogs';
    return 'general';
}

// Extraer entity_type y entity_id de la URL si es posible
function extractEntity(path) {
    // Patrón: /api/recurso/:id o /api/recurso/:id/accion
    const parts = path.replace('/api/', '').split('/');
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
        return { entity_type: parts[0], entity_id: parseInt(parts[1], 10) };
    }
    return { entity_type: parts[0] || null, entity_id: null };
}

// Middleware de activity log
// Se aplica después del handler usando res.on('finish')
function activityLog(req, res, next) {
    // Excluir rutas que no necesitan log
    if (req.path === '/api/health' || req.method === 'OPTIONS') {
        return next();
    }

    // Guardar tiempo de inicio
    const startTime = Date.now();

    // Hook en el finish del response
    res.on('finish', () => {
        // Solo loguear si hay usuario autenticado y no es un GET a listados
        // (para no llenar el log con cada consulta)
        const shouldLog = req.user && (
            req.method !== 'GET' ||
            req.path.includes('/login') ||
            req.path.includes('/run')
        );

        if (!shouldLog) return;

        const { entity_type, entity_id } = extractEntity(req.path);
        const duration = Date.now() - startTime;

        // Fire and forget — no esperamos el resultado
        pool.query(
            `INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                req.user.id,
                getModule(req.path),
                req.method,
                entity_type,
                entity_id,
                JSON.stringify({
                    path: req.path,
                    status: res.statusCode,
                    duration_ms: duration
                }),
                req.headers['x-real-ip'] || req.ip
            ]
        ).catch(err => {
            console.error('⚠️ Error guardando activity log:', err.message);
        });
    });

    next();
}

module.exports = activityLog;
