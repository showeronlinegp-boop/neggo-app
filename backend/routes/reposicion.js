// Rutas de reposición (solo empresa Neggo)
// GET    /api/reposicion?estado=pendiente|resueltos
// GET    /api/reposicion/buscar?q=
// GET    /api/reposicion/barcode?code=
// GET    /api/reposicion/proveedor?nombre=
// POST   /api/reposicion                             — { odoo_id, nota?, origen? }
// POST   /api/reposicion/generar-oc                  — { vendor_name, items, partner_id? }
// PATCH  /api/reposicion/:id                         — { estado, qty_decidida?, nota? }

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

router.get('/barcode', async (req, res) => {
    try {
        const prod = await reposicion.buscarPorBarcode(req.query.code);
        if (!prod) return fail(res, 'No hay producto con ese código de barras en Neggo', 404);
        return ok(res, prod);
    } catch (err) {
        console.error('❌ Error buscando por barcode:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/proveedor', async (req, res) => {
    try {
        return ok(res, await reposicion.detalleProveedor(req.query.nombre));
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error detalle proveedor reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/', async (req, res) => {
    const odooId = parseInt(req.body.odoo_id, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id es requerido', 400);
    try {
        const origen = req.body.origen === 'recorrida' ? 'recorrida' : 'reponer';
        const item = await reposicion.agregarReponer(odooId, req.user.id, req.body.nota, origen);
        console.log(`✅ Reposición: "${item.name}" marcado (${origen}) por usuario ${req.user.id}`);
        return ok(res, item, 201);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error marcando para reponer:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/generar-oc', async (req, res) => {
    try {
        const result = await reposicion.generarOc({
            vendorName: req.body.vendor_name,
            items: req.body.items,
            partnerId: req.body.partner_id,
            userId: req.user.id,
        });
        return ok(res, result, 201);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error generando OC de reposición:', err.message);
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
