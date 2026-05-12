const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');

// Todas las rutas requieren admin
router.use(authenticate, requireRole('admin'));

// GET /api/users — Listar usuarios
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        const { rows } = await pool.query(
            `SELECT id, username, display_name, role, active, created_at, updated_at
             FROM users ORDER BY display_name ASC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM users');
        const total = parseInt(countRows[0].count, 10);

        return paginated(res, rows, total, limit, offset);
    } catch (error) {
        console.error('❌ Error listando usuarios:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

// POST /api/users — Crear usuario
router.post('/', async (req, res) => {
    try {
        const { username, password, displayName, role } = req.body;

        if (!username || !password || !displayName) {
            return fail(res, 'Faltan campos requeridos: username, password, displayName');
        }

        const validRoles = ['admin', 'operador', 'vendedor'];
        if (role && !validRoles.includes(role)) {
            return fail(res, `Rol inválido. Opciones: ${validRoles.join(', ')}`);
        }

        // Verificar que no exista
        const { rows: existing } = await pool.query(
            'SELECT id FROM users WHERE username = $1', [username]
        );
        if (existing.length > 0) {
            return fail(res, 'El usuario ya existe');
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const { rows } = await pool.query(
            `INSERT INTO users (username, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4) RETURNING id, username, display_name, role, active, created_at`,
            [username, passwordHash, displayName, role || 'operador']
        );

        return ok(res, rows[0], 201);
    } catch (error) {
        console.error('❌ Error creando usuario:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

// PUT /api/users/:id — Editar usuario
router.put('/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const { displayName, role, active, password } = req.body;

        // Construir SET dinámico
        const sets = [];
        const values = [];
        let paramIndex = 1;

        if (displayName !== undefined) {
            sets.push(`display_name = $${paramIndex++}`);
            values.push(displayName);
        }
        if (role !== undefined) {
            const validRoles = ['admin', 'operador', 'vendedor'];
            if (!validRoles.includes(role)) {
                return fail(res, `Rol inválido. Opciones: ${validRoles.join(', ')}`);
            }
            sets.push(`role = $${paramIndex++}`);
            values.push(role);
        }
        if (active !== undefined) {
            sets.push(`active = $${paramIndex++}`);
            values.push(active);
        }
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            sets.push(`password_hash = $${paramIndex++}`);
            values.push(hash);
        }

        if (sets.length === 0) {
            return fail(res, 'No se enviaron campos para actualizar');
        }

        sets.push(`updated_at = NOW()`);
        values.push(userId);

        const { rows } = await pool.query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${paramIndex}
             RETURNING id, username, display_name, role, active, updated_at`,
            values
        );

        if (rows.length === 0) {
            return fail(res, 'Usuario no encontrado', 404);
        }

        return ok(res, rows[0]);
    } catch (error) {
        console.error('❌ Error actualizando usuario:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

// DELETE /api/users/:id — Soft delete
router.delete('/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);

        // No permitir eliminarse a sí mismo
        if (userId === req.user.id) {
            return fail(res, 'No podés desactivar tu propio usuario');
        }

        const { rows } = await pool.query(
            `UPDATE users SET active = false, updated_at = NOW() WHERE id = $1
             RETURNING id, username, display_name`,
            [userId]
        );

        if (rows.length === 0) {
            return fail(res, 'Usuario no encontrado', 404);
        }

        return ok(res, { message: `Usuario '${rows[0].username}' desactivado` });
    } catch (error) {
        console.error('❌ Error eliminando usuario:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

module.exports = router;
