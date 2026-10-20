// Armado y control de pedidos
// GET    /api/pedido-envios?tab=armar|controlar|hechos&company=neggo&q=
// GET    /api/pedido-envios/:id
// POST   /api/pedido-envios/sync                 { company? }
// POST   /api/pedido-envios/:id/estado           { estado }  // armando: confirma Odoo + ata envío 1
// PATCH  /api/pedido-envios/items/:itemId        { qty_armada? | qty_controlada? }
// POST   /api/pedido-envios/:id/escanear         { code }
// POST   /api/pedido-envios/items/:itemId/faltante  { motivo: archivado|reponer|faltante }
// GET    /api/pedido-envios/:id/preview
// POST   /api/pedido-envios/:id/saldar           escribe Odoo (qty + pedido de pendientes)

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const servicio = require('../services/pedidoEnvioService');

router.use(authenticate, requireRole('admin', 'operador'));

function sendErr(res, err, fallback) {
    if (!err.statusCode) console.error(`❌ ${fallback}:`, err.message);
    return fail(res, err.message, err.statusCode || 500);
}

router.get('/', async (req, res) => {
    try {
        const tab = ['armar', 'controlar', 'hechos'].includes(req.query.tab) ? req.query.tab : 'armar';
        return ok(res, await servicio.listar({
            tab,
            companyKey: req.query.company,
            q: req.query.q,
        }));
    } catch (err) {
        return sendErr(res, err, 'Error listando pedidos para armar');
    }
});

router.post('/sync', async (req, res) => {
    try {
        const company = req.body?.company || req.query.company || 'neggo';
        return ok(res, await servicio.syncDesdeOdoo(company, req.user.id));
    } catch (err) {
        return sendErr(res, err, 'Error sincronizando pedidos de Odoo');
    }
});

router.get('/:id/preview', async (req, res) => {
    try {
        return ok(res, await servicio.preview(parseInt(req.params.id, 10)));
    } catch (err) {
        return sendErr(res, err, 'Error armando preview de saldar');
    }
});

router.get('/:id', async (req, res) => {
    try {
        return ok(res, await servicio.obtener(parseInt(req.params.id, 10)));
    } catch (err) {
        return sendErr(res, err, 'Error obteniendo pedido');
    }
});

router.post('/:id/estado', async (req, res) => {
    try {
        return ok(res, await servicio.cambiarEstado(
            parseInt(req.params.id, 10),
            req.body?.estado,
            req.user.id
        ));
    } catch (err) {
        return sendErr(res, err, 'Error cambiando estado del pedido');
    }
});

router.post('/:id/escanear', async (req, res) => {
    try {
        return ok(res, await servicio.escanear(
            parseInt(req.params.id, 10),
            req.body?.code,
            req.user.id
        ));
    } catch (err) {
        return sendErr(res, err, 'Error escaneando');
    }
});

router.post('/:id/saldar', async (req, res) => {
    try {
        const data = await servicio.saldar(parseInt(req.params.id, 10), req.user.id);
        console.log(`✅ Pedido ${data.odoo_order_name} saldado por usuario ${req.user.id}`
            + (data.backorder_odoo_name ? ` · pendientes ${data.backorder_odoo_name}` : ''));
        return ok(res, data);
    } catch (err) {
        return sendErr(res, err, 'Error saldando pedido con Odoo');
    }
});

router.patch('/items/:itemId', async (req, res) => {
    try {
        const itemId = parseInt(req.params.itemId, 10);
        if (req.body?.qty_armada != null) {
            return ok(res, await servicio.setQty(itemId, 'qty_armada', req.body.qty_armada, req.user.id));
        }
        if (req.body?.qty_controlada != null) {
            return ok(res, await servicio.setQty(itemId, 'qty_controlada', req.body.qty_controlada, req.user.id));
        }
        return fail(res, 'Pasá qty_armada o qty_controlada', 400);
    } catch (err) {
        return sendErr(res, err, 'Error actualizando cantidad');
    }
});

router.post('/items/:itemId/faltante', async (req, res) => {
    try {
        const qty = req.body?.qty == null || req.body?.qty === ''
            ? null
            : Number(req.body.qty);
        return ok(res, await servicio.marcarFaltante(
            parseInt(req.params.itemId, 10),
            req.body?.motivo,
            req.user.id,
            Number.isFinite(qty) ? qty : null
        ));
    } catch (err) {
        return sendErr(res, err, 'Error marcando faltante');
    }
});

module.exports = router;
