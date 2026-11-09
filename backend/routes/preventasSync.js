const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail }                  = require('../utils/response');
const { getProductsToSync, applyChanges, getResumen, rechazarVinculo, actualizarFotoOdoo } = require('../services/preventasSyncService');
const { recomputeAll, isRecomputing } = require('../services/preventasMatchService');
const { iniciarAsignacion, getEstadoAsignacion } = require('../services/preventasVendorService');
const { iniciarFotos, frenarFotos, getEstadoFotos } = require('../services/preventasFotosService');

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
        const { supplierId, grupo, estado, matchType, search, sinVendor, sinFoto, page = 1, pageSize = 100 } = req.query;
        const limit  = Math.min(parseInt(pageSize, 10) || 100, 500);
        const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

        const { rows, total, aplicables } = await getProductsToSync(pool, { supplierId, grupo, estado, matchType, search, sinVendor: sinVendor === 'true', sinFoto: sinFoto === 'true', limit, offset });
        // aplicables: qué haría el "Aplicar" en bloque con estos filtros (listos / a revisar / sin precio)
        return res.json({
            success: true,
            data: rows,
            aplicables,
            pagination: { total, limit, offset, pages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('❌ products preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// POST /api/preventas-sync/apply
// Body: { ids?, odoo_ids?, grupo?, estado?, supplierId?, matchType?, search?, confirmar?, aceptarCambioCosto? }
// - aceptarCambioCosto: aplica también los cambios de costo de más del 20% (nunca los vínculos dudosos)
// - Con IDs específicos: síncrono (batch pequeño, respuesta inmediata)
// - Sin IDs (grupo completo): background — devuelve { running: true } de inmediato
router.post('/apply', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { ids = [], odoo_ids = [], grupo, estado, supplierId, matchType, search, confirmar } = req.body;
        const aceptarCambioCosto = req.body.aceptarCambioCosto === true;
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
            applyChanges(pool, [], [], { grupo, estado, supplierId, matchType, search }, { aceptarCambioCosto })
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
        return ok(res, await applyChanges(pool, ids, odoo_ids, { grupo, estado, supplierId }, { confirmar: confirmar === true, aceptarCambioCosto }));
    } catch (err) {
        console.error('❌ apply preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// POST /api/preventas-sync/rechazar-vinculo — "No es este" (nota 179)
// Body: { supplierProductId } — la oferta no es el producto de Odoo con el que se vinculó.
// Queda rechazado (no se vuelve a proponer) y la oferta pasa a "Crear en Odoo". No toca Odoo.
// Devuelve la fila como quedó, para mostrarla con su acción nueva.
router.post('/rechazar-vinculo', authenticate, requireRole('admin'), async (req, res) => {
    const supplierProductId = parseInt(req.body.supplierProductId, 10);
    if (!supplierProductId) return fail(res, 'supplierProductId es requerido', 400);
    try {
        await rechazarVinculo(pool, { supplierProductId, userId: req.user.id });
        const { rows } = await getProductsToSync(pool, { supplierProductId, limit: 1, offset: 0 });
        return ok(res, rows[0] || null);
    } catch (err) {
        if (err.status) return fail(res, err.message, err.status);
        console.error('❌ rechazar-vinculo preventas-sync:', err.message);
        return fail(res, 'No se pudo guardar el "No es este"', 500);
    }
});

// POST /api/preventas-sync/actualizar-foto — "Actualizar foto en Odoo" (nota 181)
// Body: { supplierProductId } — sube la foto del proveedor al producto vinculado de Odoo Preventas,
// aunque ya tenga una. Escribe en Odoo. Devuelve la fila como quedó.
router.post('/actualizar-foto', authenticate, requireRole('admin'), async (req, res) => {
    const supplierProductId = parseInt(req.body.supplierProductId, 10);
    if (!supplierProductId) return fail(res, 'supplierProductId es requerido', 400);
    try {
        await actualizarFotoOdoo(pool, { supplierProductId });
        const { rows } = await getProductsToSync(pool, { supplierProductId, limit: 1, offset: 0 });
        return ok(res, rows[0] || null);
    } catch (err) {
        if (err.status) return fail(res, err.message, err.status);
        console.error('❌ actualizar-foto preventas-sync:', err.message);
        return fail(res, 'No se pudo actualizar la foto en Odoo', 500);
    }
});

// GET /api/preventas-sync/apply/status — estado del apply masivo en background
router.get('/apply/status', authenticate, (req, res) => {
    return ok(res, bulkApplyJob);
});

// POST /api/preventas-sync/assign-vendor  Body: { supplierId? }
// Para cada producto matcheado sin vendor en Odoo, crea product.supplierinfo en Preventas.
// Corre en segundo plano (tarda minutos); el avance se consulta en /assign-vendor/status.
router.post('/assign-vendor', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { supplierId } = req.body || {};
        if (!iniciarAsignacion({ supplierId })) {
            return fail(res, 'Ya se están asignando proveedores. Esperá a que termine.', 409);
        }
        return ok(res, { running: true });
    } catch (err) {
        console.error('❌ assign-vendor preventas-sync:', err.message);
        return fail(res, err.message, 500);
    }
});

// GET /api/preventas-sync/assign-vendor/status — avance de la asignación en segundo plano
router.get('/assign-vendor/status', authenticate, (req, res) => {
    return ok(res, getEstadoAsignacion());
});

// POST /api/preventas-sync/fotos-faltantes  Body: { supplierId? } — "Subir fotos que faltan" (nota 182)
// Sube la foto del proveedor a los productos de Odoo Preventas que no tienen ninguna.
// Escribe en Odoo. Corre en segundo plano; el avance se consulta en /fotos-faltantes/status.
router.post('/fotos-faltantes', authenticate, requireRole('admin'), (req, res) => {
    const { supplierId } = req.body || {};
    if (!iniciarFotos({ supplierId })) return fail(res, 'Ya se están subiendo fotos. Esperá a que termine.', 409);
    return ok(res, { running: true });
});

// POST /api/preventas-sync/fotos-faltantes/frenar — corta después de la foto en curso
router.post('/fotos-faltantes/frenar', authenticate, requireRole('admin'), (req, res) => {
    return ok(res, { frenando: frenarFotos() });
});

// GET /api/preventas-sync/fotos-faltantes/status
router.get('/fotos-faltantes/status', authenticate, (req, res) => {
    return ok(res, getEstadoFotos());
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
