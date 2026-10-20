// Rutas de reposición (solo empresa Neggo)
// GET   /api/reposicion?estado=pendiente|resueltos — cola con datos del producto
// GET   /api/reposicion/buscar?q=                   — productos activos para marcar "reponer"
// POST  /api/reposicion                             — { odoo_id, nota? } marca "reponer" (queda poco)
// PATCH /api/reposicion/:id                         — { estado, qty_decidida?, nota? }

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const reposicion = require('../services/reposicionService');

router.use(authenticate, requireRole('admin', 'operador'));

router.get('/', async (req, res) => {
    try {
        const estado = req.query.estado === 'resueltos' ? 'resueltos' : 'pendiente';
        return ok(res, await reposicion.listar({ estado }));
    } catch (err) {
        console.error('❌ Error listando reposición:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/buscar', async (req, res) => {
    try {
        return ok(res, await reposicion.buscarProductos(req.query.q));
    } catch (err) {
        console.error('❌ Error buscando productos para reponer:', err.message);
        return fail(res, err.message, 500);
    }
});

router.post('/', async (req, res) => {
    const odooId = parseInt(req.body.odoo_id, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id es requerido', 400);
    try {
        const item = await reposicion.agregarReponer(odooId, req.user.id, req.body.nota);
        console.log(`✅ Reposición: "${item.name}" marcado para reponer por usuario ${req.user.id}`);
        return ok(res, item, 201);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error marcando para reponer:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.patch('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return fail(res, 'id inválido', 400);
    try {
        const item = await reposicion.cambiarEstado(id, {
            estado:      req.body.estado,
            qtyDecidida: req.body.qty_decidida,
            nota:        req.body.nota,
        }, req.user.id);
        return ok(res, item);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error actualizando reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

module.exports = router;
