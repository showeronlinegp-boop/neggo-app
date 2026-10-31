// Servicio de gestión de alertas de precio
//
// Lógica diferenciada por empresa:
//   - preventas: actualización AUTOMÁTICA en Odoo + registro con status='auto_applied'
//   - neggo:     crea alerta con status='pending' para aprobación manual del admin
//
// Un supplier_product puede estar vinculado a AMBAS empresas al mismo tiempo.
// En ese caso se aplican las dos lógicas en la misma detección.

const pool = require('../config/database');
const { calculatePrices, getCategoryRule } = require('./rulesEngine');
const { updateProductPrices } = require('./odooService');

// Cambio mínimo de precio para generar alerta en Neggo (%)
const NEGGO_THRESHOLD_PCT = 5;

// =============================================
// Procesar cambio de precio (llamado por el scraper)
// =============================================

/**
 * Procesa un cambio de precio detectado durante el scraping.
 * Divide los productos vinculados por empresa y aplica la lógica correcta.
 *
 * @param {number} supplierProductId
 * @param {number} oldPrice
 * @param {number} newPrice
 */
async function processPriceChange(supplierProductId, oldPrice, newPrice) {
    const pctChange = ((newPrice - oldPrice) / oldPrice) * 100;

    // Obtener datos del supplier_product y su proveedor
    const { rows: spRows } = await pool.query(`
        SELECT sp.id, sp.name, sp.source_category, sp.supplier_id, sp.source,
               s.default_discount,
               s.markup_neggo, s.markup_preventas, s.prefix
        FROM supplier_products sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.id = $1
    `, [supplierProductId]);

    if (spRows.length === 0) return;
    const sp = spRows[0];

    // Solo la oferta habitual (la del proveedor principal de Odoo) mueve precios (nota 107)
    const { rows: mappings } = await pool.query(`
        SELECT pm.id, pm.odoo_product_id, pm.odoo_company, pm.odoo_internal_ref,
               opc.name AS odoo_name, opc.standard_price, opc.list_price
        FROM product_mappings pm
        LEFT JOIN odoo_products_cache opc
               ON opc.odoo_id = pm.odoo_product_id AND opc.company = pm.odoo_company
        WHERE pm.supplier_product_id = $1 AND pm.active = true AND pm.es_habitual = true
    `, [supplierProductId]);

    if (mappings.length === 0) return;

    const alertType = newPrice > oldPrice ? 'price_increase' : 'price_decrease';

    // Agrupar por empresa para determinar la lógica a aplicar
    const preventasMappings = mappings.filter(m => m.odoo_company === 'preventas');
    const neggoMappings = mappings.filter(m => m.odoo_company === 'neggo');

    // ── PREVENTAS: actualización automática ──────────────────────────────────
    for (const mapping of preventasMappings) {
        try {
            const categoryRule = await getCategoryRule(
                pool, sp.supplier_id, sp.source_category, 'preventas'
            );
            const prices = calculatePrices(
                { raw_price: newPrice, source: sp.source }, sp, categoryRule, 'preventas'
            );

            await updateProductPrices(
                mapping.odoo_product_id, prices.cost, prices.sale_price, 'preventas',
                categoryRule?.odoo_categ_id || null
            );

            // Registro de trazabilidad (no aparece en la cola de revisión)
            await pool.query(`
                INSERT INTO price_alerts
                    (supplier_product_id, alert_type, old_price, new_price, pct_change,
                     linked_odoo_products, company, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'preventas', 'auto_applied')
            `, [
                supplierProductId, alertType, oldPrice, newPrice, pctChange,
                JSON.stringify([{
                    odoo_id: mapping.odoo_product_id,
                    company: 'preventas',
                    name: mapping.odoo_name,
                    new_cost: prices.cost,
                    new_sale_price: prices.sale_price
                }])
            ]);

            console.log(`✅ Preventas auto-actualizado — producto Odoo ${mapping.odoo_product_id}: costo=${prices.cost}, venta=${prices.sale_price}`);
        } catch (err) {
            console.error(`❌ Error auto-actualizando Preventas para mapping ${mapping.id}:`, err.message);
        }
    }

    // ── NEGGO: alerta para aprobación manual ─────────────────────────────────
    // Solo si el cambio supera el umbral del 5%
    if (neggoMappings.length > 0 && Math.abs(pctChange) >= NEGGO_THRESHOLD_PCT) {
        const linkedOdooProducts = neggoMappings.map(m => ({
            odoo_id: m.odoo_product_id,
            company: 'neggo',
            name: m.odoo_name,
            current_cost: m.standard_price,
            current_price: m.list_price
        }));

        await pool.query(`
            INSERT INTO price_alerts
                (supplier_product_id, alert_type, old_price, new_price, pct_change,
                 linked_odoo_products, company, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'neggo', 'pending')
        `, [
            supplierProductId, alertType, oldPrice, newPrice, pctChange,
            JSON.stringify(linkedOdooProducts)
        ]);

        console.log(`🔔 Alerta Neggo creada — producto ${supplierProductId}: ${pctChange.toFixed(1)}% de cambio`);
    } else if (neggoMappings.length > 0) {
        console.log(`⏭️ Cambio Neggo ignorado (${pctChange.toFixed(1)}% < umbral ${NEGGO_THRESHOLD_PCT}%)`);
    }
}

// =============================================
// Aprobar alerta (solo Neggo)
// =============================================

/**
 * Aprueba una alerta de Neggo: recalcula precios con rulesEngine y actualiza Odoo.
 * Solo aplica a alertas con company='neggo' y status='pending'.
 */
async function approveAlert(alertId, userId) {
    console.log(`📦 Aprobando alerta ID: ${alertId} por usuario: ${userId}`);

    const { rows: alertRows } = await pool.query(`
        SELECT pa.id, pa.alert_type, pa.old_price, pa.new_price, pa.pct_change,
               pa.status, pa.company,
               sp.id AS supplier_product_id, sp.name AS product_name,
               sp.source_category, sp.supplier_id, sp.source,
               s.default_discount,
               s.markup_neggo, s.markup_preventas
        FROM price_alerts pa
        JOIN supplier_products sp ON pa.supplier_product_id = sp.id
        JOIN suppliers s ON sp.supplier_id = s.id
        WHERE pa.id = $1
    `, [alertId]);

    if (alertRows.length === 0) throw new Error(`Alerta ${alertId} no encontrada`);
    const alert = alertRows[0];

    if (alert.company !== 'neggo') {
        throw new Error(`Solo se pueden aprobar alertas de Neggo (esta es de ${alert.company})`);
    }
    if (alert.status !== 'pending') {
        throw new Error(`Alerta ${alertId} ya fue procesada (estado: ${alert.status})`);
    }

    // Buscar mappings de Neggo para este producto
    const { rows: mappings } = await pool.query(`
        SELECT pm.id, pm.odoo_product_id, pm.odoo_company
        FROM product_mappings pm
        WHERE pm.supplier_product_id = $1 AND pm.odoo_company = 'neggo' AND pm.active = true AND pm.es_habitual = true
    `, [alert.supplier_product_id]);

    const odooUpdates = [];

    for (const mapping of mappings) {
        try {
            const categoryRule = await getCategoryRule(
                pool, alert.supplier_id, alert.source_category, 'neggo'
            );
            const prices = calculatePrices(
                { raw_price: alert.new_price, source: alert.source },
                { default_discount: alert.default_discount, markup_neggo: alert.markup_neggo, markup_preventas: alert.markup_preventas },
                categoryRule,
                'neggo'
            );

            await updateProductPrices(
                mapping.odoo_product_id, prices.cost, prices.sale_price, 'neggo',
                categoryRule?.odoo_categ_id || null
            );

            odooUpdates.push({
                odoo_product_id: mapping.odoo_product_id,
                cost: prices.cost,
                sale_price: prices.sale_price
            });

            console.log(`✅ Neggo Odoo actualizado — producto ${mapping.odoo_product_id}: costo=${prices.cost}, venta=${prices.sale_price}`);
        } catch (err) {
            console.error(`❌ Error actualizando Odoo para mapping ${mapping.id}:`, err.message);
            odooUpdates.push({ odoo_product_id: mapping.odoo_product_id, error: err.message });
        }
    }

    const { rows: updated } = await pool.query(`
        UPDATE price_alerts
        SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
        WHERE id = $2
        RETURNING id, status, reviewed_by, reviewed_at
    `, [userId, alertId]);

    try {
        await pool.query(`
            INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
            VALUES ($1, 'alertas', 'aprobar', 'price_alert', $2, $3)
        `, [userId, alertId, JSON.stringify({
            alert_type: alert.alert_type,
            product: alert.product_name,
            old_price: alert.old_price,
            new_price: alert.new_price,
            pct_change: alert.pct_change,
            odoo_updates: odooUpdates
        })]);
    } catch (logErr) {
        console.error('⚠️ Error al registrar en activity_log:', logErr.message);
    }

    return { alert: updated[0], odoo_updates: odooUpdates, mappings_processed: mappings.length };
}

// =============================================
// Descartar alerta (solo Neggo)
// =============================================

async function dismissAlert(alertId, userId, note = null) {
    console.log(`📦 Descartando alerta ID: ${alertId} por usuario: ${userId}`);

    const { rows: existing } = await pool.query(
        'SELECT id, status, company FROM price_alerts WHERE id = $1', [alertId]
    );

    if (existing.length === 0) throw new Error(`Alerta ${alertId} no encontrada`);
    if (existing[0].company !== 'neggo') {
        throw new Error(`Solo se pueden descartar alertas de Neggo`);
    }
    if (existing[0].status !== 'pending') {
        throw new Error(`Alerta ${alertId} ya fue procesada (estado: ${existing[0].status})`);
    }

    const { rows: updated } = await pool.query(`
        UPDATE price_alerts
        SET status = 'dismissed', reviewed_by = $1, reviewed_at = NOW(), notes = $2
        WHERE id = $3
        RETURNING id, status, reviewed_by, reviewed_at, notes
    `, [userId, note, alertId]);

    try {
        await pool.query(`
            INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
            VALUES ($1, 'alertas', 'descartar', 'price_alert', $2, $3)
        `, [userId, alertId, JSON.stringify({ note })]);
    } catch (logErr) {
        console.error('⚠️ Error al registrar en activity_log:', logErr.message);
    }

    return updated[0];
}

// =============================================
// Resumen de alertas para dashboard
// =============================================

/**
 * Resumen para el dashboard.
 * `pending` solo cuenta alertas de Neggo (las que requieren acción del admin).
 * Las auto_applied de Preventas no requieren acción y no se muestran en el badge.
 */
async function getAlertSummary() {
    // Conteo de pendientes de Neggo (para el badge del sidebar)
    const { rows: pendingRows } = await pool.query(`
        SELECT COUNT(*) AS count FROM price_alerts
        WHERE status = 'pending' AND company = 'neggo'
    `);
    const pending = parseInt(pendingRows[0].count, 10);

    // Resumen de actualizaciones automáticas de Preventas (últimas 24hs)
    const { rows: autoRows } = await pool.query(`
        SELECT COUNT(*) AS count,
               AVG(ABS(pct_change)) AS avg_change
        FROM price_alerts
        WHERE status = 'auto_applied' AND company = 'preventas'
          AND created_at >= NOW() - INTERVAL '24 hours'
    `);

    const autoAppliedToday = {
        count: parseInt(autoRows[0].count, 10),
        avg_change_pct: autoRows[0].avg_change
            ? parseFloat(parseFloat(autoRows[0].avg_change).toFixed(1))
            : 0
    };

    // Distribución de alertas Neggo pendientes por tipo
    const { rows: typeRows } = await pool.query(`
        SELECT alert_type, COUNT(*) AS count
        FROM price_alerts
        WHERE status = 'pending' AND company = 'neggo'
        GROUP BY alert_type
        ORDER BY count DESC
    `);

    return {
        pending,
        auto_applied_today: autoAppliedToday,
        byType: typeRows.map(r => ({ type: r.alert_type, count: parseInt(r.count, 10) }))
    };
}

module.exports = { processPriceChange, approveAlert, dismissAlert, getAlertSummary };
