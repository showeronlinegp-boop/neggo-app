// Rutas del CRM de clientes
// GET    /api/clientes?search=&city=&rubro=&health=&stage=&open=1&importancia=&sort=prioridad|importancia|facturacion|ultima|compras|nombre|accion&limit=&offset=
// GET    /api/clientes/resumen        — contadores por estado y etapa, facturación, ciudades, rubros y última actualización
// POST   /api/clientes/sync           — vuelve a calcular las métricas desde Odoo
// El listado también acepta cercanos=1: solo la lista de seguimiento cercano
// PUT    /api/clientes/cercanos/:partnerId — { cercano: true|false } suma o saca de esa lista
//
// Posibles clientes (D11)
// GET    /api/clientes/leads?search=&status=&stage=&city=&presentacion=sin|con&celular=1&sort=recientes|nombre|accion&limit=&offset=
// GET    /api/clientes/leads/resumen
// POST   /api/clientes/leads          — alta a mano { name, phone, email, city }
// POST   /api/clientes/leads/importar — { csv, dry_run } CSV de Google Contacts (solo admin)
// GET    /api/clientes/leads/:id
//
// Seguimiento (fase 2). :tipo = cliente | lead
// GET    /api/clientes/mi-dia?mias=1
// GET    /api/clientes/seguimiento/:tipo/:id           — etapa, acciones pendientes e historial
// PUT    /api/clientes/seguimiento/:tipo/:id/etapa     — { stage, reason }
// PUT    /api/clientes/seguimiento/:tipo/:id/importancia — { importance } de 0 a 5
// PUT    /api/clientes/importancia                     — { partner_ids, importance }: varios clientes juntos
// POST   /api/clientes/seguimiento/:tipo/:id/eventos   — { kind, text }
// POST   /api/clientes/seguimiento/:tipo/:id/presentacion — anota el mensaje de presentación mandado por WhatsApp
// POST   /api/clientes/seguimiento/:tipo/:id/acciones  — { type, due_date, note }
// PUT    /api/clientes/acciones/:actionId              — { type, due_date, note }
// POST   /api/clientes/acciones/:actionId/hecha        — { result? }
// POST   /api/clientes/eventos/:eventId/respuesta      — { response: respondio|no_interesa, text? }
//
// GET    /api/clientes/:partnerId     — ficha: métricas, cotizaciones recientes y últimos tickets

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const clientes = require('../services/clientMetricsService');
const followups = require('../services/crmFollowupService');
const leads = require('../services/crmLeadService');

const ROLES = ['admin', 'vendedor'];
const auth = [authenticate, requireRole(...ROLES)];

// Errores de validación (FollowupError) van con su mensaje; el resto, genérico
function handle(res, err, generic) {
    if (err instanceof followups.FollowupError) return fail(res, err.message, err.status);
    console.error(`❌ ${generic}:`, err.message);
    return fail(res, generic, 500);
}

router.get('/', ...auth, async (req, res) => {
    try {
        await clientes.refreshIfStale();
        const { rows, total, limit, offset } = await clientes.listClients({
            search: req.query.search,
            city: req.query.city,
            rubro: req.query.rubro,
            health: req.query.health,
            stage: req.query.stage,
            open: req.query.open === '1' || req.query.open === 'true',
            cercanos: req.query.cercanos === '1' || req.query.cercanos === 'true',
            importancia: req.query.importancia,
            sort: req.query.sort,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la lista de clientes');
    }
});

router.get('/resumen', ...auth, async (req, res) => {
    try {
        return ok(res, await clientes.summary());
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el resumen de clientes');
    }
});

router.post('/sync', ...auth, async (req, res) => {
    try {
        const result = await clientes.syncClientMetrics();
        console.log(`✅ CRM: sync pedido por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error en el sync de clientes:', err.message);
        return fail(res, `No se pudieron actualizar los clientes desde Odoo: ${err.message}`, 502);
    }
});

// ── Posibles clientes ────────────────────────────────────────────

router.get('/leads', ...auth, async (req, res) => {
    try {
        const { rows, total, limit, offset } = await leads.listLeads({
            search: req.query.search,
            status: req.query.status,
            stage: req.query.stage,
            city: req.query.city,
            presentacion: req.query.presentacion,
            celular: req.query.celular === '1' || req.query.celular === 'true',
            sort: req.query.sort,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la lista de posibles clientes');
    }
});

router.get('/leads/resumen', ...auth, async (req, res) => {
    try {
        return ok(res, await leads.leadsSummary());
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el resumen de posibles clientes');
    }
});

router.post('/leads', ...auth, async (req, res) => {
    try {
        const { name, phone, email, city } = req.body || {};
        const result = await leads.createLead({ name, phone, email, city, userId: req.user.id });
        return ok(res, result, 201);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el posible cliente');
    }
});

router.post('/leads/importar', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { csv, dry_run: dryRun } = req.body || {};
        if (!csv) return fail(res, 'Falta el CSV', 400);
        return ok(res, await leads.importGoogleContacts(csv, { userId: req.user.id, dryRun: Boolean(dryRun) }));
    } catch (err) {
        return handle(res, err, 'No se pudieron importar los contactos');
    }
});

router.get('/leads/:id', ...auth, async (req, res) => {
    try {
        const lead = await leads.getLead(req.params.id);
        if (!lead) return fail(res, 'No encontré ese posible cliente', 404);
        return ok(res, lead);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el posible cliente');
    }
});

// ── Seguimiento ──────────────────────────────────────────────────

router.get('/mi-dia', ...auth, async (req, res) => {
    try {
        const mine = req.query.mias === '1' || req.query.mias === 'true';
        return ok(res, await followups.myDay({ userId: req.user.id, mine }));
    } catch (err) {
        return handle(res, err, 'No se pudo cargar Mi día');
    }
});

router.get('/seguimiento/:tipo/:id', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        return ok(res, await followups.getFollowup(target));
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el seguimiento');
    }
});

router.put('/seguimiento/:tipo/:id/etapa', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { stage, reason } = req.body || {};
        return ok(res, await followups.setStage(target, { stage, reason, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la etapa');
    }
});

router.put('/seguimiento/:tipo/:id/importancia', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { importance } = req.body || {};
        return ok(res, await followups.setImportance(target, { importance, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la importancia');
    }
});

router.put('/importancia', ...auth, async (req, res) => {
    try {
        const { partner_ids: partnerIds, importance } = req.body || {};
        return ok(res, await followups.setImportanceMany(partnerIds, { importance, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la importancia');
    }
});

router.post('/seguimiento/:tipo/:id/eventos', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { kind, text } = req.body || {};
        return ok(res, await followups.addEvent(target, { kind, text, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo registrar el contacto');
    }
});

router.post('/seguimiento/:tipo/:id/presentacion', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        return ok(res, await followups.markPresentation(target, { userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo anotar la presentación');
    }
});

router.post('/seguimiento/:tipo/:id/acciones',...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { type, due_date: dueDate, note } = req.body || {};
        return ok(res, await followups.createAction(target, { type, dueDate, note, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo programar la acción');
    }
});

router.put('/acciones/:actionId', ...auth, async (req, res) => {
    try {
        const { type, due_date: dueDate, note } = req.body || {};
        return ok(res, await followups.updateAction(req.params.actionId, { type, dueDate, note }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la acción');
    }
});

router.post('/acciones/:actionId/hecha', ...auth, async (req, res) => {
    try {
        const { result } = req.body || {};
        return ok(res, await followups.completeAction(req.params.actionId, { result, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo marcar la acción como hecha');
    }
});

// ── Lista de seguimiento cercano ─────────────────────────────────

router.put('/cercanos/:partnerId', ...auth, async (req, res) => {
    try {
        const cercano = Boolean(req.body?.cercano);
        const result = await clientes.setCercano(req.params.partnerId, cercano, req.user.id);
        if (!result) return fail(res, 'No encontré ese cliente', 404);
        return ok(res, result);
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la lista de seguimiento cercano');
    }
});

router.post('/eventos/:eventId/respuesta', ...auth, async (req, res) => {
    try {
        const { response, text } = req.body || {};
        return ok(res, await followups.setResponse(req.params.eventId, { response, text, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la respuesta');
    }
});

// ── Ficha del cliente (al final: /:partnerId atrapa cualquier ruta) ──

router.get('/:partnerId', ...auth, async (req, res) => {
    const partnerId = parseInt(req.params.partnerId, 10);
    if (!partnerId) return fail(res, 'Cliente inválido', 400);
    try {
        const cliente = await clientes.getClient(partnerId);
        if (!cliente) return fail(res, 'No encontré ese cliente. Probá actualizar los datos desde Odoo.', 404);
        return ok(res, cliente);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la ficha del cliente');
    }
});

module.exports = router;
