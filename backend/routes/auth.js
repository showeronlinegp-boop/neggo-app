const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, generateToken } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return fail(res, 'Usuario y contraseña son requeridos');
        }

        // Buscar usuario
        const { rows } = await pool.query(
            'SELECT id, username, password_hash, display_name, role, active FROM users WHERE username = $1',
            [username]
        );

        if (rows.length === 0) {
            return fail(res, 'Usuario o contraseña incorrectos', 401);
        }

        const user = rows[0];

        if (!user.active) {
            return fail(res, 'Usuario desactivado', 401);
        }

        // Verificar contraseña
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return fail(res, 'Usuario o contraseña incorrectos', 401);
        }

        // Generar token
        const token = generateToken(user);

        return ok(res, {
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name,
                role: user.role
            }
        });
    } catch (error) {
        console.error('❌ Error en login:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
    // JWT stateless: el frontend descarta el token
    return ok(res, { message: 'Sesión cerrada' });
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, username, display_name, role, active, created_at FROM users WHERE id = $1',
            [req.user.id]
        );

        if (rows.length === 0) {
            return fail(res, 'Usuario no encontrado', 404);
        }

        const user = rows[0];
        return ok(res, {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            display_name: user.display_name,
            role: user.role,
            active: user.active,
            createdAt: user.created_at
        });
    } catch (error) {
        console.error('❌ Error en /me:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

module.exports = router;
