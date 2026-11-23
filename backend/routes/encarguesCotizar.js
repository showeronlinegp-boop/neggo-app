// Encargues a cotizar (nota 248): mercadería que no tenemos y un contacto de Chats pidió averiguar.
// GET    /api/encargues-cotizar?grupo=abiertos|pendiente|cotizado|cerrados — lista (Reposición › A cotizar)
// GET    /api/encargues-cotizar/conteo                — cuántos hay por estado
// GET    /api/encargues-cotizar/contacto/:tipo/:id    — los de un contacto (botón «Pedidos» de Chats)
// POST   /api/encargues-cotizar/contacto/:tipo/:id    — { texto, cantidad?, nota?, contacto_nombre? }
// PUT    /api/encargues-cotizar/:id                   — { texto?, cantidad?, nota? }
// PUT    /api/encargues-cotizar/:id/estado            — { estado, precio?, proveedor? }
// DELETE /api/encargues-cotizar/:id
// Lo usan Clientes (vendedor) y Reposición (operador). No escribe en Odoo.

const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const encargues = require('../services/encarguesCotizarService');

const router = express.Router();
router.use(authenticate, requireRole('admin', 'operador', 'vendedor'));

function handle(res, err, generic) {
    if (err instanceof encargues.EncargueError) return fail(res, err.message, err.status);
    console.error(`❌ ${generic}:`, err.message);
    return fail(res, generic, 500);
}

router.get('/', async (req, res) => {
    try {
        return ok(res, await encargues.listar({ grupo: String(req.query.grupo || 'abiertos') }));
    } catch (err) {
        return handle(res, err, 'No se pudieron leer los encargues a cotizar');
    }
});

router.get('/conteo', async (req, res) => {
    try {
        return ok(res, await encargues.contar());
    } catch (err) {
        return handle(res, err, 'No se pudieron contar los encargues a cotizar');
    }
});

router.get('/contacto/:tipo/:id', async (req, res) => {
    try {
        return ok(res, await encargues.deContacto(req.params.tipo, req.params.id));
    } catch (err) {
        return handle(res, err, 'No se pudieron leer los encargues del contacto');
    }
});

router.post('/contacto/:tipo/:id', async (req, res) => {
    try {
        return ok(res, await encargues.crear(req.params.tipo, req.params.id, req.body || {}, req.user?.id));
    } catch (err) {
        return handle(res, err, 'No se pudo guardar el encargue');
    }
});

router.put('/:id', async (req, res) => {
    try {
        return ok(res, await encargues.editar(req.params.id, req.body || {}));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar el encargue');
    }
});

router.put('/:id/estado', async (req, res) => {
    try {
        return ok(res, await encargues.cambiarEstado(req.params.id, req.body || {}, req.user?.id));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar el estado del encargue');
    }
});

router.delete('/:id', async (req, res) => {
    try {
        return ok(res, await encargues.borrar(req.params.id));
    } catch (err) {
        return handle(res, err, 'No se pudo borrar el encargue');
    }
});

module.exports = router;
