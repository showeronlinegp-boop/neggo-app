// Rutas del CRM de clientes (fase 1: solo lectura)
// GET    /api/clientes?search=&city=&rubro=&health=&open=1&sort=prioridad|facturacion|ultima|nombre&limit=&offset=
// GET    /api/clientes/resumen        — contadores por estado, facturación, ciudades, rubros y última actualización
// POST   /api/clientes/sync           — vuelve a calcular las métricas desde Odoo
// GET    /api/clientes/:partnerId     — ficha: métricas, cotizaciones recientes y últimos tickets

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const clientes = require('../services/clientMetricsService');

const ROLES = ['admin', 'vendedor'];

router.get('/', authenticate, requireRole(...ROLES), async (req, res) => {
    try {
        await clientes.refreshIfStale();
        const { rows, total, limit, offset } = await clientes.listClients({
            search: req.query.search,
            city: req.query.city,
            rubro: req.query.rubro,
            health: req.query.health,
            open: req.query.open === '1' || req.query.open === 'true',
            sort: req.query.sort,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        console.error('❌ Error listando clientes:', err.message);
        return fail(res, 'No se pudo cargar la lista de clientes', 500);
    }
});

router.get('/resumen', authenticate, requireRole(...ROLES), async (req, res) => {
    try {
        return ok(res, await clientes.summary());
    } catch (err) {
        console.error('❌ Error en el resumen de clientes:', err.message);
        return fail(res, 'No se pudo cargar el resumen de clientes', 500);
    }
});

router.post('/sync', authenticate, requireRole(...ROLES), async (req, res) => {
    try {
        const result = await clientes.syncClientMetrics();
        console.log(`✅ CRM: sync pedido por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error en el sync de clientes:', err.message);
        return fail(res, `No se pudieron actualizar los clientes desde Odoo: ${err.message}`, 502);
    }
});

router.get('/:partnerId', authenticate, requireRole(...ROLES), async (req, res) => {
    const partnerId = parseInt(req.params.partnerId, 10);
    if (!partnerId) return fail(res, 'Cliente inválido', 400);
    try {
        const cliente = await clientes.getClient(partnerId);
        if (!cliente) return fail(res, 'No encontré ese cliente. Probá actualizar los datos desde Odoo.', 404);
        return ok(res, cliente);
    } catch (err) {
        console.error('❌ Error leyendo la ficha del cliente:', err.message);
        return fail(res, 'No se pudo cargar la ficha del cliente', 500);
    }
});

module.exports = router;
