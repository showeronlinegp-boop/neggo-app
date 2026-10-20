// Rutas de productos — Agente 03 + Agente 06
// GET  /api/products/odoo                      — lee del cache local
// GET  /api/products/odoo/link-suggestions     — candidatos para vincular un ítem de factura
// POST /api/products/odoo/sync                 — fuerza sync inmediato (solo admin)
// GET  /api/products/supplier                  — lista supplier_products con filtros
// GET  /api/products/supplier/:id/price-history — historial de precios paginado

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { syncOdooProducts } = require('../jobs/odooSync');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const linkSuggestionService = require('../services/linkSuggestionService');

// =============================================
// POST /api/products/odoo/sync
// Fuerza un sync inmediato con Odoo (solo admin)
// =============================================

router.post('/odoo/sync', authenticate, requireRole('admin'), async (req, res) => {
    const { force_full = false } = req.body;
    console.log(`📦 Sync Odoo manual solicitado por usuario ${req.user?.id} (force_full=${force_full})`);

    try {
        await syncOdooProducts(force_full);
        return res.json({
            success: true,
            data: { message: force_full ? 'Sync completo finalizado (stale entries limpiados)' : 'Sync incremental completado' }
        });
    } catch (err) {
        console.error('❌ Error en sync manual de Odoo:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Error al sincronizar con Odoo',
            details: process.env.NODE_ENV !== 'production' ? err.message : undefined
        });
    }
});

// =============================================
// GET /api/products/odoo/sync/status
// Estado del último sync por empresa (lee sync_log)
// =============================================

router.get('/odoo/sync/status', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT company, last_sync, records_synced FROM sync_log ORDER BY company`
        );
        const status = { neggo: null, preventas: null };
        for (const row of rows) {
            if (row.company === 'neggo' || row.company === 'preventas') {
                status[row.company] = { last_sync: row.last_sync, records_synced: row.records_synced };
            }
        }
        return ok(res, status);
    } catch (err) {
        console.error('❌ sync/status:', err.message);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/products/odoo
// Lee productos del cache local con filtros y paginación
//
// Query params:
//   company   — 'neggo' | 'preventas' (requerido)
//   search    — búsqueda por nombre o referencia interna
//   category  — filtra por categ_name (texto parcial)
//   limit     — número de resultados (default: 100, max: 500)
//   offset    — paginación (default: 0)
// =============================================

router.get('/odoo', authenticate, async (req, res) => {
    const {
        company,
        search = '',
        category = '',
        include_inactive = 'false',
        pricelist_id,
        limit: rawLimit = '100',
        offset: rawOffset = '0'
    } = req.query;

    // Validar company
    if (!company || !['neggo', 'preventas'].includes(company)) {
        return res.status(400).json({
            success: false,
            error: 'Parámetro "company" requerido: "neggo" o "preventas"'
        });
    }

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);
    const pricelistId = pricelist_id ? parseInt(pricelist_id) : null;

    try {
        const conditions = ['opc.company = $1'];
        if (include_inactive !== 'true') conditions.push('opc.active = true');
        conditions.push('opc.locally_archived = false');
        const params = [company];
        let paramIdx = 2;

        if (search) {
            conditions.push(`(opc.name ILIKE $${paramIdx} OR opc.internal_ref ILIKE $${paramIdx})`);
            params.push(`%${search}%`);
            paramIdx++;
        }

        if (category) {
            conditions.push(`opc.categ_name ILIKE $${paramIdx}`);
            params.push(`%${category}%`);
            paramIdx++;
        }

        // Si hay pricelist_id, añadir parámetro para el JOIN
        if (pricelistId) {
            params.push(pricelistId);
            paramIdx++;
        }

        const where = conditions.join(' AND ');
        const plParam = pricelistId ? `$${paramIdx - 1}` : 'NULL';

        // Query con LEFT JOIN a product_mappings + supplier_products + pricelists cuando corresponde
        const { rows } = await pool.query(
            `SELECT
                opc.id, opc.odoo_id, opc.company, opc.name, opc.internal_ref, opc.barcode,
                opc.list_price, opc.standard_price, opc.categ_name, opc.image_url,
                opc.qty_available, opc.active, opc.synced_at,
                sp.raw_price,
                sp.supplier_id,
                CASE
                    WHEN ${plParam}::integer IS NOT NULL AND sp.raw_price IS NOT NULL
                    THEN ROUND(sp.raw_price * (1 - COALESCE(plr.descuento_pct, pl.default_descuento, 0) / 100.0), 2)
                    ELSE NULL
                END AS pricelist_price
             FROM odoo_products_cache opc
             LEFT JOIN LATERAL (
                 SELECT pm.supplier_product_id
                 FROM product_mappings pm
                 WHERE pm.odoo_product_id = opc.odoo_id
                   AND pm.odoo_company = opc.company
                   AND pm.active = true
                 ORDER BY pm.match_confidence DESC
                 LIMIT 1
             ) best_pm ON true
             LEFT JOIN supplier_products sp ON sp.id = best_pm.supplier_product_id
             LEFT JOIN client_pricelists pl ON pl.id = ${plParam}::integer AND pl.active = true
             LEFT JOIN client_pricelist_rules plr
                 ON plr.pricelist_id = ${plParam}::integer
                 AND plr.supplier_id = sp.supplier_id
                 AND plr.active = true
             WHERE ${where}
             ORDER BY opc.name ASC
             LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            [...params, limit, offset]
        );

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*) AS total FROM odoo_products_cache opc WHERE ${where}`,
            params.slice(0, pricelistId ? paramIdx - 1 : paramIdx)
        );

        const total = parseInt(countRows[0].total, 10);

        return paginated(res, rows, total, limit, offset);

    } catch (err) {
        console.error('❌ Error al leer cache de productos Odoo:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener productos del cache'
        });
    }
});

// =============================================
// GET /api/products/odoo/link-suggestions
// Candidatos para vincular un ítem de factura (activos e inactivos).
// Sin q: sugiere por código, código parecido y parecido de nombre.
// Con q: busca todas las palabras escritas, en cualquier orden.
// Query: company, codigo, descripcion, q, limit
// =============================================

router.get('/odoo/link-suggestions', authenticate, async (req, res) => {
    const { company = 'neggo', codigo = '', descripcion = '', q = '' } = req.query;
    if (!['neggo', 'preventas'].includes(company)) {
        return fail(res, 'company debe ser "neggo" o "preventas"');
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    try {
        const rows = q.trim()
            ? await linkSuggestionService.searchByText({ company, q, limit })
            : await linkSuggestionService.suggestForItem({ company, codigo, descripcion, limit });
        return ok(res, rows);
    } catch (err) {
        console.error('❌ Error al buscar sugerencias de vinculación:', err.message);
        return fail(res, 'Error al buscar sugerencias', 500);
    }
});

// =============================================
// PATCH /api/products/odoo/:odooId/archive
// Archiva el producto en Odoo (active=false) y lo marca localmente.
// El sync respeta locally_archived y no lo sobrescribe.
// =============================================

router.patch('/odoo/:odooId/archive', authenticate, async (req, res) => {
    const odooId = parseInt(req.params.odooId, 10);
    const { company = 'neggo', archived = true } = req.body;

    if (!['neggo', 'preventas'].includes(company)) {
        return fail(res, 'company debe ser "neggo" o "preventas"');
    }

    try {
        // 1. Archivar en Odoo
        const odooService = require('../services/odooService');
        await odooService.setProductArchived(odooId, company, archived);

        // 2. Marcar en cache local (también actualizamos active para reflejar el estado real)
        const { rows } = await pool.query(
            `UPDATE odoo_products_cache
                SET locally_archived = $1,
                    active = $2,
                    synced_at = synced_at
             WHERE odoo_id = $3 AND company = $4
             RETURNING odoo_id, name, locally_archived, active`,
            [archived, !archived, odooId, company]
        );
        if (!rows.length) return fail(res, 'Producto no encontrado en cache', 404);

        // Reposición: el sync no ve este cambio porque el cache ya quedó actualizado acá
        if (company === 'neggo') {
            const reposicion = require('../services/reposicionService');
            try {
                if (archived) await reposicion.registrarArchivados([odooId], { createdBy: req.user.id });
                else await reposicion.resolverReactivados([odooId], { resolvedBy: req.user.id });
            } catch (err) {
                console.error(`⚠️ Reposición: no se pudo actualizar la cola para ${odooId}: ${err.message}`);
            }
        }

        const action = archived ? 'archivado' : 'restaurado';
        console.log(`✅ Producto ${rows[0].name} (odoo_id=${odooId}) ${action} en Odoo y cache local`);
        ok(res, {
            ...rows[0],
            en_cola: company === 'neggo' && !!archived,
            cola_cerrada: company === 'neggo' && !archived,
        });
    } catch (err) {
        console.error('❌ Error al archivar producto en Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/products/odoo/categories
// Lista categorías de Odoo para el selector de creación de producto
// =============================================

router.get('/odoo/categories', authenticate, async (req, res) => {
    const { search = '' } = req.query;
    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Empresa Neggo no encontrada en Odoo', 503);

        const domain = search ? [['complete_name', 'ilike', search]] : [];

        const results = await callOdoo(
            'product.category', 'search_read',
            [domain, ['id', 'name', 'complete_name']],
            { limit: 30, context: { allowed_company_ids: [companyId] } }
        );

        return ok(res, results);
    } catch (err) {
        console.error('❌ Error al obtener categorías Odoo:', err.message);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/products/odoo/web-categories
// Categorías de eCommerce (product.public.category) de Odoo Neggo
// =============================================

router.get('/odoo/web-categories', authenticate, async (req, res) => {
    const { search = '' } = req.query;
    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Empresa Neggo no encontrada en Odoo', 503);

        const domain = search ? [['name', 'ilike', search]] : [];

        const results = await callOdoo(
            'product.public.category', 'search_read',
            [domain, ['id', 'name', 'display_name']],
            { limit: 50, context: { allowed_company_ids: [companyId] } }
        );

        // Odoo 19 no tiene complete_name en product.public.category: display_name trae la ruta completa
        return ok(res, results.map(c => ({ ...c, complete_name: c.display_name || c.name })));
    } catch (err) {
        console.error('❌ Error al obtener categorías web Odoo:', err.message);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/products/supplier
// Lista de supplier_products con filtros y paginación
//
// Query params:
//   supplierId  — filtra por proveedor (requerido)
//   category    — filtra por source_category (texto parcial)
//   search      — búsqueda por nombre o SKU
//   available   — 'true' | 'false'
//   limit       — default 100, max 500
//   offset      — default 0
// =============================================

router.get('/supplier', authenticate, async (req, res) => {
    const {
        supplierId,
        category = '',
        search = '',
        available,
        sort = 'name',
        limit: rawLimit = '100',
        offset: rawOffset = '0'
    } = req.query;

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    try {
        const conditions = [];
        const params = [];
        let idx = 1;

        if (supplierId) {
            conditions.push(`sp.supplier_id = $${idx++}`);
            params.push(parseInt(supplierId, 10));
        }

        if (category) {
            conditions.push(`sp.source_category ILIKE $${idx++}`);
            params.push(`%${category}%`);
        }

        if (search) {
            conditions.push(`(sp.name ILIKE $${idx} OR sp.sku ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }

        if (available !== undefined) {
            conditions.push(`sp.available = $${idx++}`);
            params.push(available === 'true');
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const { rows } = await pool.query(
            `SELECT
                sp.id, sp.supplier_id, sp.sku, sp.name,
                sp.raw_price, sp.offer_price, sp.image_url, sp.product_url,
                sp.source_category, sp.barcode, sp.available,
                sp.last_scraped_at, sp.created_at, sp.updated_at,
                s.name AS supplier_name, s.prefix AS supplier_prefix,
                sp.source,
                -- Precios calculados usando overrides de regla de categoría si existen.
                -- Fuente Neggo: raw_price ya es el costo de Neggo (sin descuento ni flete extra)
                CASE
                    WHEN sp.raw_price IS NULL THEN NULL
                    WHEN sp.source = 'neggo' THEN ROUND(sp.raw_price, 2)
                    ELSE ROUND(sp.raw_price * (1 - COALESCE(scr.discount_override, s.default_discount, 0) / 100 + 0.015), 2)
                END AS costo,
                CASE
                    WHEN sp.raw_price IS NULL OR sp.source = 'neggo' THEN NULL
                    ELSE ROUND(sp.raw_price * 1.015 * (1 + COALESCE(scr.markup_neggo_override, s.markup_neggo, 0) / 100), 2)
                END AS precio_neggo,
                CASE
                    WHEN sp.raw_price IS NULL THEN NULL
                    WHEN sp.source = 'neggo' THEN
                        ROUND(sp.raw_price * (1 + COALESCE(scr.markup_preventas_override, s.markup_preventas, 0) / 100), 2)
                    ELSE ROUND(sp.raw_price * 1.015 * (1 + COALESCE(scr.markup_preventas_override, s.markup_preventas, 0) / 100), 2)
                END AS precio_preventas
             FROM supplier_products sp
             JOIN suppliers s ON sp.supplier_id = s.id
             LEFT JOIN supplier_category_rules scr
                ON scr.supplier_id = sp.supplier_id
               AND scr.source_category = sp.source_category
               AND scr.active = true
             ${where}
             ORDER BY ${sort === 'new' ? 'sp.created_at DESC' : 'sp.name ASC'}
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        );

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*) AS total
             FROM supplier_products sp
             ${where}`,
            params
        );

        const total = parseInt(countRows[0].total, 10);

        return paginated(res, rows, total, limit, offset);

    } catch (err) {
        console.error('❌ Error al listar supplier_products:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener productos de proveedores'
        });
    }
});

// =============================================
// GET /api/products/supplier/:id/price-history
// Historial de precios paginado para un supplier_product
//
// Query params:
//   limit  — default 50, max 500
//   offset — default 0
// =============================================

router.get('/supplier/:id/price-history', authenticate, async (req, res) => {
    const productId = parseInt(req.params.id, 10);

    if (isNaN(productId)) {
        return res.status(400).json({ success: false, error: 'ID de producto inválido' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        // Verificar que el producto exista
        const { rows: productRows } = await pool.query(
            `SELECT sp.id, sp.name, sp.sku, s.name AS supplier_name
             FROM supplier_products sp
             JOIN suppliers s ON sp.supplier_id = s.id
             WHERE sp.id = $1`,
            [productId]
        );

        if (productRows.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Producto ${productId} no encontrado`
            });
        }

        const { rows: history } = await pool.query(
            `SELECT id, price, offer_price, available, scraped_at
             FROM price_history
             WHERE supplier_product_id = $1
             ORDER BY scraped_at DESC
             LIMIT $2 OFFSET $3`,
            [productId, limit, offset]
        );

        const { rows: countRows } = await pool.query(
            'SELECT COUNT(*) AS total FROM price_history WHERE supplier_product_id = $1',
            [productId]
        );

        const total = parseInt(countRows[0].total, 10);

        return res.json({
            success: true,
            data: history,
            product: productRows[0],
            pagination: { total, limit, offset, pages: Math.ceil(total / limit) }
        });

    } catch (err) {
        console.error('❌ Error al obtener historial de precios:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Error al obtener historial de precios'
        });
    }
});

// =============================================
// GET /api/products/odoo/partners
// Búsqueda de partners (proveedores) de Odoo para vincular a ingresos
// =============================================

router.get('/odoo/partners', authenticate, async (req, res) => {
    const { search = '', limit = 20 } = req.query;

    try {
        const odooService = require('../services/odooService');
        const partners = await odooService.getPartners({
            type: 'supplier',
            search: search.trim()
        });

        const limited = partners.slice(0, Math.min(parseInt(limit, 10), 50));

        return ok(res, limited);
    } catch (err) {
        console.error('❌ Error buscando partners Odoo:', err.message);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/products/odoo-image/:company/:templateId
// Proxy de imagen: pide image_128 a Odoo vía JSON-RPC y la sirve como PNG.
// ?size=256|512|1024|1920 trae una versión más grande (para ver la foto ampliada).
// Cache de 24h en el browser para no sobrecargar Odoo.
// =============================================

const TAMANIOS_IMAGEN = ['128', '256', '512', '1024', '1920'];

router.get('/odoo-image/:company/:templateId', async (req, res) => {
    const { company, templateId } = req.params;
    if (!['neggo', 'preventas'].includes(company)) return res.status(400).end();
    const campo = `image_${TAMANIOS_IMAGEN.includes(req.query.size) ? req.query.size : '128'}`;

    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const ids = await getCompanyIds();
        const companyId = ids[company];
        if (!companyId) return res.status(404).end();

        const data = await callOdoo(
            'product.template',
            'read',
            [[parseInt(templateId)]],
            { fields: [campo], context: { allowed_company_ids: [companyId] } }
        );

        const b64 = data?.[0]?.[campo];
        if (!b64) return res.status(404).end();

        const buf = Buffer.from(b64, 'base64');
        // Las versiones grandes suelen venir en JPEG: detectar por magic bytes
        let contentType = 'image/png';
        if (buf[0] === 0xFF && buf[1] === 0xD8) contentType = 'image/jpeg';
        else if (buf[0] === 0x47 && buf[1] === 0x49) contentType = 'image/gif';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (err) {
        console.error('❌ Error al traer imagen de Odoo:', err.message);
        res.status(500).end();
    }
});

module.exports = router;
