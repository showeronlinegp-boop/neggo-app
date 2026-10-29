// Rutas de mappings entre supplier_products y odoo_products_cache
//
// GET    /api/mappings                — lista con filtros (supplierId, company, unmapped, search, status)
// GET    /api/mappings/comparison     — comparación productos proveedor vs Odoo (neggo + preventas en una fila)
// POST   /api/mappings               — crear vínculo manual
// DELETE /api/mappings/:id           — eliminar vínculo (admin)
// POST   /api/mappings/auto-match    — ejecutar auto-match para un proveedor
//
// Vincular (tabla maestra, nota 107). Solo Neggo; nada se activa ni se escribe en Odoo:
// GET    /api/mappings/vincular/resumen           — cantidades por pestaña
// GET    /api/mappings/vincular/lote              — sugeridos por código (supplierId opcional)
// POST   /api/mappings/vincular/lote              — { confirmar: [ids], rechazar?: [ids] }
// GET    /api/mappings/vincular/tarjetas          — tarjetas por nombre de la semana
// POST   /api/mappings/vincular/tarjetas          — { odooProductId, mappingId | null }
// GET    /api/mappings/vincular/conflictos        — ofertas confirmadas con 2 o más productos
// POST   /api/mappings/vincular/rechazar          — { supplierProductId, odooProductId }
// GET    /api/mappings/vincular/sin-habitual      — con oferta confirmada y sin habitual
// POST   /api/mappings/vincular/repasar-ingresos  — repasa todos los ingresos confirmados
//
// Comparar compras (tabla maestra, nota 107, punto 6). Solo lectura:
// GET    /api/mappings/comparar                   — productos con oferta web confirmada + métrica del top
// GET    /api/mappings/comparar/sin-oferta        — se vende y no tiene oferta web disponible (con motivo)

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { runAutoMatch, getUnmappedProducts } = require('../services/matchingService');
const vincular = require('../services/vincularService');
const comparar = require('../services/compararComprasService');
const { recalcularHabituales } = require('../services/tablaMaestraService');

// Lista de ids enteros de un body (descarta lo que no sea número)
function idsDe(valor) {
    return Array.isArray(valor) ? valor.map(v => parseInt(v, 10)).filter(Number.isInteger) : [];
}

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
                           WHERE pm.supplier_product_id = sp.id AND pm.estado = 'confirmado'
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

        if (['confirmado', 'sugerido', 'rechazado'].includes(status)) {
            conditions.push(`pm.estado = $${idx++}`);
            params.push(status);
        } else if (status) {
            // 'active' | 'inactive': columna active (solo los activos mueven precios en Odoo)
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
                pm.estado,
                pm.metodo,
                pm.es_habitual,
                pm.created_at,
                -- Datos del producto proveedor
                sp.sku          AS supplier_sku,
                sp.name         AS supplier_name,
                sp.raw_price,
                sp.source_category,
                sp.available    AS supplier_available,
                sp.image_url    AS supplier_image_url,
                s.id            AS supplier_id,
                s.name          AS supplier_name_full,
                -- Datos del producto Odoo (cache)
                opc.name        AS odoo_name,
                opc.internal_ref AS odoo_ref,
                opc.list_price  AS odoo_list_price,
                opc.standard_price AS odoo_standard_price,
                opc.qty_available AS odoo_qty,
                opc.categ_name  AS odoo_category,
                opc.image_url   AS odoo_image_url
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
                  AND pm_n.estado = 'confirmado'
            LEFT JOIN product_mappings pm_p
                   ON pm_p.supplier_product_id = sp.id
                  AND pm_p.odoo_company = 'preventas'
                  AND pm_p.estado = 'confirmado'
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
                sp.image_url,
                -- Mapeo Neggo
                pm_n.id            AS neggo_mapping_id,
                pm_n.match_type    AS neggo_match_type,
                pm_n.match_confidence AS neggo_confidence,
                opc_n.name         AS neggo_odoo_name,
                opc_n.internal_ref AS neggo_ref,
                opc_n.list_price   AS neggo_list_price,
                opc_n.standard_price AS neggo_cost,
                opc_n.image_url    AS neggo_image_url,
                -- Mapeo Preventas
                pm_p.id            AS prev_mapping_id,
                pm_p.match_type    AS prev_match_type,
                pm_p.match_confidence AS prev_confidence,
                opc_p.name         AS prev_odoo_name,
                opc_p.internal_ref AS prev_ref,
                opc_p.list_price   AS prev_list_price,
                opc_p.standard_price AS prev_cost,
                opc_p.image_url    AS prev_image_url
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
// Vincular (tabla maestra): lote por código, tarjetas por nombre, conflictos, sin habitual
// =============================================

router.get('/vincular/resumen', authenticate, async (req, res) => {
    try {
        return ok(res, await vincular.resumen());
    } catch (err) {
        console.error('❌ Error en el resumen de vincular:', err.message);
        return fail(res, 'Error al obtener el resumen', 500);
    }
});

router.get('/vincular/lote', authenticate, async (req, res) => {
    try {
        const supplierId = parseInt(req.query.supplierId, 10) || null;
        return ok(res, await vincular.listarLoteCodigo({ supplierId }));
    } catch (err) {
        console.error('❌ Error al listar el lote por código:', err.message);
        return fail(res, 'Error al obtener el lote por código', 500);
    }
});

router.post('/vincular/lote', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const confirmar = idsDe(req.body.confirmar);
    const rechazar = idsDe(req.body.rechazar).filter(id => !confirmar.includes(id));
    if (!confirmar.length && !rechazar.length) return fail(res, 'No hay vínculos tildados', 400);
    try {
        const resultado = await vincular.decidirLote({ confirmar, rechazar, userId: req.user.id });
        console.log(`✅ Lote por código: ${resultado.confirmados} confirmados, ${resultado.rechazados} rechazados (usuario ${req.user.id})`);
        return ok(res, resultado);
    } catch (err) {
        console.error('❌ Error al confirmar el lote por código:', err.message);
        return fail(res, 'Error al confirmar el lote', 500);
    }
});

router.get('/vincular/tarjetas', authenticate, async (req, res) => {
    try {
        return ok(res, await vincular.listarTarjetas());
    } catch (err) {
        console.error('❌ Error al listar las tarjetas por nombre:', err.message);
        return fail(res, 'Error al obtener las tarjetas', 500);
    }
});

router.post('/vincular/tarjetas', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const odooProductId = parseInt(req.body.odooProductId, 10);
    const mappingId = req.body.mappingId == null ? null : parseInt(req.body.mappingId, 10);
    if (!odooProductId || Number.isNaN(mappingId)) return fail(res, 'odooProductId requerido y mappingId numérico o null', 400);
    try {
        return ok(res, await vincular.decidirTarjeta({ odooProductId, mappingId, userId: req.user.id }));
    } catch (err) {
        if (err.status === 409) return fail(res, err.message, 409);
        console.error('❌ Error al decidir la tarjeta:', err.message);
        return fail(res, 'Error al guardar la decisión', 500);
    }
});

router.get('/vincular/conflictos', authenticate, async (req, res) => {
    try {
        return ok(res, await vincular.listarConflictosDetalle());
    } catch (err) {
        console.error('❌ Error al listar conflictos:', err.message);
        return fail(res, 'Error al obtener los conflictos', 500);
    }
});

router.post('/vincular/rechazar', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const supplierProductId = parseInt(req.body.supplierProductId, 10);
    const odooProductId = parseInt(req.body.odooProductId, 10);
    if (!supplierProductId || !odooProductId) return fail(res, 'supplierProductId y odooProductId son requeridos', 400);
    try {
        const resultado = await vincular.rechazarPar({ supplierProductId, odooProductId, userId: req.user.id });
        if (!resultado.rechazado) return fail(res, 'Ese vínculo no existe o ya estaba rechazado', 404);
        return ok(res, resultado);
    } catch (err) {
        console.error('❌ Error al rechazar el vínculo:', err.message);
        return fail(res, 'Error al rechazar el vínculo', 500);
    }
});

router.get('/vincular/sin-habitual', authenticate, async (req, res) => {
    try {
        return ok(res, await vincular.listarSinHabitual());
    } catch (err) {
        console.error('❌ Error al listar sin habitual:', err.message);
        return fail(res, 'Error al obtener los productos sin habitual', 500);
    }
});

router.post('/vincular/repasar-ingresos', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    try {
        const resultado = await vincular.repasarIngresos({ userId: req.user.id });
        console.log(`✅ Repaso de ingresos: ${resultado.creados} creados, ${resultado.confirmados} confirmados`);
        return ok(res, resultado);
    } catch (err) {
        console.error('❌ Error al repasar los ingresos:', err.message);
        return fail(res, 'Error al repasar los ingresos', 500);
    }
});

// =============================================
// Comparar compras (tabla maestra, solo lectura): ofertas por producto y lo que se vende sin oferta
// =============================================

router.get('/comparar', authenticate, async (req, res) => {
    try {
        const [productos, resumen] = await Promise.all([comparar.listarComparar(), comparar.metrica()]);
        return ok(res, { productos, metrica: resumen });
    } catch (err) {
        console.error('❌ Error en comparar compras:', err.message);
        return fail(res, 'Error al obtener la comparación de compras', 500);
    }
});

router.get('/comparar/sin-oferta', authenticate, async (req, res) => {
    try {
        return ok(res, await comparar.listarSinOferta());
    } catch (err) {
        console.error('❌ Error al listar lo que se vende sin oferta:', err.message);
        return fail(res, 'Error al obtener los productos sin oferta', 500);
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

        // Insertar mapping manual (lo hace una persona: queda confirmado). Nace inactivo: lo prende
        // recalcularHabituales si la tabla maestra está prendida (solo el habitual mueve precios en Odoo).
        const { rows: inserted } = await pool.query(
            `INSERT INTO product_mappings
                (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                 match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
             VALUES ($1, $2, $3, $4, 'manual', 1.0, false, 'confirmado', 'manual', $5, NOW())
             ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company)
             DO UPDATE SET
                match_type = 'manual',
                match_confidence = 1.0,
                estado = 'confirmado',
                metodo = COALESCE(product_mappings.metodo, 'manual'),
                confirmado_por = $5,
                confirmado_at = NOW()
             RETURNING *`,
            [supplierProductId, odooProductId, odooCompany, opRows[0].internal_ref, req.user.id]
        );

        // Decisión para medir el acierto por método
        await registrarDecision(inserted[0], 'confirmado', req.user.id);
        // Si es del proveedor principal pasa a ser el habitual (y con la tabla prendida, queda activo)
        await recalcularHabituales(pool);

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
