const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated }       = require('../utils/response');
const { getProductsToSync, applyChanges, getResumen } = require('../services/preventasSyncService');
const { recomputeAll, isRecomputing } = require('../services/preventasMatchService');

// Estado del apply masivo en background
let bulkApplyJob = { running: false, result: null, error: null, startedAt: null, finishedAt: null };

// GET /api/preventas-sync/resumen
router.get('/resumen', authenticate, async (req, res) => {
    try {
        const { supplierId } = req.query;
        return ok(res, await getResumen(pool, supplierId));
    } catch (err) {
        console.error('❌ resumen preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// GET /api/preventas-sync/products?supplierId=&estado=&page=1&pageSize=100
router.get('/products', authenticate, async (req, res) => {
    try {
        const { supplierId, grupo, estado, matchType, search, sinVendor, page = 1, pageSize = 100 } = req.query;
        const limit  = Math.min(parseInt(pageSize, 10) || 100, 500);
        const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

        const { rows, total } = await getProductsToSync(pool, { supplierId, grupo, estado, matchType, search, sinVendor: sinVendor === 'true', limit, offset });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        console.error('❌ products preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// POST /api/preventas-sync/apply
// Body: { ids?, odoo_ids?, grupo?, estado?, supplierId? }
// - Con IDs específicos: síncrono (batch pequeño, respuesta inmediata)
// - Sin IDs (grupo completo): background — devuelve { running: true } de inmediato
router.post('/apply', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { ids = [], odoo_ids = [], grupo, estado, supplierId, confirmar } = req.body;
        if (!Array.isArray(ids) || !Array.isArray(odoo_ids)) {
            return fail(res, 'ids y odoo_ids deben ser arrays');
        }

        const esBulk = ids.length === 0 && odoo_ids.length === 0;

        if (esBulk) {
            // Inactivar en bloque solo por proveedor (se valida acá para responder antes del background)
            const pideInactivar = grupo === 'inactivar' || ['inactivar', 'solo_odoo', 'fuera_preventas'].includes(estado);
            if (pideInactivar && !supplierId) {
                return fail(res, 'Para inactivar en bloque elegí un proveedor. No se inactivan todos los proveedores juntos.');
            }
            if (bulkApplyJob.running) {
                return fail(res, 'Ya hay un apply masivo en progreso', 409);
            }
            bulkApplyJob = { running: true, result: null, error: null, startedAt: new Date(), finishedAt: null };
            applyChanges(pool, [], [], { grupo, estado, supplierId })
                .then(result => {
                    bulkApplyJob = { running: false, result, error: null, startedAt: bulkApplyJob.startedAt, finishedAt: new Date() };
                    console.log(`✅ Bulk apply completado: ${result.ok} ok, ${result.error} errores`);
                })
                .catch(err => {
                    bulkApplyJob = { running: false, result: null, error: err.message, startedAt: bulkApplyJob.startedAt, finishedAt: new Date() };
                    console.error('❌ Bulk apply error:', err.message);
                });
            return ok(res, { running: true, bulk: true });
        }

        // Lo que requiere revisión solo se confirma de a un producto, nunca en lote
        if (confirmar === true && ids.length + odoo_ids.length !== 1) {
            return fail(res, 'Los productos a revisar se confirman de a uno');
        }

        // IDs específicos: síncrono
        return ok(res, await applyChanges(pool, ids, odoo_ids, { grupo, estado, supplierId }, { confirmar: confirmar === true }));
    } catch (err) {
        console.error('❌ apply preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// GET /api/preventas-sync/apply/status — estado del apply masivo en background
router.get('/apply/status', authenticate, (req, res) => {
    return ok(res, bulkApplyJob);
});

// POST /api/preventas-sync/assign-vendor
// Para cada producto matcheado sin vendor_name en Odoo, crea product.supplierinfo en Preventas.
// Opcionalmente filtra por supplierId para aplicar solo un proveedor.
router.post('/assign-vendor', authenticate, requireRole('admin'), async (req, res) => {
    const { callOdoo, getCompanyIds } = require('../config/odoo');
    const { supplierId } = req.body;

    try {
        const companyIds = await getCompanyIds();
        const preventasId = companyIds.preventas;
        if (!preventasId) return fail(res, 'No se encontró empresa Preventas en Odoo', 500);
        const ctx = { allowed_company_ids: [preventasId] };

        // Productos matcheados sin vendor en Odoo
        const sidWhere = supplierId ? 'AND pss.supplier_id = $1' : '';
        const sidParam = supplierId ? [parseInt(supplierId, 10)] : [];

        const { rows: targets } = await pool.query(`
            SELECT
                pss.odoo_product_id,
                opc.template_id AS odoo_template_id,
                s.id            AS supplier_id,
                s.name          AS supplier_name
            FROM preventas_sync_state pss
            JOIN supplier_products sp  ON sp.id  = pss.supplier_product_id
            JOIN suppliers s           ON s.id   = sp.supplier_id
            JOIN odoo_products_cache opc
                ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
            WHERE pss.match_type IS NOT NULL
              AND pss.supplier_product_id IS NOT NULL
              AND (opc.vendor_name IS NULL OR opc.vendor_name = '')
              ${sidWhere}
        `, sidParam);

        if (targets.length === 0) {
            return ok(res, { asignados: 0, omitidos: 0, errores: 0, message: 'Todos los productos ya tienen proveedor' });
        }

        // Agrupar por proveedor
        const bySupplier = new Map();
        for (const t of targets) {
            if (!bySupplier.has(t.supplier_id)) {
                bySupplier.set(t.supplier_id, { name: t.supplier_name, products: [] });
            }
            bySupplier.get(t.supplier_id).products.push(t);
        }

        const stats = { asignados: 0, omitidos: 0, errores: 0 };

        for (const [, group] of bySupplier) {
            // Buscar partner en Odoo Preventas por nombre EXACTO (sin distinguir mayúsculas):
            // con 'ilike' (contiene) "ZLE" encontraba primero a la clienta "Yamii GonZLEz"
            const partners = await callOdoo('res.partner', 'search_read',
                [[['name', '=ilike', (group.name || '').trim()]]],
                { fields: ['id', 'name'], order: 'id asc', limit: 1, context: ctx }
            );
            if (!partners.length) {
                console.warn(`⚠️ Partner no encontrado en Odoo para proveedor "${group.name}"`);
                stats.errores += group.products.length;
                continue;
            }
            const partnerId = partners[0].id;

            // Obtener template_ids — preferimos el del cache; si falta, lo obtenemos de Odoo
            const sinTemplate = group.products.filter(p => !p.odoo_template_id);
            if (sinTemplate.length > 0) {
                const variants = await callOdoo('product.product', 'search_read',
                    [[['id', 'in', sinTemplate.map(p => p.odoo_product_id)]]],
                    { fields: ['id', 'product_tmpl_id'], context: ctx }
                );
                const tmplById = new Map(variants.map(v => [v.id, v.product_tmpl_id?.[0]]));
                for (const p of sinTemplate) p.odoo_template_id = tmplById.get(p.odoo_product_id) || null;
            }

            const withTemplate = group.products.filter(p => p.odoo_template_id);
            const tmplIds = [...new Set(withTemplate.map(p => p.odoo_template_id))];
            stats.errores += group.products.length - withTemplate.length;

            if (tmplIds.length === 0) continue;

            // Verificar cuáles ya tienen supplierinfo para este partner
            const BATCH = 200;
            for (let i = 0; i < tmplIds.length; i += BATCH) {
                const batch = tmplIds.slice(i, i + BATCH);
                const existing = await callOdoo('product.supplierinfo', 'search_read',
                    [[['product_tmpl_id', 'in', batch], ['partner_id', '=', partnerId], ['company_id', '=', preventasId]]],
                    { fields: ['product_tmpl_id'], context: ctx }
                );
                const existingSet = new Set(existing.map(e => e.product_tmpl_id?.[0]));
                stats.omitidos += existingSet.size;

                const toCreate = batch.filter(id => !existingSet.has(id));

                // Crear los que faltan
                for (const tmplId of toCreate) {
                    try {
                        await callOdoo('product.supplierinfo', 'create',
                            [{ product_tmpl_id: tmplId, partner_id: partnerId, price: 0, min_qty: 0, company_id: preventasId }],
                            { context: ctx }
                        );
                        stats.asignados++;
                    } catch (err) {
                        stats.errores++;
                        console.error(`❌ Error creando supplierinfo tmpl ${tmplId}:`, err.message);
                    }
                }
            }

            // Actualizar vendor_name en cache local para todos los que procesamos
            const productIds = withTemplate.map(p => p.odoo_product_id);
            if (productIds.length > 0) {
                await pool.query(
                    `UPDATE odoo_products_cache SET vendor_name = $1 WHERE odoo_id = ANY($2::int[]) AND company = 'preventas'`,
                    [group.name, productIds]
                );
            }

            console.log(`✅ ${group.name}: ${stats.asignados} asignados en Odoo`);
        }

        return ok(res, { ...stats, total: targets.length });
    } catch (err) {
        console.error('❌ assign-vendor preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// POST /api/preventas-sync/fix-refs
// Corrige las referencias internas de productos Preventas que se crearon
// con formato Neggo (CAST001) en lugar del formato Preventas (PRECAST001).
router.post('/fix-refs', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const preventasCompanyId = companyIds.preventas;
        if (!preventasCompanyId) return fail(res, 'No se encontró la empresa Preventas en Odoo', 500);

        const ctx = { allowed_company_ids: [preventasCompanyId] };

        // Buscar todos los productos del cache de Preventas con ref sin prefijo PRE
        const { rows } = await pool.query(`
            SELECT odoo_id, internal_ref, name
            FROM odoo_products_cache
            WHERE company = 'preventas'
              AND internal_ref IS NOT NULL
              AND internal_ref NOT LIKE 'PRE%'
            ORDER BY internal_ref
        `);

        if (rows.length === 0) {
            return ok(res, { corregidos: 0, message: 'No hay referencias a corregir' });
        }

        const resultados = { corregidos: 0, errores: 0, detalles: [] };

        for (const prod of rows) {
            const nuevaRef = `PRE${prod.internal_ref}`;
            try {
                await callOdoo('product.product', 'write',
                    [[prod.odoo_id], { default_code: nuevaRef }],
                    { context: ctx }
                );

                await pool.query(`
                    UPDATE odoo_products_cache
                    SET internal_ref = $1,
                        ext_id_clean = UPPER(REGEXP_REPLACE($1, '[^A-Z0-9]', '', 'g')),
                        synced_at = NOW()
                    WHERE odoo_id = $2 AND company = 'preventas'
                `, [nuevaRef, prod.odoo_id]);

                resultados.corregidos++;
                resultados.detalles.push({ odoo_id: prod.odoo_id, antes: prod.internal_ref, despues: nuevaRef });
                console.log(`✅ Ref corregida: ${prod.internal_ref} → ${nuevaRef} (producto ${prod.odoo_id})`);
            } catch (err) {
                resultados.errores++;
                resultados.detalles.push({ odoo_id: prod.odoo_id, antes: prod.internal_ref, error: err.message });
                console.error(`❌ Error corrigiendo ${prod.internal_ref}:`, err.message);
            }
        }

        console.log(`✅ Fix refs Preventas: ${resultados.corregidos} corregidos, ${resultados.errores} errores`);
        return ok(res, resultados);
    } catch (err) {
        console.error('❌ fix-refs preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// GET /api/preventas-sync/recompute/status — ¿hay un recomputo en progreso?
router.get('/recompute/status', authenticate, (req, res) => {
    return ok(res, { running: isRecomputing() });
});

// POST /api/preventas-sync/recompute — dispara matching completo
router.post('/recompute', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const summary = await recomputeAll(pool);
        return ok(res, summary);
    } catch (err) {
        if (err.message.includes('en progreso')) {
            return fail(res, err.message, 409);
        }
        console.error('❌ recompute preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

module.exports = router;
