// Rutas de alertas de precio
//
// GET  /api/alerts           — lista con filtros (status, type, supplierId, limit, offset)
// GET  /api/alerts/summary   — conteo para dashboard
// PUT  /api/alerts/:id/approve — aprobar alerta (admin)
// PUT  /api/alerts/:id/dismiss — descartar alerta (admin)

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { approveAlert, dismissAlert, getAlertSummary } = require('../services/priceAlertService');

// =============================================
// GET /api/alerts/summary
// Conteo para dashboard — definir ANTES de /:id para evitar conflicto
// =============================================

router.get('/summary', authenticate, async (req, res) => {
    try {
        const summary = await getAlertSummary();
        return ok(res, summary);
    } catch (err) {
        console.error('❌ Error al obtener resumen de alertas:', err.message);
        return fail(res, 'Error al obtener resumen de alertas', 500);
    }
});

// =============================================
// GET /api/alerts
// Lista de alertas con JOIN a supplier_products y suppliers
//
// Query params:
//   status     — 'pending' | 'approved' | 'dismissed'
//   type       — 'price_increase' | 'price_decrease' | 'out_of_stock' | 'back_in_stock'
//   supplierId — filtra por proveedor
//   limit      — default 50, max 200
//   offset     — default 0
// =============================================

router.get('/', authenticate, async (req, res) => {
    const {
        status,
        type,
        supplierId,
        company,
        limit: rawLimit = '50',
        offset: rawOffset = '0'
    } = req.query;

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    try {
        const conditions = [];
        const params = [];
        let idx = 1;

        // Filtro de status: por defecto solo 'pending' (alertas que requieren acción)
        if (status) {
            conditions.push(`pa.status = $${idx++}`);
            params.push(status);
        } else {
            conditions.push(`pa.status = 'pending'`);
        }

        // Filtro de empresa: por defecto solo 'neggo' (las que el admin debe revisar)
        // Pasar ?company=preventas para ver el historial de actualizaciones automáticas
        if (company) {
            conditions.push(`pa.company = $${idx++}`);
            params.push(company);
        } else if (!status) {
            // Sin ningún filtro explícito: mostrar solo Neggo pending (vista default del sidebar)
            conditions.push(`pa.company = 'neggo'`);
        }

        if (type) {
            conditions.push(`pa.alert_type = $${idx++}`);
            params.push(type);
        }

        if (supplierId) {
            conditions.push(`sp.supplier_id = $${idx++}`);
            params.push(parseInt(supplierId, 10));
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const { rows } = await pool.query(
            `SELECT
                pa.id,
                pa.alert_type,
                pa.old_price,
                pa.new_price,
                pa.pct_change,
                pa.status,
                pa.company,
                pa.reviewed_at,
                pa.notes,
                pa.created_at,
                -- Revisor
                u.display_name AS reviewed_by_name,
                -- Producto proveedor
                sp.id           AS supplier_product_id,
                sp.sku          AS supplier_sku,
                sp.name         AS product_name,
                sp.source_category,
                sp.available,
                sp.image_url,
                sp.product_url,
                -- Proveedor
                s.id            AS supplier_id,
                s.name          AS supplier_name,
                s.prefix        AS supplier_prefix
             FROM price_alerts pa
             JOIN supplier_products sp ON pa.supplier_product_id = sp.id
             JOIN suppliers s ON sp.supplier_id = s.id
             LEFT JOIN users u ON pa.reviewed_by = u.id
             ${where}
             ORDER BY pa.created_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        );

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*) AS total
             FROM price_alerts pa
             JOIN supplier_products sp ON pa.supplier_product_id = sp.id
             ${where}`,
            params
        );

        return paginated(res, rows, countRows[0].total, limit, offset);

    } catch (err) {
        console.error('❌ Error al listar alertas:', err.message);
        return fail(res, 'Error al obtener alertas', 500);
    }
});

// =============================================
// PUT /api/alerts/:id/approve
// Aprobar alerta — solo admin
// =============================================

router.put('/:id/approve', authenticate, requireRole('admin'), async (req, res) => {
    const alertId = parseInt(req.params.id, 10);

    if (isNaN(alertId)) {
        return fail(res, 'ID de alerta inválido', 400);
    }

    try {
        const result = await approveAlert(alertId, req.user.id);
        console.log(`✅ Alerta ${alertId} aprobada por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error(`❌ Error al aprobar alerta ${alertId}:`, err.message);
        // Devolver 400 para errores de negocio, 500 para técnicos
        const status = err.message.includes('no encontrada') || err.message.includes('ya fue procesada') ? 400 : 500;
        return fail(res, err.message || 'Error al aprobar la alerta', status);
    }
});

// =============================================
// PUT /api/alerts/:id/dismiss
// Descartar alerta — solo admin
// Body opcional: { note: string }
// =============================================

router.put('/:id/dismiss', authenticate, requireRole('admin'), async (req, res) => {
    const alertId = parseInt(req.params.id, 10);
    const { note = null } = req.body;

    if (isNaN(alertId)) {
        return fail(res, 'ID de alerta inválido', 400);
    }

    try {
        const result = await dismissAlert(alertId, req.user.id, note);
        console.log(`✅ Alerta ${alertId} descartada por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error(`❌ Error al descartar alerta ${alertId}:`, err.message);
        const status = err.message.includes('no encontrada') || err.message.includes('ya fue procesada') ? 400 : 500;
        return fail(res, err.message || 'Error al descartar la alerta', status);
    }
});

module.exports = router;
