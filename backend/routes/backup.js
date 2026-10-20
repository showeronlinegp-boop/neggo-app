// Backup de la base (solo admin)
// GET  /api/backup/estado  — último backup, próximo automático, pedido en curso, copias locales
// POST /api/backup/ahora   — pide un backup ya; lo hace el contenedor db-backup

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const backup = require('../services/backupService');

router.use(authenticate, requireRole('admin'));

router.get('/estado', async (req, res) => {
    try {
        return ok(res, await backup.estado());
    } catch (err) {
        console.error('❌ Error leyendo el estado del backup:', err.message);
        return fail(res, err.message, 500);
    }
});

router.post('/ahora', async (req, res) => {
    try {
        const data = await backup.pedirBackup(req.user.username);
        console.log(`📦 Backup pedido desde la app por ${req.user.username}`);
        return ok(res, data, 202);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error pidiendo backup:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

module.exports = router;
