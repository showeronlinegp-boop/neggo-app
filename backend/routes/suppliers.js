// CRUD de proveedores — tabla suppliers
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const { getProductCategories, getPartners, getPartnerById } = require('../services/odooService');
const { getAvailableKeys } = require('../scrapers/registry');

// Columnas que devuelve la API de proveedores
const SUPPLIER_COLS = `
    id, name, prefix, website_url, scraper_key, price_format,
    default_discount, markup_neggo, markup_preventas,
    scrape_config, last_scraped_at, active, scrape_enabled, created_at, updated_at
`;

// Categorías del proveedor con productos disponibles y sin regla activa.
// Se calcula en vivo: apenas se crea la regla, la categoría deja de figurar como pendiente.
const UNMAPPED_SQL = `
    SELECT sp.supplier_id, s.name AS supplier_name, sp.source_category,
           COUNT(*)::INTEGER AS product_count,
           (ARRAY_AGG(sp.name ORDER BY sp.name))[1:3] AS sample_products
    FROM supplier_products sp
    JOIN suppliers s ON s.id = sp.supplier_id AND s.active = true
    WHERE sp.available = true
      AND NULLIF(TRIM(sp.source_category), '') IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM supplier_category_rules scr
          WHERE scr.supplier_id = sp.supplier_id
            AND scr.source_category = sp.source_category
            AND scr.active = true
      )
`;

// Valida scraper_key: vacío/null = sin fuente, o una clave registrada
function validarScraperKey(key) {
    if (key === null || key === undefined || key === '') return null;
    if (!getAvailableKeys().includes(key)) {
        return `Fuente de scraping desconocida: "${key}". Opciones: ${getAvailableKeys().join(', ')}`;
    }
    return null;
}

// Agrega los campos calculados que usa el frontend:
// - scraper_available: la fuente tiene un scraper registrado (se puede ejecutar)
// - is_stale: scrapea pero hace más de 7 días que no corre
function withComputed(row) {
    const scraperAvailable = !!row.scraper_key && getAvailableKeys().includes(row.scraper_key);
    const last = row.last_scraped_at ? new Date(row.last_scraped_at).getTime() : null;
    const isStale = row.active && row.scrape_enabled && scraperAvailable
        && (last === null || Date.now() - last > 7 * 24 * 60 * 60 * 1000);
    return { ...row, scraper_available: scraperAvailable, is_stale: isStale };
}

// =============================================
// GET / — Lista todos los proveedores
// Query param: ?active=true|false (sin filtro = todos)
// =============================================
router.get('/', authenticate, async (req, res) => {
    try {
        let query = `SELECT ${SUPPLIER_COLS} FROM suppliers`;
        const params = [];

        if (req.query.active !== undefined) {
            query += ` WHERE active = $1`;
            params.push(req.query.active === 'true');
        }

        query += ` ORDER BY name ASC`;

        const result = await pool.query(query, params);
        return ok(res, result.rows.map(withComputed));
    } catch (error) {
        console.error('❌ Error al listar proveedores:', error.message);
        return fail(res, 'Error al obtener proveedores', 500);
    }
});

// =============================================
// GET /unmapped-summary — Resumen global de categorías sin regla
// Retorna el total y el detalle por proveedor (badge del sidebar y de la lista)
// =============================================
router.get('/unmapped-summary', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT supplier_id, supplier_name, COUNT(*)::INTEGER AS unmapped_count
            FROM (${UNMAPPED_SQL} GROUP BY sp.supplier_id, s.name, sp.source_category) u
            GROUP BY supplier_id, supplier_name
            ORDER BY supplier_name
        `);
        const totalUnmapped = rows.reduce((sum, r) => sum + r.unmapped_count, 0);
        return ok(res, { totalUnmapped, bySupplier: rows });
    } catch (error) {
        console.error('❌ Error al obtener resumen de categorías sin mapear:', error.message);
        return fail(res, 'Error al obtener resumen', 500);
    }
});

// =============================================
// GET /pending-categories — Categorías sin regla de todos los proveedores
// Con hasta 3 productos de ejemplo para decidir la categoría de Odoo
// =============================================
router.get('/pending-categories', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            ${UNMAPPED_SQL}
            GROUP BY sp.supplier_id, s.name, sp.source_category
            ORDER BY s.name, sp.source_category
        `);
        return ok(res, rows);
    } catch (error) {
        console.error('❌ Error al obtener categorías pendientes:', error.message);
        return fail(res, 'Error al obtener categorías pendientes', 500);
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
// GET /odoo-partners?q=texto — Busca proveedores en Odoo (solo lectura)
// Para la fuente interna: indica de qué partner de Odoo salen los productos
// =============================================
router.get('/odoo-partners', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return ok(res, []);
        const partners = await getPartners({ type: 'supplier', search: q });
        return ok(res, partners.map(p => ({ id: p.id, name: p.name })));
    } catch (error) {
        console.error('❌ Error al buscar proveedores en Odoo:', error.message);
        return fail(res, 'Error al buscar en Odoo', 500);
    }
});

// =============================================
// GET /odoo-partners/:partnerId — Nombre de un partner de Odoo (solo lectura)
// =============================================
router.get('/odoo-partners/:partnerId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const partner = await getPartnerById(parseInt(req.params.partnerId, 10));
        if (!partner) return fail(res, 'Proveedor no encontrado en Odoo', 404);
        return ok(res, { id: partner.id, name: partner.name });
    } catch (error) {
        console.error('❌ Error al leer proveedor de Odoo:', error.message);
        return fail(res, 'Error al consultar Odoo', 500);
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
        const result = await pool.query(
            `SELECT ${SUPPLIER_COLS} FROM suppliers WHERE id = $1`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        return ok(res, withComputed(result.rows[0]));
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
            default_discount, markup_neggo, markup_preventas, scrape_enabled, odoo_partner_id
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

        const scrapeConfig = odoo_partner_id ? { odoo_partner_id: parseInt(odoo_partner_id, 10) } : {};

        const result = await pool.query(
            `INSERT INTO suppliers
                (name, prefix, website_url, scraper_key, price_format,
                 default_discount, markup_neggo, markup_preventas, scrape_enabled, scrape_config)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING ${SUPPLIER_COLS}`,
            [
                name.trim(),
                prefix.trim(),
                website_url || null,
                scraper_key || null,
                price_format || 'ar',
                default_discount ?? 0,
                markup_neggo ?? 0,
                markup_preventas ?? 0,
                // Por defecto se habilita si tiene fuente
                scraper_key ? (scrape_enabled !== undefined ? !!scrape_enabled : true) : false,
                JSON.stringify(scrapeConfig)
            ]
        );

        console.log(`✅ Proveedor creado: ${result.rows[0].name} (id: ${result.rows[0].id})`);
        return ok(res, withComputed(result.rows[0]), 201);
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
            ${UNMAPPED_SQL}
              AND sp.supplier_id = $1
            GROUP BY sp.supplier_id, s.name, sp.source_category
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
// Solo se pisan los campos que vienen en el body.
// odoo_partner_id se guarda dentro de scrape_config (lo usa la fuente interna Neggo).
// =============================================
router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await pool.query('SELECT id FROM suppliers WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }

        const {
            name, prefix, website_url, scraper_key, price_format,
            default_discount, markup_neggo, markup_preventas,
            active, scrape_enabled, odoo_partner_id
        } = req.body;

        const errorKey = validarScraperKey(scraper_key);
        if (errorKey) return fail(res, errorKey);

        const result = await pool.query(
            `UPDATE suppliers SET
                name              = COALESCE($1, name),
                prefix            = COALESCE($2, prefix),
                website_url       = COALESCE($3, website_url),
                -- scraper_key: si viene en el body se pisa (vacío = sin fuente); si no, se mantiene
                scraper_key       = CASE WHEN $11::BOOLEAN THEN $4 ELSE scraper_key END,
                -- sin fuente no se puede scrapear
                scrape_enabled    = CASE WHEN $11::BOOLEAN AND $4 IS NULL THEN false
                                         ELSE COALESCE($12, scrape_enabled) END,
                price_format      = COALESCE($5, price_format),
                default_discount  = COALESCE($6, default_discount),
                markup_neggo      = COALESCE($7, markup_neggo),
                markup_preventas  = COALESCE($8, markup_preventas),
                active            = COALESCE($9, active),
                scrape_config     = CASE
                    WHEN NOT $13::BOOLEAN THEN scrape_config
                    WHEN $14::INTEGER IS NULL THEN COALESCE(scrape_config, '{}'::jsonb) - 'odoo_partner_id'
                    ELSE jsonb_set(COALESCE(scrape_config, '{}'::jsonb), '{odoo_partner_id}', to_jsonb($14::INTEGER))
                END,
                updated_at        = NOW()
             WHERE id = $10
             RETURNING ${SUPPLIER_COLS}`,
            [
                name?.trim() || null,
                prefix?.trim() || null,
                website_url !== undefined ? website_url : null,
                scraper_key ? scraper_key : null,
                price_format || null,
                default_discount ?? null,
                markup_neggo ?? null,
                markup_preventas ?? null,
                active ?? null,
                id,
                scraper_key !== undefined,
                scrape_enabled !== undefined ? !!scrape_enabled : null,
                odoo_partner_id !== undefined,
                odoo_partner_id ? parseInt(odoo_partner_id, 10) : null
            ]
        );

        console.log(`✅ Proveedor actualizado: id ${id}`);
        return ok(res, withComputed(result.rows[0]));
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
// Body opcional: { enabled: true|false } — sin body invierte el valor actual.
// Solo se puede activar si la fuente tiene un scraper registrado.
// =============================================
router.post('/:id/scraping/toggle', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { enabled } = req.body || {};

        const { rows: current } = await pool.query(
            'SELECT id, name, scraper_key, scrape_enabled FROM suppliers WHERE id = $1',
            [id]
        );
        if (current.length === 0) {
            return fail(res, 'Proveedor no encontrado', 404);
        }
        const target = enabled === undefined ? !current[0].scrape_enabled : !!enabled;
        if (target && !getAvailableKeys().includes(current[0].scraper_key)) {
            return fail(res, `"${current[0].name}" no tiene una fuente con scraper: elegí una antes de activarlo`);
        }

        const { rows } = await pool.query(
            `UPDATE suppliers SET scrape_enabled = $2, updated_at = NOW()
             WHERE id = $1
             RETURNING ${SUPPLIER_COLS}`,
            [id, target]
        );
        const s = rows[0];
        console.log(`${s.scrape_enabled ? '✅' : '⚠️'} Scraping de "${s.name}" ${s.scrape_enabled ? 'activado' : 'pausado'}`);
        return ok(res, withComputed(s));
    } catch (error) {
        console.error('❌ Error al cambiar estado de scraping:', error.message);
        return fail(res, 'Error al cambiar estado de scraping', 500);
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
// Pone active=false, pausa el scraping y borra supplier_products
// (cascada elimina price_history, mappings, sync_state)
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
            'UPDATE suppliers SET active = false, scrape_enabled = false, updated_at = NOW() WHERE id = $1',
            [id]
        );

        await client.query('COMMIT');

        console.log(`⚠️ Proveedor desactivado: "${name}" (id: ${id}) — ${deleted} productos eliminados`);
        return ok(res, { id: parseInt(id), name, active: false, scrape_enabled: false, deleted_products: deleted });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error al desactivar proveedor:', error.message);
        return fail(res, 'Error al desactivar proveedor', 500);
    } finally {
        client.release();
    }
});

module.exports = router;
