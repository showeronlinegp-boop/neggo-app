const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { fail, paginated } = require('../utils/response');

router.use(authenticate, requireRole('admin'));

// GET /api/activity-log — Consultar log de actividad
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        // Filtros opcionales
        const conditions = [];
        const values = [];
        let paramIndex = 1;

        if (req.query.user_id) {
            conditions.push(`a.user_id = $${paramIndex++}`);
            values.push(parseInt(req.query.user_id, 10));
        }
        if (req.query.module) {
            conditions.push(`a.module = $${paramIndex++}`);
            values.push(req.query.module);
        }
        if (req.query.action) {
            conditions.push(`a.action = $${paramIndex++}`);
            values.push(req.query.action);
        }
        if (req.query.from) {
            conditions.push(`a.created_at >= $${paramIndex++}`);
            values.push(req.query.from);
        }
        if (req.query.to) {
            conditions.push(`a.created_at <= $${paramIndex++}`);
            values.push(req.query.to);
        }

        const whereClause = conditions.length > 0
            ? 'WHERE ' + conditions.join(' AND ')
            : '';

        // Query con join a users para mostrar nombre
        const query = `
            SELECT a.id, a.user_id, u.username, u.display_name as user_display_name,
                   a.module, a.action, a.entity_type, a.entity_id,
                   a.metadata, a.ip_address, a.created_at
            FROM activity_log a
            LEFT JOIN users u ON a.user_id = u.id
            ${whereClause}
            ORDER BY a.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;
        values.push(limit, offset);

        const { rows } = await pool.query(query, values);

        // Count total
        const countQuery = `SELECT COUNT(*) FROM activity_log a ${whereClause}`;
        const countValues = values.slice(0, values.length - 2); // sin limit/offset
        const { rows: countRows } = await pool.query(countQuery, countValues);
        const total = parseInt(countRows[0].count, 10);

        return paginated(res, rows, total, limit, offset);
    } catch (error) {
        console.error('❌ Error consultando activity log:', error.message);
        return fail(res, 'Error interno del servidor', 500);
    }
});

module.exports = router;
