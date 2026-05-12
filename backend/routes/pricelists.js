// Rutas de listas de precios especiales para clientes

const router = require('express').Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const { getPricelistWithRules, calculateSpecialPrice } = require('../services/pricelistService');

// GET /api/pricelists — lista de pricelists activas
router.get('/', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT pl.*,
                    COUNT(r.id) FILTER (WHERE r.active = true) AS rules_count
             FROM client_pricelists pl
             LEFT JOIN client_pricelist_rules r ON r.pricelist_id = pl.id
             WHERE pl.active = true
             GROUP BY pl.id
             ORDER BY pl.name`
        );
        ok(res, rows);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// POST /api/pricelists — crear lista
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
    const { name, description, default_descuento = 0 } = req.body;
    if (!name?.trim()) return fail(res, 'El nombre es requerido');
    try {
        const { rows } = await pool.query(
            `INSERT INTO client_pricelists (name, description, default_descuento, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [name.trim(), description || null, parseFloat(default_descuento) || 0, req.user.id]
        );
        console.log(`✅ Lista de precios creada: "${name}" (ID: ${rows[0].id})`);
        ok(res, rows[0], 201);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// PUT /api/pricelists/:id — editar lista
router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { name, description, default_descuento } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { params.push(name.trim()); updates.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(description); updates.push(`description = $${params.length}`); }
    if (default_descuento !== undefined) { params.push(parseFloat(default_descuento) || 0); updates.push(`default_descuento = $${params.length}`); }
    if (!updates.length) return fail(res, 'Nada para actualizar');

    params.push(req.params.id);
    try {
        const { rows } = await pool.query(
            `UPDATE client_pricelists SET ${updates.join(', ')}, updated_at = NOW()
             WHERE id = $${params.length} AND active = true RETURNING *`,
            params
        );
        if (!rows.length) return fail(res, 'Lista no encontrada', 404);
        ok(res, rows[0]);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// DELETE /api/pricelists/:id — desactivar (soft delete)
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            'UPDATE client_pricelists SET active = false, updated_at = NOW() WHERE id = $1',
            [req.params.id]
        );
        if (!rowCount) return fail(res, 'Lista no encontrada', 404);
        ok(res, { deleted: true });
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// GET /api/pricelists/:id — detalle con reglas
router.get('/:id', authenticate, async (req, res) => {
    try {
        const data = await getPricelistWithRules(parseInt(req.params.id));
        if (!data) return fail(res, 'Lista no encontrada', 404);
        ok(res, data);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// GET /api/pricelists/:id/rules — reglas de la lista
router.get('/:id/rules', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.*, s.name AS supplier_name
             FROM client_pricelist_rules r
             JOIN suppliers s ON s.id = r.supplier_id
             WHERE r.pricelist_id = $1 AND r.active = true
             ORDER BY s.name`,
            [req.params.id]
        );
        ok(res, rows);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// POST /api/pricelists/:id/rules — agregar regla
router.post('/:id/rules', authenticate, requireRole('admin'), async (req, res) => {
    const { supplier_id, descuento_pct } = req.body;
    if (!supplier_id) return fail(res, 'supplier_id es requerido');
    if (descuento_pct === undefined || descuento_pct === null) return fail(res, 'descuento_pct es requerido');

    try {
        const { rows } = await pool.query(
            `INSERT INTO client_pricelist_rules (pricelist_id, supplier_id, descuento_pct)
             VALUES ($1, $2, $3)
             ON CONFLICT (pricelist_id, supplier_id)
             DO UPDATE SET descuento_pct = EXCLUDED.descuento_pct, active = true
             RETURNING *`,
            [req.params.id, parseInt(supplier_id), parseFloat(descuento_pct)]
        );
        ok(res, rows[0], 201);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// PUT /api/pricelists/:id/rules/:ruleId — editar regla
router.put('/:id/rules/:ruleId', authenticate, requireRole('admin'), async (req, res) => {
    const { descuento_pct } = req.body;
    if (descuento_pct === undefined) return fail(res, 'descuento_pct es requerido');
    try {
        const { rows } = await pool.query(
            `UPDATE client_pricelist_rules SET descuento_pct = $1
             WHERE id = $2 AND pricelist_id = $3 RETURNING *`,
            [parseFloat(descuento_pct), req.params.ruleId, req.params.id]
        );
        if (!rows.length) return fail(res, 'Regla no encontrada', 404);
        ok(res, rows[0]);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// DELETE /api/pricelists/:id/rules/:ruleId — eliminar regla
router.delete('/:id/rules/:ruleId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM client_pricelist_rules WHERE id = $1 AND pricelist_id = $2`,
            [req.params.ruleId, req.params.id]
        );
        if (!rowCount) return fail(res, 'Regla no encontrada', 404);
        ok(res, { deleted: true });
    } catch (err) {
        fail(res, err.message, 500);
    }
});

// GET /api/pricelists/:id/preview — previsualizar precios con la lista
// Devuelve una muestra de productos con su precio calculado
router.get('/:id/preview', authenticate, async (req, res) => {
    const { supplier_id, limit = 10 } = req.query;
    try {
        const data = await getPricelistWithRules(parseInt(req.params.id));
        if (!data) return fail(res, 'Lista no encontrada', 404);

        const conditions = ['sp.available = true', 'sp.raw_price > 0'];
        const params = [];

        if (supplier_id) {
            params.push(parseInt(supplier_id));
            conditions.push(`sp.supplier_id = $${params.length}`);
        }

        params.push(parseInt(limit));
        const { rows: products } = await pool.query(
            `SELECT sp.id, sp.name, sp.sku, sp.raw_price, sp.supplier_id,
                    s.name AS supplier_name
             FROM supplier_products sp
             JOIN suppliers s ON s.id = sp.supplier_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY sp.updated_at DESC
             LIMIT $${params.length}`,
            params
        );

        // Calcular precio para cada producto usando las reglas de la lista
        const rulesMap = Object.fromEntries(
            data.rules.map(r => [r.supplier_id, parseFloat(r.descuento_pct)])
        );

        const preview = products.map(p => {
            const descuento = rulesMap[p.supplier_id] ?? parseFloat(data.default_descuento);
            return {
                ...p,
                raw_price: parseFloat(p.raw_price),
                descuento_aplicado: descuento,
                precio_lista: calculateSpecialPrice(parseFloat(p.raw_price), descuento),
            };
        });

        ok(res, preview);
    } catch (err) {
        fail(res, err.message, 500);
    }
});

module.exports = router;
