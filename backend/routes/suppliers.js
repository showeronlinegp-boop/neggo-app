// CRUD de proveedores — tabla suppliers
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const { getProductCategories } = require('../services/odooService');
const { getAvailableKeys } = require('../scrapers/registry');

// Valida scraper_key: vacío/null = sin fuente, o una clave registrada
function validarScraperKey(key) {
    if (key === null || key === undefined || key === '') return null;
    if (!getAvailableKeys().includes(key)) {
        return `Fuente de scraping desconocida: "${key}". Opciones: ${getAvailableKeys().join(', ')}`;
    }
    return null;
}

// =============================================
// GET / — Lista todos los proveedores
// Query param: ?active=true|false (sin filtro = todos)
// =============================================
router.get('/', authenticate, async (req, res) => {
    try {
        let query = `
            SELECT id, name, prefix, website_url, scraper_key, price_format,
                   is_published, default_discount, default_markup,
                   markup_neggo, markup_preventas, scrape_schedule,
                   last_scraped_at, active, status, scrape_enabled, created_at, updated_at,
                   (
                       status = 'active'
                       AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '7 days')
                   ) AS is_stale
            FROM suppliers
        `;
        const params = [];

        if (req.query.active !== undefined) {
            const activeValue = req.query.active === 'true';
            query += ` WHERE active = $1`;
            params.push(activeValue);
        }

        query += ` ORDER BY name ASC`;

        const result = await pool.query(query, params);
        return ok(res, result.rows);
    } catch (error) {
        console.error('❌ Error al listar proveedores:', error.message);
        return fail(res, 'Error al obtener proveedores', 500);
    }
});

// =============================================
// GET /unmapped-summary — Resumen global de categorías sin mapear
// Retorna el total y el detalle por proveedor
// =============================================
router.get('/unmapped-summary', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT pcm.supplier_id, s.name AS supplier_name,
                   COUNT(*) AS unmapped_count
            FROM pending_category_mappings pcm
            JOIN suppliers s ON s.id = pcm.supplier_id
            WHERE pcm.status = 'pending'
            GROUP BY pcm.supplier_id, s.name
            ORDER BY s.name
        `);
        const totalUnmapped = rows.reduce((sum, r) => sum + parseInt(r.unmapped_count), 0);
        return ok(res, { totalUnmapped, bySupplier: rows });
    } catch (error) {
        console.error('❌ Error al obtener resumen de categorías sin mapear:', error.message);
        return fail(res, 'Error al obtener resumen', 500);
    }
});

// =============================================
// GET /odoo-categories?company=neggo|preventas
// Árbol de categorías de productos de Odoo (para mapear reglas de categoría)
// Debe ir ANTES de /:id para que Express no interprete "odoo-categories" como un ID
// =============================================
router.get('/odoo-categories', authenticate, async (req, res) => {
    try {
        const { company = 'neggo' } = req.query;
        if (!['neggo', 'preventas'].includes(company)) {
            return fail(res, 'company debe ser "neggo" o "preventas"');
        }
        const categories = await getProductCategories(company);
        return ok(res, categories);
    } catch (error) {
        console.error('❌ Error al obtener categorías Odoo:', error.message);
        return fail(res, 'Error al obtener categorías de Odoo', 500);
    }
});

// =============================================
// GET /scraper-keys — Fuentes de scraping disponibles (para el selector del form)
// Debe ir ANTES de /:id
// =============================================
router.get('/scraper-keys', authenticate, async (req, res) => {
    return ok(res, getAvailableKeys());
});

// =============================================
// GET /:id — Detalle de un proveedor
// =============================================
router.get('/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, name, prefix, website_url, scraper_key, price_format,
                    is_published, default_discount, default_markup,
                    markup_neggo, markup_preventas, scrape_schedule,
                    last_scraped_at, active, status, scrape_enabled, created_at, updated_at,
                    (
                        status = 'active'
                        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '7 days')
                    ) AS is_stale
             FROM suppliers
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        return ok(res, result.rows[0]);
    } catch (error) {
        console.error('❌ Error al obtener proveedor:', error.message);
        return fail(res, 'Error al obtener proveedor', 500);
    }
});

// =============================================
// POST / — Crear proveedor (solo admin)
// =============================================
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const {
            name, prefix, website_url, scraper_key, price_format,
            is_published, default_discount, default_markup,
            markup_neggo, markup_preventas, scrape_schedule, scrape_enabled
        } = req.body;

        // Validaciones obligatorias
        if (!name || !name.trim()) {
            return fail(res, 'El campo name es obligatorio');
        }
        if (!prefix || !prefix.trim()) {
            return fail(res, 'El campo prefix es obligatorio');
        }
        const errorKey = validarScraperKey(scraper_key);
        if (errorKey) return fail(res, errorKey);

        const result = await pool.query(
            `INSERT INTO suppliers
                (name, prefix, website_url, scraper_key, price_format,
                 is_published, default_discount, default_markup,
                 markup_neggo, markup_preventas, scrape_schedule, scrape_enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id, name, prefix, website_url, scraper_key, price_format,
                       is_published, default_discount, default_markup,
                       markup_neggo, markup_preventas, scrape_schedule,
                       last_scraped_at, active, status, scrape_enabled, created_at, updated_at`,
            [
                name.trim(),
                prefix.trim(),
                website_url || null,
                scraper_key || null,
                price_format || 'ar',
                is_published !== undefined ? is_published : true,
                default_discount !== undefined ? default_discount : 0,
                default_markup !== undefined ? default_markup : 0,
                markup_neggo !== undefined ? markup_neggo : 0,
                markup_preventas !== undefined ? markup_preventas : 0,
                scrape_schedule || null,
                // Por defecto se habilita si tiene fuente
                scrape_enabled !== undefined ? !!scrape_enabled : !!scraper_key
            ]
        );

        console.log(`✅ Proveedor creado: ${result.rows[0].name} (id: ${result.rows[0].id})`);
        return ok(res, result.rows[0], 201);
    } catch (error) {
        if (error.code === '23505') {
            // unique_violation — name ya existe
            return fail(res, 'Ya existe un proveedor con ese nombre');
        }
        console.error('❌ Error al crear proveedor:', error.message);
        return fail(res, 'Error al crear proveedor', 500);
    }
});

// =============================================
// GET /:id/unmapped-categories — Categorías sin regla para un proveedor
// =============================================
router.get('/:id/unmapped-categories', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT sp.source_category, COUNT(sp.id) AS product_count
            FROM supplier_products sp
            WHERE sp.supplier_id = $1
              AND sp.available = true
              AND NOT EXISTS (
                  SELECT 1 FROM supplier_category_rules scr
                  WHERE scr.supplier_id = sp.supplier_id
                    AND scr.source_category = sp.source_category
                    AND scr.active = true
              )
            GROUP BY sp.source_category
            ORDER BY sp.source_category
        `, [req.params.id]);
        return ok(res, rows);
    } catch (error) {
        console.error('❌ Error al obtener categorías sin mapear:', error.message);
        return fail(res, 'Error al obtener categorías', 500);
    }
});

// =============================================
// PUT /:id — Editar proveedor (solo admin)
// =============================================
router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar que existe
        const existing = await pool.query('SELECT id FROM suppliers WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        const {
            name, prefix, website_url, scraper_key, price_format,
            is_published, default_discount, default_markup,
            markup_neggo, markup_preventas, scrape_schedule,
            last_scraped_at, active, scrape_enabled
        } = req.body;

        const errorKey = validarScraperKey(scraper_key);
        if (errorKey) return fail(res, errorKey);

        const result = await pool.query(
            `UPDATE suppliers SET
                name              = COALESCE($1, name),
                prefix            = COALESCE($2, prefix),
                website_url       = COALESCE($3, website_url),
                -- scraper_key: si viene en el body se pisa (vacío = sin fuente); si no, se mantiene
                scraper_key       = CASE WHEN $15::BOOLEAN THEN $4 ELSE scraper_key END,
                scrape_enabled    = COALESCE($16, scrape_enabled),
                price_format      = COALESCE($5, price_format),
                is_published      = COALESCE($6, is_published),
                default_discount  = COALESCE($7, default_discount),
                default_markup    = COALESCE($8, default_markup),
                markup_neggo      = COALESCE($9, markup_neggo),
                markup_preventas  = COALESCE($10, markup_preventas),
                scrape_schedule   = COALESCE($11, scrape_schedule),
                last_scraped_at   = COALESCE($12, last_scraped_at),
                active            = COALESCE($13, active),
                updated_at        = NOW()
             WHERE id = $14
             RETURNING id, name, prefix, website_url, scraper_key, price_format,
                       is_published, default_discount, default_markup,
                       markup_neggo, markup_preventas, scrape_schedule,
                       last_scraped_at, active, status, scrape_enabled, created_at, updated_at`,
            [
                name?.trim() || null,
                prefix?.trim() || null,
                website_url !== undefined ? website_url : null,
                scraper_key ? scraper_key : null,
                price_format || null,
                is_published !== undefined ? is_published : null,
                default_discount !== undefined ? default_discount : null,
                default_markup !== undefined ? default_markup : null,
                markup_neggo !== undefined ? markup_neggo : null,
                markup_preventas !== undefined ? markup_preventas : null,
                scrape_schedule !== undefined ? scrape_schedule : null,
                last_scraped_at || null,
                active !== undefined ? active : null,
                id,
                scraper_key !== undefined,
                scrape_enabled !== undefined ? !!scrape_enabled : null
            ]
        );

        console.log(`✅ Proveedor actualizado: id ${id}`);
        return ok(res, result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return fail(res, 'Ya existe un proveedor con ese nombre');
        }
        console.error('❌ Error al actualizar proveedor:', error.message);
        return fail(res, 'Error al actualizar proveedor', 500);
    }
});

// =============================================
// POST /:id/scraping/toggle — Activa/pausa el scraping del proveedor (solo admin)
// Body opcional: { enabled: true|false } — sin body invierte el valor actual
// =============================================
router.post('/:id/scraping/toggle', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { enabled } = req.body || {};
        const { rows } = await pool.query(
            `UPDATE suppliers
             SET scrape_enabled = CASE WHEN $2::BOOLEAN IS NULL THEN NOT scrape_enabled ELSE $2::BOOLEAN END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, scraper_key, scrape_enabled`,
            [id, enabled === undefined ? null : !!enabled]
        );
        if (rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }
        const s = rows[0];
        if (s.scrape_enabled && !s.scraper_key) {
            console.log(`⚠️ "${s.name}" quedó con scraping activo pero sin fuente configurada`);
        }
        console.log(`${s.scrape_enabled ? '✅' : '⚠️'} Scraping de "${s.name}" ${s.scrape_enabled ? 'activado' : 'pausado'}`);
        return ok(res, s);
    } catch (error) {
        console.error('❌ Error al cambiar estado de scraping:', error.message);
        return fail(res, 'Error al cambiar estado de scraping', 500);
    }
});

// =============================================
// POST /:id/promote — Promover proveedor staging → active (solo admin)
// Una vez activo, el scheduler lo incluye y el resto del sistema lo procesa
// =============================================
router.post('/:id/promote', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query(
            `UPDATE suppliers
             SET status = 'active', updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, prefix, website_url, scraper_key, price_format,
                       is_published, default_discount, default_markup,
                       markup_neggo, markup_preventas, scrape_schedule,
                       last_scraped_at, active, status, scrape_enabled, created_at, updated_at`,
            [id]
        );

        if (rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        console.log(`✅ Proveedor "${rows[0].name}" (id: ${id}) promovido a active`);
        return ok(res, rows[0]);
    } catch (error) {
        console.error('❌ Error al promover proveedor:', error.message);
        return fail(res, 'Error al promover proveedor', 500);
    }
});

// =============================================
// POST /:id/stage — Volver proveedor a staging (solo admin)
// El proveedor deja de ser procesado por el scheduler y servicios
// =============================================
router.post('/:id/stage', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query(
            `UPDATE suppliers
             SET status = 'staging', updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, prefix, website_url, scraper_key, price_format,
                       is_published, default_discount, default_markup,
                       markup_neggo, markup_preventas, scrape_schedule,
                       last_scraped_at, active, status, scrape_enabled, created_at, updated_at`,
            [id]
        );

        if (rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        console.log(`⚠️ Proveedor "${rows[0].name}" (id: ${id}) movido a staging`);
        return ok(res, rows[0]);
    } catch (error) {
        console.error('❌ Error al mover proveedor a staging:', error.message);
        return fail(res, 'Error al mover proveedor a staging', 500);
    }
});

// =============================================
// DELETE /:id/products — Elimina TODOS los productos scrapeados de un proveedor (solo admin)
// Borra supplier_products físicamente (cascada elimina price_history, product_mappings, etc.)
// El proveedor en sí NO se toca — queda activo, solo se limpian sus productos.
// =============================================
router.delete('/:id/products', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const supplierCheck = await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [id]);
        if (supplierCheck.rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }
        const supplierName = supplierCheck.rows[0].name;

        const { rowCount } = await pool.query(
            'DELETE FROM supplier_products WHERE supplier_id = $1',
            [id]
        );

        console.log(`⚠️ ${rowCount} productos eliminados del proveedor "${supplierName}" (id: ${id})`);
        return ok(res, { deleted: rowCount, supplier: supplierName });
    } catch (error) {
        console.error('❌ Error al eliminar productos del proveedor:', error.message);
        return fail(res, 'Error al eliminar productos del proveedor', 500);
    }
});

// =============================================
// DELETE /:id — Desactiva el proveedor y elimina todos sus productos scrapeados
// Pone active=false y borra supplier_products (cascada elimina price_history, mappings, sync_state)
// =============================================
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;

        await client.query('BEGIN');

        const supplierRes = await client.query(
            'SELECT id, name FROM suppliers WHERE id = $1',
            [id]
        );
        if (supplierRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return fail(res, 'Proveedor no encontrado', 404);
        }
        const { name } = supplierRes.rows[0];

        const { rowCount: deleted } = await client.query(
            'DELETE FROM supplier_products WHERE supplier_id = $1',
            [id]
        );

        await client.query(
            'UPDATE suppliers SET active = false, updated_at = NOW() WHERE id = $1',
            [id]
        );

        await client.query('COMMIT');

        console.log(`⚠️ Proveedor desactivado: "${name}" (id: ${id}) — ${deleted} productos eliminados`);
        return ok(res, { id: parseInt(id), name, active: false, deleted_products: deleted });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error al desactivar proveedor:', error.message);
        return fail(res, 'Error al desactivar proveedor', 500);
    } finally {
        client.release();
    }
});

// =============================================
// GET /:id/pending-categories — Categorías pendientes de mapeo
// =============================================
router.get('/:id/pending-categories', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, supplier_id, source_category, sample_products, status, created_at
            FROM pending_category_mappings
            WHERE supplier_id = $1 AND status = 'pending'
            ORDER BY created_at DESC
        `, [req.params.id]);
        return ok(res, rows);
    } catch (error) {
        console.error('❌ Error al obtener categorías pendientes:', error.message);
        return fail(res, 'Error al obtener categorías pendientes', 500);
    }
});

// =============================================
// POST /:id/pending-categories/:pendingId/resolve — Resolver categoría pendiente
// Body: { action: 'map' | 'ignore', dest_category_neggo, dest_category_preventas,
//         discount_override, markup_neggo_override, markup_preventas_override }
// =============================================
router.post('/:id/pending-categories/:pendingId/resolve', authenticate, requireRole('admin'), async (req, res) => {
    const { id, pendingId } = req.params;
    const {
        action, dest_category_neggo, dest_category_preventas,
        discount_override, markup_neggo_override, markup_preventas_override
    } = req.body;

    if (!action || !['map', 'ignore'].includes(action)) {
        return fail(res, 'El campo action debe ser "map" o "ignore"');
    }

    try {
        // Verificar que existe el pending
        const { rows: pending } = await pool.query(
            'SELECT id, source_category FROM pending_category_mappings WHERE id = $1 AND supplier_id = $2',
            [pendingId, id]
        );
        if (pending.length === 0) {
            return fail(res, 'Categoría pendiente no encontrada', 404);
        }
        const { source_category } = pending[0];

        if (action === 'map') {
            // Crear regla en supplier_category_rules
            await pool.query(`
                INSERT INTO supplier_category_rules
                    (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
                     discount_override, markup_neggo_override, markup_preventas_override, ignored, active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
                ON CONFLICT (supplier_id, source_category)
                DO UPDATE SET
                    dest_category_neggo       = EXCLUDED.dest_category_neggo,
                    dest_category_preventas   = EXCLUDED.dest_category_preventas,
                    discount_override         = EXCLUDED.discount_override,
                    markup_neggo_override     = EXCLUDED.markup_neggo_override,
                    markup_preventas_override = EXCLUDED.markup_preventas_override,
                    ignored                   = false,
                    active                    = true
            `, [
                id, source_category,
                dest_category_neggo || null,
                dest_category_preventas || null,
                discount_override !== undefined ? discount_override : null,
                markup_neggo_override !== undefined ? markup_neggo_override : null,
                markup_preventas_override !== undefined ? markup_preventas_override : null
            ]);
        } else {
            // Ignorar: crear regla con ignored=true
            await pool.query(`
                INSERT INTO supplier_category_rules
                    (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
                     ignored, active)
                VALUES ($1, $2, NULL, NULL, true, true)
                ON CONFLICT (supplier_id, source_category)
                DO UPDATE SET ignored = true, active = true
            `, [id, source_category]);
        }

        // Marcar pending como resuelto
        await pool.query(`
            UPDATE pending_category_mappings
            SET status = $1, resolved_at = NOW(), resolved_by = $2
            WHERE id = $3
        `, [action === 'map' ? 'mapped' : 'ignored', req.user.id, pendingId]);

        console.log(`✅ Categoría "${source_category}" resuelta como "${action}" por usuario ${req.user.id}`);
        return ok(res, { source_category, action });
    } catch (error) {
        console.error('❌ Error al resolver categoría pendiente:', error.message);
        return fail(res, 'Error al resolver categoría pendiente', 500);
    }
});

module.exports = router;
