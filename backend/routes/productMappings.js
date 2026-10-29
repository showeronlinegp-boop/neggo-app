// Rutas de mappings entre supplier_products y odoo_products_cache
//
// GET    /api/mappings                — lista con filtros (supplierId, company, unmapped, search, status)
// GET    /api/mappings/comparison     — comparación productos proveedor vs Odoo (neggo + preventas en una fila)
// POST   /api/mappings               — crear vínculo manual
// DELETE /api/mappings/:id           — eliminar vínculo (admin)
// POST   /api/mappings/auto-match    — ejecutar auto-match para un proveedor

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { runAutoMatch, getUnmappedProducts } = require('../services/matchingService');

// Guarda en match_decisiones lo que decidió una persona sobre un vínculo.
// Si falla no frena la operación: es solo para medir el acierto.
async function registrarDecision(mapping, decision, userId) {
    try {
        await pool.query(
            `INSERT INTO match_decisiones
                (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [mapping.supplier_product_id, mapping.odoo_product_id, mapping.odoo_company,
             decision, mapping.metodo || mapping.match_type, mapping.match_confidence, userId]
        );
    } catch (err) {
        console.error('⚠️ Error al registrar la decisión del vínculo:', err.message);
    }
}

// =============================================
// GET /api/mappings
// Lista de mappings con JOIN a supplier_products y odoo_products_cache
//
// Query params:
//   supplierId — filtra por proveedor
//   company    — 'neggo' | 'preventas'
//   status     — 'active' | 'suggested' | 'rejected'
//   unmapped   — 'true' → devuelve supplier_products SIN mapping activo
//   search     — búsqueda por nombre del producto proveedor
//   limit      — default 100, max 500
//   offset     — default 0
// =============================================

router.get('/', authenticate, async (req, res) => {
    const {
        supplierId,
        company,
        status,
        unmapped,
        search = '',
        limit: rawLimit = '100',
        offset: rawOffset = '0'
    } = req.query;

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    try {
        // Modo "no mapeados": devuelve supplier_products sin mapping activo
        if (unmapped === 'true') {
            // Sin supplierId → solo retornar el conteo total (para el dashboard)
            if (!supplierId) {
                const { rows: countRows } = await pool.query(
                    `SELECT COUNT(*) AS total
                     FROM supplier_products sp
                     WHERE sp.available = true
                       AND NOT EXISTS (
                           SELECT 1 FROM product_mappings pm
                           WHERE pm.supplier_product_id = sp.id AND pm.active = true
                       )`
                );
                return res.json({ success: true, data: [], total: parseInt(countRows[0].total, 10) });
            }

            const rows = await getUnmappedProducts(parseInt(supplierId, 10));
            return ok(res, rows);
        }

        // Modo normal: lista de mappings con JOINs
        const conditions = [];
        const params = [];
        let idx = 1;

        if (supplierId) {
            conditions.push(`sp.supplier_id = $${idx++}`);
            params.push(parseInt(supplierId, 10));
        }

        if (company) {
            if (!['neggo', 'preventas'].includes(company)) {
                return fail(res, 'company debe ser "neggo" o "preventas"', 400);
            }
            conditions.push(`pm.odoo_company = $${idx++}`);
            params.push(company);
        }

        if (status) {
            // Columna en schema es 'active' (boolean) + match_type, pero se unificó en la consulta
            conditions.push(`pm.active = $${idx++}`);
            params.push(status === 'active');
        }

        if (search) {
            conditions.push(`sp.name ILIKE $${idx++}`);
            params.push(`%${search}%`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const { rows } = await pool.query(
            `SELECT
                pm.id,
                pm.supplier_product_id,
                pm.odoo_product_id,
                pm.odoo_company,
                pm.odoo_internal_ref,
                pm.match_type,
                pm.match_confidence,
                pm.active,
                pm.created_at,
                -- Datos del producto proveedor
                sp.sku          AS supplier_sku,
                sp.name         AS supplier_name,
                sp.raw_price,
                sp.source_category,
                sp.available    AS supplier_available,
                s.id            AS supplier_id,
                s.name          AS supplier_name_full,
                -- Datos del producto Odoo (cache)
                opc.name        AS odoo_name,
                opc.internal_ref AS odoo_ref,
                opc.list_price  AS odoo_list_price,
                opc.standard_price AS odoo_standard_price,
                opc.qty_available AS odoo_qty,
                opc.categ_name  AS odoo_category
             FROM product_mappings pm
             JOIN supplier_products sp ON pm.supplier_product_id = sp.id
             JOIN suppliers s ON sp.supplier_id = s.id
             LEFT JOIN odoo_products_cache opc
                ON opc.odoo_id = pm.odoo_product_id
               AND opc.company = pm.odoo_company
             ${where}
             ORDER BY pm.created_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        );

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*) AS total
             FROM product_mappings pm
             JOIN supplier_products sp ON pm.supplier_product_id = sp.id
             ${where}`,
            params
        );

        return paginated(res, rows, countRows[0].total, limit, offset);

    } catch (err) {
        console.error('❌ Error al listar mappings:', err.message);
        return fail(res, 'Error al obtener mappings', 500);
    }
});

// =============================================
// GET /api/mappings/comparison
// Para cada supplier_product de un proveedor, muestra en una sola fila
// su mapeo con neggo y su mapeo con preventas (JOIN doble).
//
// Query params:
//   supplierId — requerido
//   search     — búsqueda por nombre o SKU (ILIKE)
//   filter     — 'all' | 'mapped' | 'unmapped' | 'partial' (default: 'all')
//   limit      — default 100, max 500
//   offset     — default 0
// =============================================

router.get('/comparison', authenticate, async (req, res) => {
    const {
        supplierId,
        search = '',
        filter = 'all',
        limit: rawLimit = '100',
        offset: rawOffset = '0',
    } = req.query;

    if (!supplierId) return fail(res, 'supplierId es requerido', 400);

    const limit  = Math.min(Math.max(parseInt(rawLimit,  10) || 100, 1), 500);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    try {
        const conditions = ['sp.supplier_id = $1'];
        const params     = [parseInt(supplierId, 10)];
        let   idx        = 2;

        if (search) {
            conditions.push(`(sp.name ILIKE $${idx} OR sp.sku ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }

        // Cláusula de filtro sobre los JOINs (no puede ir en WHERE porque son LEFT JOINs)
        const filterMap = {
            mapped:   'AND (pm_n.id IS NOT NULL OR pm_p.id IS NOT NULL)',
            unmapped: 'AND pm_n.id IS NULL AND pm_p.id IS NULL',
            partial:  'AND (pm_n.id IS NULL) != (pm_p.id IS NULL)',
            all:      '',
        };
        const filterClause = filterMap[filter] || '';

        const baseFrom = `
            FROM supplier_products sp
            LEFT JOIN product_mappings pm_n
                   ON pm_n.supplier_product_id = sp.id
                  AND pm_n.odoo_company = 'neggo'
                  AND pm_n.active = true
            LEFT JOIN product_mappings pm_p
                   ON pm_p.supplier_product_id = sp.id
                  AND pm_p.odoo_company = 'preventas'
                  AND pm_p.active = true
            LEFT JOIN odoo_products_cache opc_n
                   ON opc_n.odoo_id = pm_n.odoo_product_id AND opc_n.company = 'neggo'
            LEFT JOIN odoo_products_cache opc_p
                   ON opc_p.odoo_id = pm_p.odoo_product_id AND opc_p.company = 'preventas'
            WHERE ${conditions.join(' AND ')}
            ${filterClause}
        `;

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            params
        );

        params.push(limit, offset);
        const { rows } = await pool.query(
            `SELECT
                -- Producto del proveedor
                sp.id,
                sp.sku,
                sp.name            AS product_name,
                sp.raw_price,
                sp.source_category,
                sp.available,
                sp.last_scraped_at,
                -- Mapeo Neggo
                pm_n.id            AS neggo_mapping_id,
                pm_n.match_type    AS neggo_match_type,
                pm_n.match_confidence AS neggo_confidence,
                opc_n.name         AS neggo_odoo_name,
                opc_n.internal_ref AS neggo_ref,
                opc_n.list_price   AS neggo_list_price,
                opc_n.standard_price AS neggo_cost,
                -- Mapeo Preventas
                pm_p.id            AS prev_mapping_id,
                pm_p.match_type    AS prev_match_type,
                pm_p.match_confidence AS prev_confidence,
                opc_p.name         AS prev_odoo_name,
                opc_p.internal_ref AS prev_ref,
                opc_p.list_price   AS prev_list_price,
                opc_p.standard_price AS prev_cost
            ${baseFrom}
            ORDER BY sp.name ASC
            LIMIT $${idx} OFFSET $${idx + 1}`,
            params
        );

        return paginated(res, rows, parseInt(countRows[0].total, 10), limit, offset);
    } catch (err) {
        console.error('❌ Error en comparison:', err.message);
        return fail(res, 'Error al obtener comparación', 500);
    }
});

// =============================================
// POST /api/mappings/auto-match
// Ejecuta auto-match (ref + fuzzy) para un proveedor
// IMPORTANTE: definir ANTES de POST /:id para evitar conflicto de rutas
// =============================================

router.post('/auto-match', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const { supplierId } = req.body;

    if (!supplierId) {
        return fail(res, 'supplierId es requerido', 400);
    }

    try {
        console.log(`📦 Auto-match iniciado por usuario ${req.user.id} para proveedor ${supplierId}`);
        const summary = await runAutoMatch(parseInt(supplierId, 10));

        return ok(res, {
            message: 'Auto-match completado',
            supplierId: parseInt(supplierId, 10),
            summary
        });
    } catch (err) {
        console.error('❌ Error en auto-match:', err.message);
        return fail(res, err.message || 'Error al ejecutar auto-match', 500);
    }
});

// =============================================
// POST /api/mappings
// Crear vínculo manual entre supplier_product y odoo_product
// =============================================

router.post('/', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const { supplierProductId, odooProductId, odooCompany } = req.body;

    // Validaciones
    if (!supplierProductId || !odooProductId || !odooCompany) {
        return fail(res, 'supplierProductId, odooProductId y odooCompany son requeridos', 400);
    }

    if (!['neggo', 'preventas'].includes(odooCompany)) {
        return fail(res, 'odooCompany debe ser "neggo" o "preventas"', 400);
    }

    try {
        // Verificar que el supplier_product exista
        const { rows: spRows } = await pool.query(
            'SELECT id, name FROM supplier_products WHERE id = $1',
            [supplierProductId]
        );
        if (spRows.length === 0) {
            return fail(res, `supplier_product ${supplierProductId} no encontrado`, 404);
        }

        // Verificar que el producto Odoo exista en el cache
        const { rows: opRows } = await pool.query(
            'SELECT id, odoo_id, internal_ref FROM odoo_products_cache WHERE odoo_id = $1 AND company = $2',
            [odooProductId, odooCompany]
        );
        if (opRows.length === 0) {
            return fail(res, `Producto Odoo ${odooProductId} [${odooCompany}] no encontrado en cache`, 404);
        }

        // Insertar mapping manual (lo hace una persona: queda confirmado)
        const { rows: inserted } = await pool.query(
            `INSERT INTO product_mappings
                (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                 match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
             VALUES ($1, $2, $3, $4, 'manual', 1.0, true, 'confirmado', 'manual', $5, NOW())
             ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company)
             DO UPDATE SET
                match_type = 'manual',
                match_confidence = 1.0,
                active = true,
                estado = 'confirmado',
                metodo = COALESCE(product_mappings.metodo, 'manual'),
                confirmado_por = $5,
                confirmado_at = NOW()
             RETURNING *`,
            [supplierProductId, odooProductId, odooCompany, opRows[0].internal_ref, req.user.id]
        );

        // Decisión para medir el acierto por método
        await registrarDecision(inserted[0], 'confirmado', req.user.id);

        console.log(`✅ Mapping manual creado: supplier_product ${supplierProductId} <-> odoo ${odooProductId} [${odooCompany}]`);

        // Registrar en activity_log
        try {
            await pool.query(
                `INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
                 VALUES ($1, 'mappings', 'crear', 'product_mapping', $2, $3)`,
                [
                    req.user.id,
                    inserted[0].id,
                    JSON.stringify({ supplierProductId, odooProductId, odooCompany })
                ]
            );
        } catch (logErr) {
            console.error('⚠️ Error al registrar en activity_log:', logErr.message);
        }

        return ok(res, inserted[0], 201);

    } catch (err) {
        console.error('❌ Error al crear mapping:', err.message);
        return fail(res, 'Error al crear el mapping', 500);
    }
});

// =============================================
// DELETE /api/mappings/:id
// Eliminar (desactivar) un vínculo — solo admin
// =============================================

router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const mappingId = parseInt(id, 10);

    if (isNaN(mappingId)) {
        return fail(res, 'ID de mapping inválido', 400);
    }

    try {
        const { rows } = await pool.query(
            'SELECT * FROM product_mappings WHERE id = $1',
            [mappingId]
        );

        if (rows.length === 0) {
            return fail(res, `Mapping ${mappingId} no encontrado`, 404);
        }

        // Desactivar en lugar de borrar físicamente para mantener historial.
        // Queda rechazado: así no se vuelve a proponer.
        await pool.query(
            `UPDATE product_mappings SET active = false, estado = 'rechazado', es_habitual = false
             WHERE id = $1`,
            [mappingId]
        );
        await registrarDecision(rows[0], 'rechazado', req.user.id);

        // Registrar en activity_log
        try {
            await pool.query(
                `INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
                 VALUES ($1, 'mappings', 'eliminar', 'product_mapping', $2, $3)`,
                [req.user.id, mappingId, JSON.stringify({})]
            );
        } catch (logErr) {
            console.error('⚠️ Error al registrar en activity_log:', logErr.message);
        }

        console.log(`✅ Mapping ${mappingId} desactivado por usuario ${req.user.id}`);
        return ok(res, { message: `Mapping ${mappingId} eliminado correctamente` });

    } catch (err) {
        console.error('❌ Error al eliminar mapping:', err.message);
        return fail(res, 'Error al eliminar el mapping', 500);
    }
});

module.exports = router;
