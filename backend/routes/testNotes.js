// Notas de prueba — /api/test-notes (solo admins, solo con TEST_NOTES_ENABLED=1; ver server.js)
// Las notas son compartidas: cualquier admin ve, edita, cambia estado y borra cualquiera.
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const notas = require('../services/testNotesService');

router.use(authenticate, requireRole('admin'));

function manejarError(res, err, accion) {
    if (err.statusCode) return fail(res, err.message, err.statusCode);
    console.error(`❌ Notas de prueba: error al ${accion}:`, err.message);
    return fail(res, `Error al ${accion} la nota`, 500);
}

function idValido(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        fail(res, 'ID inválido');
        return null;
    }
    return id;
}

// GET /api/test-notes?estado=&ruta=&vivas=1
router.get('/', async (req, res) => {
    try {
        const { estado, ruta, vivas } = req.query;
        return ok(res, await notas.listar(pool, { estado, ruta, vivas: vivas === '1' || vivas === 'true' }));
    } catch (err) {
        return manejarError(res, err, 'listar');
    }
});

// GET /api/test-notes/:id
router.get('/:id', async (req, res) => {
    const id = idValido(req, res);
    if (!id) return;
    try {
        const nota = await notas.obtener(pool, id);
        return nota ? ok(res, nota) : fail(res, 'Nota no encontrada', 404);
    } catch (err) {
        return manejarError(res, err, 'leer');
    }
});

// POST /api/test-notes
router.post('/', async (req, res) => {
    try {
        const nota = await notas.crear(pool, req.body || {}, req.user.id);
        console.log(`📦 Nota de prueba #${nota.id} creada por ${req.user.username}`);
        return ok(res, nota, 201);
    } catch (err) {
        return manejarError(res, err, 'crear');
    }
});

// PATCH /api/test-notes/:id — estado, tipo, texto, respuesta, modo
router.patch('/:id', async (req, res) => {
    const id = idValido(req, res);
    if (!id) return;
    try {
        const nota = await notas.actualizar(pool, id, req.body || {});
        return nota ? ok(res, nota) : fail(res, 'Nota no encontrada', 404);
    } catch (err) {
        return manejarError(res, err, 'actualizar');
    }
});

// DELETE /api/test-notes/:id
router.delete('/:id', async (req, res) => {
    const id = idValido(req, res);
    if (!id) return;
    try {
        return (await notas.borrar(pool, id)) ? ok(res, { id }) : fail(res, 'Nota no encontrada', 404);
    } catch (err) {
        return manejarError(res, err, 'borrar');
    }
});

module.exports = router;
