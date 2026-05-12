// CRUD de reglas de categoría por proveedor — tabla supplier_category_rules
// Montado en /api/suppliers, por eso las rutas internas son /:supplierId/rules
//
// Cada regla tiene DOS destinos: dest_category_neggo y dest_category_preventas
// Una misma categoría del proveedor puede mapearse a nombres distintos en cada empresa.
// Los campos odoo_categ_id_neggo y odoo_categ_id_preventas guardan el ID real de Odoo.
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');

// Helper: verificar que el proveedor existe
async function getSupplier(supplierId) {
    const result = await pool.query(
        'SELECT id, name FROM suppliers WHERE id = $1',
        [supplierId]
    );
    return result.rows[0] || null;
}

// =============================================
// GET /:supplierId/scraping-categories
// Categorías únicas presentes en los productos scrapeados del proveedor
// =============================================
router.get('/:supplierId/scraping-categories', authenticate, async (req, res) => {
    try {
        const { supplierId } = req.params;
        const supplier = await getSupplier(supplierId);
        if (!supplier) return fail(res, 'Proveedor no encontrado', 404);

        const result = await pool.query(`
            SELECT source_category, COUNT(*)::INTEGER AS product_count
            FROM supplier_products
            WHERE supplier_id = $1 AND source_category IS NOT NULL AND source_category <> ''
            GROUP BY source_category
            ORDER BY source_category ASC
        `, [supplierId]);

        return ok(res, result.rows);
    } catch (error) {
        console.error('❌ Error al obtener categorías de scraping:', error.message);
        return fail(res, 'Error al obtener categorías', 500);
    }
});

// =============================================
// GET /:supplierId/rules — Lista reglas de un proveedor
// =============================================
router.get('/:supplierId/rules', authenticate, async (req, res) => {
    try {
        const { supplierId } = req.params;

        const supplier = await getSupplier(supplierId);
        if (!supplier) return fail(res, 'Proveedor no encontrado', 404);

        const soloActivas = req.query.active !== 'false';

        let query = `
            SELECT id, supplier_id, source_category,
                   dest_category_neggo, dest_category_preventas,
                   odoo_categ_id_neggo, odoo_categ_id_preventas,
                   ignored, discount_override,
                   markup_override, markup_neggo_override, markup_preventas_override,
                   active, created_at
            FROM supplier_category_rules
            WHERE supplier_id = $1
        `;
        if (soloActivas) query += ` AND active = true`;
        query += ` ORDER BY source_category ASC`;

        const result = await pool.query(query, [supplierId]);
        return ok(res, result.rows);
    } catch (error) {
        console.error('❌ Error al listar reglas de categoría:', error.message);
        return fail(res, 'Error al obtener reglas', 500);
    }
});

// =============================================
// POST /:supplierId/rules — Crear regla (solo admin)
// Body: { source_category, dest_category_neggo, dest_category_preventas,
//         discount_override, markup_override, ignored }
// =============================================
router.post('/:supplierId/rules', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { supplierId } = req.params;

        const supplier = await getSupplier(supplierId);
        if (!supplier) return fail(res, 'Proveedor no encontrado', 404);

        const {
            source_category, dest_category_neggo, dest_category_preventas,
            odoo_categ_id_neggo, odoo_categ_id_preventas,
            discount_override, markup_neggo_override, markup_preventas_override, ignored
        } = req.body;

        if (!source_category?.trim()) {
            return fail(res, 'El campo source_category es obligatorio');
        }

        const result = await pool.query(`
            INSERT INTO supplier_category_rules
                (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
                 odoo_categ_id_neggo, odoo_categ_id_preventas,
                 ignored, discount_override, markup_neggo_override, markup_preventas_override)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, supplier_id, source_category,
                      dest_category_neggo, dest_category_preventas,
                      odoo_categ_id_neggo, odoo_categ_id_preventas,
                      ignored, discount_override,
                      markup_neggo_override, markup_preventas_override, active, created_at
        `, [
            supplierId,
            source_category.trim(),
            dest_category_neggo?.trim() || null,
            dest_category_preventas?.trim() || null,
            odoo_categ_id_neggo || null,
            odoo_categ_id_preventas || null,
            ignored === true,
            discount_override !== undefined ? discount_override : null,
            markup_neggo_override !== undefined ? markup_neggo_override : null,
            markup_preventas_override !== undefined ? markup_preventas_override : null
        ]);

        console.log(`✅ Regla creada para proveedor ${supplierId}: "${source_category}" → neggo="${dest_category_neggo}" / preventas="${dest_category_preventas}"`);
        return ok(res, result.rows[0], 201);
    } catch (error) {
        if (error.code === '23505') {
            return fail(res, 'Ya existe una regla para esa categoría en este proveedor');
        }
        console.error('❌ Error al crear regla de categoría:', error.message);
        return fail(res, 'Error al crear regla', 500);
    }
});

// =============================================
// PUT /:supplierId/rules/:id — Editar regla (solo admin)
// =============================================
router.put('/:supplierId/rules/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { supplierId, id } = req.params;

        const existing = await pool.query(
            'SELECT id FROM supplier_category_rules WHERE id = $1 AND supplier_id = $2',
            [id, supplierId]
        );
        if (existing.rows.length === 0) return fail(res, 'Regla no encontrada', 404);

        const {
            source_category, dest_category_neggo, dest_category_preventas,
            odoo_categ_id_neggo, odoo_categ_id_preventas,
            discount_override, markup_neggo_override, markup_preventas_override,
            ignored, active
        } = req.body;

        const result = await pool.query(`
            UPDATE supplier_category_rules SET
                source_category           = COALESCE($1, source_category),
                dest_category_neggo       = $2,
                dest_category_preventas   = $3,
                odoo_categ_id_neggo       = $4,
                odoo_categ_id_preventas   = $5,
                ignored                   = COALESCE($6, ignored),
                discount_override         = COALESCE($7, discount_override),
                markup_neggo_override     = COALESCE($8, markup_neggo_override),
                markup_preventas_override = COALESCE($9, markup_preventas_override),
                active                    = COALESCE($10, active)
            WHERE id = $11 AND supplier_id = $12
            RETURNING id, supplier_id, source_category,
                      dest_category_neggo, dest_category_preventas,
                      odoo_categ_id_neggo, odoo_categ_id_preventas,
                      ignored, discount_override,
                      markup_neggo_override, markup_preventas_override, active, created_at
        `, [
            source_category?.trim() || null,
            dest_category_neggo !== undefined ? (dest_category_neggo?.trim() || null) : null,
            dest_category_preventas !== undefined ? (dest_category_preventas?.trim() || null) : null,
            odoo_categ_id_neggo !== undefined ? (odoo_categ_id_neggo ? parseInt(odoo_categ_id_neggo) : null) : null,
            odoo_categ_id_preventas !== undefined ? (odoo_categ_id_preventas ? parseInt(odoo_categ_id_preventas) : null) : null,
            ignored !== undefined ? ignored : null,
            discount_override !== undefined ? discount_override : null,
            markup_neggo_override !== undefined ? markup_neggo_override : null,
            markup_preventas_override !== undefined ? markup_preventas_override : null,
            active !== undefined ? active : null,
            id,
            supplierId
        ]);

        console.log(`✅ Regla actualizada: id ${id} (proveedor ${supplierId})`);
        return ok(res, result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return fail(res, 'Ya existe una regla para esa categoría en este proveedor');
        }
        console.error('❌ Error al actualizar regla:', error.message);
        return fail(res, 'Error al actualizar regla', 500);
    }
});

// =============================================
// DELETE /:supplierId/rules/:id — Eliminar regla (solo admin)
// =============================================
router.delete('/:supplierId/rules/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { supplierId, id } = req.params;

        const result = await pool.query(
            'DELETE FROM supplier_category_rules WHERE id = $1 AND supplier_id = $2 RETURNING id, source_category',
            [id, supplierId]
        );

        if (result.rows.length === 0) return fail(res, 'Regla no encontrada', 404);

        console.log(`⚠️ Regla eliminada: "${result.rows[0].source_category}" (id: ${id})`);
        return ok(res, { id: result.rows[0].id, deleted: true });
    } catch (error) {
        console.error('❌ Error al eliminar regla:', error.message);
        return fail(res, 'Error al eliminar regla', 500);
    }
});

module.exports = router;
