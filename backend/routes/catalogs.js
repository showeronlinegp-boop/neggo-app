// Rutas de catálogos PDF
// Generación por categoría de Odoo, listado y descarga

const path = require('path');
const router = require('express').Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { generateCatalog, generateAllCatalogs, getCatalogCategories } = require('../services/catalogService');

// GET /api/catalogs/categories — categorías de Odoo con productos para catálogo
// Query: ?type=preventas|neggo (default: preventas). Devuelve [{ name, count }]
router.get('/categories', authenticate, async (req, res) => {
    const type = req.query.type === 'neggo' ? 'neggo' : 'preventas';

    try {
        ok(res, await getCatalogCategories(type));
    } catch (err) {
        console.error('❌ Error al obtener categorías:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/catalogs/generate — generar catálogo PDF
// Body: { destCategory, type } | { all: true, type }
router.post('/generate', authenticate, requireRole('admin', 'vendedor'), async (req, res) => {
    const { destCategory, type = 'preventas', all } = req.body;

    if (!['preventas', 'neggo'].includes(type)) {
        return fail(res, 'type debe ser "preventas" o "neggo"');
    }

    try {
        if (all) {
            console.log(`📦 Generando todos los catálogos (${type})...`);
            const results = await generateAllCatalogs({ type, createdBy: req.user.id });
            const generados = results.filter(r => r.success).length;
            return ok(res, { results, generados, total: results.length }, 201);
        }

        if (!destCategory) return fail(res, 'destCategory es requerido');

        console.log(`📦 Generando catálogo "${destCategory}" (${type})...`);
        const result = await generateCatalog({ destCategory, type, createdBy: req.user.id });
        console.log(`✅ Catálogo generado: ${result.productCount} productos`);
        ok(res, result, 201);
    } catch (err) {
        console.error('❌ Error al generar catálogo:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/catalogs — lista de catálogos generados
router.get('/', authenticate, async (req, res) => {
    const { type, limit = 20, offset = 0 } = req.query;
    try {
        const conditions = [];
        const params = [];

        if (type) { params.push(type); conditions.push(`c.type = $${params.length}`); }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM catalogs c ${where}`, params
        );

        params.push(parseInt(limit), parseInt(offset));
        const { rows } = await pool.query(
            `SELECT c.*, u.username as created_by_username, du.username as downloaded_by_username
             FROM catalogs c
             LEFT JOIN users u ON u.id = c.generated_by
             LEFT JOIN users du ON du.id = c.downloaded_by
             ${where}
             ORDER BY c.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        paginated(res, rows, countResult.rows[0].count, limit, offset);
    } catch (err) {
        console.error('❌ Error al listar catálogos:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/catalogs/:id/download — descargar PDF
router.get('/:id/download', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM catalogs WHERE id = $1',
            [req.params.id]
        );
        if (!rows.length) return fail(res, 'Catálogo no encontrado', 404);

        const catalog = rows[0];
        const filePath = path.resolve(catalog.file_path);

        res.download(filePath, `catalogo-${catalog.category || catalog.type}-${catalog.id}.pdf`, async (err) => {
            if (err) {
                console.error('❌ Error al descargar catálogo:', err.message);
                if (!res.headersSent) fail(res, 'Error al descargar el archivo', 500);
                return;
            }
            // Marca el catálogo como descargado (la UI lo pinta dorado: ya se mandó)
            try {
                await pool.query(
                    'UPDATE catalogs SET downloaded_at = NOW(), downloaded_by = $2 WHERE id = $1',
                    [catalog.id, req.user.id]
                );
            } catch (e) {
                console.error('⚠️ No se pudo marcar el catálogo como descargado:', e.message);
            }
        });
    } catch (err) {
        console.error('❌ Error al descargar catálogo:', err.message);
        fail(res, err.message, 500);
    }
});

module.exports = router;
