// Servicio de Sync Preventas — lee de preventas_sync_state (pre-computado)
// El recomputo está en preventasMatchService.js

const { callOdoo, getCompanyIds } = require('../config/odoo');
const { COSTO_EXPR, PRECIO_EXPR } = require('./preventasMatchService');
const { motivoSinPrecio, motivoOmitir, motivoRevision, motivoOdoo, ESTADOS_ODOO } = require('./preventasSyncGuards');

// =============================================
// getProductsToSync — lectura paginada (rápida)
// =============================================
const GRUPO_ESTADOS = {
    nuevos:     ['solo_scraper'],
    matcheados: ['activar', 'sin_cambios', 'precio_sube', 'precio_baja'],
    inactivar:  ['inactivar', 'solo_odoo', 'fuera_preventas'],
    // Productos de Preventas sin proveedor con fuente activa: solo consulta, nunca se aplican
    sin_fuente: ['sin_fuente'],
};

// Estados que nunca generan una acción en Odoo
const ESTADOS_SIN_ACCION = ['sin_cambios', 'sin_fuente'];
// Estados que archivan productos en Odoo: en bulk exigen elegir un proveedor
const ESTADOS_INACTIVACION = ['inactivar', 'solo_odoo', 'fuera_preventas'];

async function getProductsToSync(pool, filters = {}) {
    const { limit = 100, offset = 0, supplierId, grupo, estado, matchType, search, sinVendor } = filters;
    const where = [];
    const params = [];
    let idx = 1;

    // estado tiene prioridad sobre grupo (más específico)
    if (estado && estado !== 'todos') {
        where.push(`pss.estado = $${idx++}`);
        params.push(estado);
    } else if (grupo && grupo !== 'todos' && GRUPO_ESTADOS[grupo]) {
        where.push(`pss.estado = ANY($${idx++}::text[])`);
        params.push(GRUPO_ESTADOS[grupo]);
    }
    if (supplierId) {
        where.push(`pss.supplier_id = $${idx++}`);
        params.push(parseInt(supplierId, 10));
    }
    if (matchType && matchType !== 'todos') {
        if (matchType === 'sin_match') {
            where.push(`pss.match_type IS NULL`);
        } else {
            where.push(`pss.match_type = $${idx++}`);
            params.push(matchType);
        }
    }
    if (sinVendor) {
        where.push(`pss.match_type IS NOT NULL`);
        where.push(`pss.supplier_product_id IS NOT NULL`);
        where.push(`(opc.vendor_name IS NULL OR opc.vendor_name = '')`);
    }
    if (search && search.trim()) {
        const term = `%${search.trim().toLowerCase()}%`;
        where.push(`(
            LOWER(sp.name)          LIKE $${idx}   OR
            LOWER(sp.sku)           LIKE $${idx}   OR
            LOWER(opc.name)         LIKE $${idx}   OR
            LOWER(opc.external_id)  LIKE $${idx}   OR
            LOWER(opc.internal_ref) LIKE $${idx}
        )`);
        params.push(term);
        idx++;
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Count total para paginación — mismo FROM+JOIN que la query principal
    const countParams = [...params];
    const { rows: countRows } = await pool.query(`
        SELECT COUNT(*)::INTEGER AS total
        FROM preventas_sync_state pss
        LEFT JOIN supplier_products sp  ON sp.id  = pss.supplier_product_id
        LEFT JOIN suppliers s           ON s.id   = COALESCE(sp.supplier_id, pss.supplier_id)
        LEFT JOIN odoo_products_cache opc
            ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
        ${whereClause}
    `, countParams);

    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const { rows } = await pool.query(`
        SELECT
            pss.id,
            pss.estado,
            pss.match_type,
            pss.match_score,
            pss.costo,
            pss.precio_preventas,
            pss.computed_at,
            sp.id           AS supplier_product_id,
            sp.sku          AS scraper_sku,
            sp.name         AS scraper_name,
            sp.image_url,
            sp.raw_price,
            sp.available,
            sp.source_category,
            s.id            AS supplier_id,
            s.name          AS supplier_name,
            opc.odoo_id     AS odoo_product_id,
            opc.name        AS odoo_nombre,
            opc.external_id AS odoo_ref,
            opc.list_price  AS odoo_list_price,
            opc.standard_price AS odoo_standard_price,
            opc.active      AS odoo_active,
            opc.categ_name  AS odoo_categoria,
            opc.vendor_name AS odoo_vendor_name
        FROM preventas_sync_state pss
        LEFT JOIN supplier_products sp  ON sp.id  = pss.supplier_product_id
        LEFT JOIN suppliers s           ON s.id   = COALESCE(sp.supplier_id, pss.supplier_id)
        LEFT JOIN odoo_products_cache opc
            ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
        ${whereClause}
        ORDER BY
            CASE pss.estado
                WHEN 'activar'      THEN 1
                WHEN 'precio_sube'  THEN 2
                WHEN 'precio_baja'  THEN 3
                WHEN 'inactivar'    THEN 4
                WHEN 'solo_scraper' THEN 5
                WHEN 'solo_odoo'    THEN 6
                WHEN 'fuera_preventas' THEN 6
                ELSE                     7
            END,
            s.name ASC NULLS LAST,
            sp.name ASC NULLS LAST
        LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    // bloqueo_motivo: nunca se aplica (ni confirmando) · revision_motivo: se confirma de a uno
    for (const row of rows) {
        row.bloqueo_motivo = motivoSinPrecio(row);
        row.revision_motivo = row.bloqueo_motivo ? null : motivoRevision(row);
    }

    return { rows, total: countRows[0]?.total || 0 };
}

// =============================================
// getResumen — conteo instantáneo
// =============================================
async function getResumen(pool, supplierId = null) {
    const sid = supplierId ? parseInt(supplierId, 10) : null;
    const where = sid ? 'WHERE supplier_id = $1' : '';
    const p = sid ? [sid] : [];
    const spWhere = sid ? 'AND supplier_id = $1' : '';

    const sinVendorWhere = sid
        ? 'AND pss.supplier_id = $1'
        : '';

    const [statsRes, totalRes, lastRes, matchRes, scraperTotalRes, scraperMatchRes, scraperDisponiblesRes, odooTotalRes, odooActiveRes, sinVendorRes] = await Promise.all([
        pool.query(`SELECT estado, COUNT(*)::INTEGER AS count FROM preventas_sync_state ${where} GROUP BY estado`, p),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM preventas_sync_state ${where}`, p),
        pool.query(`SELECT MAX(computed_at) AS last_computed FROM preventas_sync_state ${where}`, p),
        pool.query(`SELECT COALESCE(match_type, 'sin_match') AS match_type, COUNT(*)::INTEGER AS count FROM preventas_sync_state ${where} GROUP BY match_type`, p),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM supplier_products WHERE true ${spWhere}`, p),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM preventas_sync_state WHERE estado = ANY(ARRAY['activar','sin_cambios','precio_sube','precio_baja']) ${spWhere}`, p),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM supplier_products WHERE available = true ${spWhere}`, p),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM odoo_products_cache WHERE company = 'preventas'`),
        pool.query(`SELECT active, COUNT(*)::INTEGER AS count FROM odoo_products_cache WHERE company = 'preventas' GROUP BY active`),
        pool.query(`
            SELECT COUNT(*)::INTEGER AS total
            FROM preventas_sync_state pss
            JOIN supplier_products sp ON sp.id = pss.supplier_product_id
            JOIN odoo_products_cache opc ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
            WHERE pss.match_type IS NOT NULL
              AND pss.supplier_product_id IS NOT NULL
              AND (opc.vendor_name IS NULL OR opc.vendor_name = '')
              ${sinVendorWhere}
        `, p),
    ]);

    const scraperTotal       = scraperTotalRes.rows[0]?.total       || 0;
    const scraperConMatch    = scraperMatchRes.rows[0]?.total        || 0;
    const scraperDisponibles = scraperDisponiblesRes.rows[0]?.total  || 0;

    const resumen = {
        total:                totalRes.rows[0]?.total || 0,
        last_computed:        lastRes.rows[0]?.last_computed || null,
        match_types:          {},
        scraper_total:        scraperTotal,
        scraper_disponibles:  scraperDisponibles,
        scraper_con_match:    scraperConMatch,
        scraper_sin_match:    scraperTotal - scraperConMatch,
        odoo_total:           odooTotalRes.rows[0]?.total || 0,
        odoo_activos:         odooActiveRes.rows.find(r => r.active === true)?.count  || 0,
        odoo_inactivos:       odooActiveRes.rows.find(r => r.active === false)?.count || 0,
        odoo_matcheados:      scraperConMatch,
    };
    resumen.sin_vendor = sinVendorRes.rows[0]?.total || 0;
    for (const r of statsRes.rows) resumen[r.estado] = r.count;
    for (const r of matchRes.rows)  resumen.match_types[r.match_type] = r.count;
    return resumen;
}

// =============================================
// applyChanges — aplica en Odoo y actualiza sync_state
// filters:  { grupo, estado } para aplicar un grupo completo sin IDs específicos
// opciones: { confirmar } — aplica también lo que requiere revisión (solo para un producto)
//
// Antes de escribir, cada producto pasa por las protecciones de preventasSyncGuards:
// datos inválidos o viejos, revisión manual, cambios hechos en Odoo y duplicados.
// Lo que no pasa queda 'omitido' con su motivo y no se toca en Odoo.
// =============================================
async function applyChanges(pool, supplierProductIds = [], odooProductIds = [], filters = {}, opciones = {}) {
    const companyIds = await getCompanyIds();
    const preventasCompanyId = companyIds.preventas;
    if (!preventasCompanyId) throw new Error('No se encontró la empresa Preventas en Odoo');

    const SELECT_COLS = `
        SELECT pss.*, sp.sku AS scraper_sku, sp.name AS scraper_name,
               sp.image_url, sp.available, sp.raw_price,
               opc.name AS odoo_nombre, opc.external_id AS odoo_ref,
               opc.internal_ref AS odoo_internal_ref,
               opc.template_id AS odoo_template_id,
               opc.has_image AS odoo_has_image,
               opc.active AS odoo_active, opc.standard_price AS odoo_standard_price,
               scr.odoo_categ_id_preventas,
               (sp.id IS NOT NULL) AS sp_existe,
               -- Costo y precio con el precio scrapeado de AHORA (detecta cálculos viejos)
               ${COSTO_EXPR} AS costo_actual,
               ${PRECIO_EXPR} AS precio_actual,
               EXISTS (
                   SELECT 1 FROM scraping_runs r
                   WHERE r.supplier_id = pss.supplier_id AND r.status IN ('running', 'queued')
               ) AS proveedor_scrapeando
        FROM preventas_sync_state pss
        LEFT JOIN supplier_products sp ON sp.id = pss.supplier_product_id
        LEFT JOIN suppliers s ON s.id = sp.supplier_id
        LEFT JOIN odoo_products_cache opc ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
        LEFT JOIN supplier_category_rules scr
            ON scr.supplier_id = pss.supplier_id
            AND scr.source_category = sp.source_category
            AND scr.active = true
    `;

    let targets;
    if (supplierProductIds.length > 0 || odooProductIds.length > 0) {
        // IDs específicos (selección manual o por página)
        const { rows: allRows } = await pool.query(`
            ${SELECT_COLS}
            WHERE (
                ($1::INTEGER[] IS NOT NULL AND pss.supplier_product_id = ANY($1::INTEGER[]))
                OR ($2::INTEGER[] IS NOT NULL AND pss.odoo_product_id  = ANY($2::INTEGER[]))
            )
        `, [
            supplierProductIds.length ? supplierProductIds : null,
            odooProductIds.length     ? odooProductIds     : null,
        ]);
        targets = allRows;
    } else {
        // Aplicar grupo/estado completo (sin paginación)
        const { grupo, estado, supplierId } = filters;
        const conditions = [`pss.estado != ALL($1::text[])`];
        const params = [ESTADOS_SIN_ACCION];
        let idx = 2;

        let estadosPedidos = null; // null = todos los estados con acción
        if (estado && estado !== 'todos') {
            estadosPedidos = [estado];
        } else if (grupo && grupo !== 'todos' && GRUPO_ESTADOS[grupo]) {
            estadosPedidos = GRUPO_ESTADOS[grupo];
        }

        // Seguridad: nunca archivar en bulk productos de todos los proveedores a la vez
        if (!supplierId) {
            if (estadosPedidos && estadosPedidos.some(e => ESTADOS_INACTIVACION.includes(e))) {
                throw new Error('Para inactivar en bloque elegí un proveedor. No se inactivan todos los proveedores juntos.');
            }
            // "Aplicar todo" sin proveedor: se aplica todo menos las inactivaciones
            conditions.push(`pss.estado != ALL($${idx++}::text[])`);
            params.push(ESTADOS_INACTIVACION);
        }

        if (estadosPedidos) {
            const estados = estadosPedidos.filter(e => !ESTADOS_SIN_ACCION.includes(e));
            if (estados.length === 0) {
                return { ok: 0, error: 0, skipped: 0, detalles: [] };
            }
            conditions.push(`pss.estado = ANY($${idx++}::text[])`);
            params.push(estados);
        }

        if (supplierId) {
            conditions.push(`pss.supplier_id = $${idx++}`);
            params.push(parseInt(supplierId, 10));
        }

        const { rows: allRows } = await pool.query(`
            ${SELECT_COLS}
            WHERE ${conditions.join(' AND ')}
        `, params);
        targets = allRows;
    }

    const resultados = { ok: 0, error: 0, skipped: 0, omitidos: 0, detalles: [] };
    const ctx = { allowed_company_ids: [preventasCompanyId] };
    const confirmar = opciones.confirmar === true;

    // Estado actual en Odoo de los productos a tocar (no confiar solo en el cache)
    const odooActual = await leerEstadoOdoo(
        targets.filter(p => p.odoo_product_id && ESTADOS_ODOO.includes(p.estado)).map(p => p.odoo_product_id),
        ctx
    );

    for (const prod of targets) {
        if (ESTADOS_SIN_ACCION.includes(prod.estado)) { resultados.skipped++; continue; }

        try {
            const motivo = motivoOmitir(prod)
                || (confirmar ? null : motivoRevision(prod))
                || (prod.odoo_product_id ? motivoOdoo(prod, odooActual.get(prod.odoo_product_id) || null) : null)
                || (prod.estado === 'solo_scraper' ? await buscarDuplicadoEnOdoo(prod, ctx, pool) : null);
            if (motivo) {
                resultados.omitidos++;
                resultados.detalles.push({
                    sku:       prod.scraper_sku || prod.odoo_ref,
                    nombre:    prod.scraper_name || prod.odoo_nombre,
                    estado:    prod.estado,
                    resultado: 'omitido',
                    motivo,
                });
                continue;
            }

            await ejecutarAccion(prod, preventasCompanyId, pool);
            resultados.ok++;
            resultados.detalles.push({
                sku:       prod.scraper_sku || prod.odoo_ref,
                nombre:    prod.scraper_name || prod.odoo_nombre,
                estado:    prod.estado,
                resultado: 'ok',
            });
        } catch (err) {
            console.error(`❌ Error en ${prod.scraper_sku || prod.odoo_ref}:`, err.message);
            resultados.error++;
            resultados.detalles.push({
                sku:       prod.scraper_sku || prod.odoo_ref,
                nombre:    prod.scraper_name || prod.odoo_nombre,
                estado:    prod.estado,
                resultado: 'error',
                error:     err.message,
            });
        }
    }

    console.log(`✅ Apply Preventas: ${resultados.ok} ok, ${resultados.error} errores, ${resultados.omitidos} omitidos por protección`);
    return resultados;
}

// ─── Protecciones que consultan Odoo ──────────────────────────────────────────

/**
 * Lee de Odoo costo y estado (activo/archivado) de los productos, en lotes.
 * Si Odoo no responde se corta el apply: sin el estado real no se escribe nada.
 * @returns {Map<number, {standard_price, active}>} — un ID ausente = ya no existe en Odoo
 */
async function leerEstadoOdoo(odooIds, ctx) {
    const mapa = new Map();
    const ids = [...new Set(odooIds)];
    const LOTE = 200;
    for (let i = 0; i < ids.length; i += LOTE) {
        const filas = await callOdoo('product.product', 'search_read',
            [[['id', 'in', ids.slice(i, i + LOTE)]]],
            { fields: ['id', 'standard_price', 'active'], context: { ...ctx, active_test: false } });
        for (const f of filas) mapa.set(f.id, { standard_price: f.standard_price, active: f.active });
    }
    return mapa;
}

// Referencia interna que se le pone en Odoo a un producto creado desde el scraper
const refPreventas = sku => (sku.startsWith('PRE') ? sku : `PRE${sku}`);

/**
 * Antes de crear: si el código ya existe en Odoo (cache, default_code o external ID),
 * no se crea un duplicado. Devuelve el motivo para omitir o null.
 */
async function buscarDuplicadoEnOdoo(prod, ctx, pool) {
    const ref = refPreventas(prod.scraper_sku);
    const sugerencia = 'recalculá para vincularlo en vez de crearlo de nuevo';

    const { rows } = await pool.query(`
        SELECT odoo_id FROM odoo_products_cache
        WHERE company = 'preventas'
          AND (ext_id_clean = UPPER($1)
               OR UPPER(REGEXP_REPLACE(internal_ref, '[^A-Za-z0-9]', '', 'g'))
                  = UPPER(REGEXP_REPLACE($2, '[^A-Za-z0-9]', '', 'g')))
        LIMIT 1
    `, [prod.scraper_sku, ref]);
    if (rows[0]) return `Ya existe en Odoo (producto ${rows[0].odoo_id}): ${sugerencia}`;

    const porCodigo = await callOdoo('product.product', 'search_read',
        [[['default_code', '=', ref]]],
        { fields: ['id'], limit: 1, context: { ...ctx, active_test: false } });
    if (porCodigo.length) return `Ya existe en Odoo con el código ${ref} (producto ${porCodigo[0].id}): ${sugerencia}`;

    const porExtId = await callOdoo('ir.model.data', 'search_read',
        [[['name', '=', prod.scraper_sku], ['model', '=', 'product.product']]],
        { fields: ['res_id'], limit: 1 });
    if (porExtId.length) return `Ya existe en Odoo con el ID externo ${prod.scraper_sku} (producto ${porExtId[0].res_id}): ${sugerencia}`;

    return null;
}

// ─── ejecutarAccion ────────────────────────────────────────────────────────────

async function ejecutarAccion(prod, preventasCompanyId, pool) {
    const ctx = { allowed_company_ids: [preventasCompanyId] };

    if (prod.estado === 'solo_scraper') {
        await crearEnOdoo(prod, preventasCompanyId, pool);
        return;
    }

    // ─── Archivar / desarchivar — usa action_archive/unarchive en product.template
    // para que afecte el template y todas sus variantes (comportamiento correcto en Odoo).
    if (ESTADOS_INACTIVACION.includes(prod.estado)) {
        const templateId = prod.odoo_template_id;
        if (!templateId) {
            throw new Error(`Producto ${prod.odoo_ref || prod.odoo_product_id} sin template_id en cache — hacé un sync de Odoo primero`);
        }

        console.log(`📦 inactivar: llamando Odoo write active=false → template ${templateId}, ctx:`, JSON.stringify(ctx));
        const writeResult = await callOdoo('product.template', 'write', [[templateId], { active: false }], { context: ctx });
        console.log(`📦 inactivar: Odoo respondió:`, JSON.stringify(writeResult));
        console.log(`✅ inactivar: template ${templateId} (${prod.odoo_ref || prod.scraper_sku}) inactivado en Odoo Preventas`);

        await pool.query(
            `UPDATE odoo_products_cache SET active = false WHERE template_id = $1 AND company = 'preventas'`,
            [templateId]
        );
        await pool.query(
            `UPDATE preventas_sync_state SET estado = 'sin_cambios' WHERE id = $1`, [prod.id]
        );
        return;
    }

    if (prod.estado === 'activar') {
        const templateId = prod.odoo_template_id;
        if (templateId) {
            await callOdoo('product.template', 'action_unarchive', [[templateId]], { context: ctx });
            console.log(`✅ activar: template ${templateId} (${prod.odoo_ref || prod.scraper_sku}) desarchivado en Odoo Preventas`);
            await pool.query(
                `UPDATE odoo_products_cache SET active = true WHERE template_id = $1 AND company = 'preventas'`,
                [templateId]
            );
        } else {
            await callOdoo('product.product', 'write',
                [[prod.odoo_product_id], { active: true }], { context: ctx });
            await pool.query(
                `UPDATE odoo_products_cache SET active = true WHERE odoo_id = $1 AND company = 'preventas'`,
                [prod.odoo_product_id]
            );
        }
        await pool.query(
            `UPDATE preventas_sync_state SET estado = 'sin_cambios' WHERE id = $1`, [prod.id]
        );
        return;
    }

    // Construir los cambios a enviar a Odoo (precio + categ + ref)
    const updates = {};

    switch (prod.estado) {
        case 'precio_sube':
        case 'precio_baja':
            updates.lst_price      = Number(prod.precio_preventas);
            updates.standard_price = Number(prod.costo);
            break;
    }

    // Actualizar categoría en Odoo si la regla la define
    if (prod.odoo_categ_id_preventas) {
        updates.categ_id = prod.odoo_categ_id_preventas;
    }

    // Write-back de código de referencia: si Odoo no tiene default_code, agregarlo.
    // Formato Preventas: PRE + SKU del proveedor.
    let refCode = null;
    if (prod.odoo_product_id && !prod.odoo_internal_ref && prod.scraper_sku) {
        refCode = prod.scraper_sku.startsWith('PRE')
            ? prod.scraper_sku
            : `PRE${prod.scraper_sku}`;
        updates.default_code = refCode;
    }

    // Ejecutar update en Odoo solo si hay algo que cambiar
    if (Object.keys(updates).length > 0) {
        await callOdoo('product.product', 'write',
            [[prod.odoo_product_id], updates], { context: ctx });
        console.log(`✅ ${prod.estado} aplicado: ${prod.scraper_sku || prod.odoo_ref} ${JSON.stringify(updates)}`);
    }

    // Actualizar cache con los nuevos precios para que el recomputo no revierta el estado
    if (updates.standard_price !== undefined && prod.odoo_product_id) {
        await pool.query(
            `UPDATE odoo_products_cache
             SET standard_price = $1, list_price = $2
             WHERE odoo_id = $3 AND company = 'preventas'`,
            [updates.standard_price, updates.lst_price ?? null, prod.odoo_product_id]
        );
    }

    // Actualizar cache local con ref si se escribió
    if (refCode) {
        await pool.query(
            `UPDATE odoo_products_cache SET internal_ref = $1 WHERE odoo_id = $2 AND company = 'preventas'`,
            [refCode, prod.odoo_product_id]
        );
        console.log(`🔗 Referencia escrita: ${refCode} → producto ${prod.odoo_product_id}`);
    }

    // Sincronizar imagen solo si Odoo no tiene una y tenemos URL del scraper
    if (prod.image_url && !prod.odoo_has_image && prod.odoo_template_id) {
        await syncImage(prod.odoo_template_id, prod.image_url, ctx, pool, prod.odoo_product_id);
    }

    await pool.query(
        `UPDATE preventas_sync_state SET estado = 'sin_cambios' WHERE id = $1`, [prod.id]);
}

// ─── crearEnOdoo ──────────────────────────────────────────────────────────────

async function crearEnOdoo(prod, preventasCompanyId, pool) {
    const ctx = { allowed_company_ids: [preventasCompanyId] };

    // Formato Preventas: PRE + SKU del proveedor (que ya tiene el prefijo del proveedor)
    // Ej: scraper_sku="CAST001" → internalRef="PRECAST001"
    const internalRef = refPreventas(prod.scraper_sku);

    // Defensa final: nunca crear un producto a $0 (applyChanges ya lo filtra antes)
    const listPrice = Number(prod.precio_preventas);
    const costPrice = Number(prod.costo);
    if (!(listPrice > 0) || !(costPrice > 0)) {
        throw new Error(`Precio inválido para crear ${prod.scraper_sku}: costo=${prod.costo}, precio=${prod.precio_preventas}`);
    }

    const templateData = {
        name:           prod.scraper_name,
        default_code:   internalRef,
        list_price:     listPrice,
        standard_price: costPrice,
        company_id:     preventasCompanyId,
        type:           'consu',
        active:         true,
    };
    if (prod.odoo_categ_id_preventas) {
        templateData.categ_id = prod.odoo_categ_id_preventas;
    }

    const templateId = await callOdoo('product.template', 'create', [templateData], { context: ctx });

    const variants = await callOdoo('product.product', 'search_read',
        [[['product_tmpl_id', '=', templateId]]],
        { fields: ['id'], context: ctx, limit: 1 }
    );
    const variantId = variants[0]?.id;
    if (!variantId) throw new Error(`No se encontró variante para template ${templateId}`);

    // Usar search_read + create para evitar error si el external ID ya existe
    // (puede pasar si el run anterior falló a mitad)
    const existingExtId = await callOdoo('ir.model.data', 'search_read',
        [[['name', '=', prod.scraper_sku], ['model', '=', 'product.product'], ['module', '=', '__import__']]],
        { fields: ['id'], limit: 1, context: ctx }
    );
    if (existingExtId.length === 0) {
        await callOdoo('ir.model.data', 'create', [{
            name:   prod.scraper_sku,
            model:  'product.product',
            res_id: variantId,
            module: '__import__',
        }], { context: ctx });
    }

    // Actualizar sync_state: ya está relacionado
    await pool.query(`
        UPDATE preventas_sync_state
        SET odoo_product_id = $1, match_type = 'exact_sku', match_score = 100, estado = 'sin_cambios'
        WHERE id = $2
    `, [variantId, prod.id]);

    // Insertar en cache local
    await pool.query(`
        INSERT INTO odoo_products_cache
            (odoo_id, company, name, internal_ref, list_price, standard_price, active, external_id, ext_id_clean, synced_at)
        VALUES ($1, 'preventas', $2, $3, $4, $5, true, $6, UPPER(REGEXP_REPLACE($6, '[^A-Z0-9]', '', 'g')), NOW())
        ON CONFLICT (odoo_id, company) DO UPDATE SET
            name = EXCLUDED.name, internal_ref = EXCLUDED.internal_ref,
            list_price = EXCLUDED.list_price, standard_price = EXCLUDED.standard_price,
            external_id = EXCLUDED.external_id, ext_id_clean = EXCLUDED.ext_id_clean,
            active = true, synced_at = NOW()
    `, [variantId, prod.scraper_name, internalRef,
        Number(prod.precio_preventas) || 0, Number(prod.costo) || 0, prod.scraper_sku]);

    if (prod.image_url) await syncImage(templateId, prod.image_url, ctx, pool, variantId);
    console.log(`✅ Creado en Odoo Preventas: ${prod.scraper_sku} (variant: ${variantId})`);
}

// Imagen de un producto de Neggo: se copia directo desde Odoo (la URL local es un proxy relativo)
const NEGGO_IMAGE_RE = /^\/api\/products\/odoo-image\/neggo\/(\d+)$/;

async function getImageBase64(imageUrl) {
    const m = imageUrl.match(NEGGO_IMAGE_RE);
    if (m) {
        const { neggo: neggoId } = await getCompanyIds();
        const data = await callOdoo('product.template', 'read',
            [[parseInt(m[1], 10)], ['image_1920']], { context: { allowed_company_ids: [neggoId] } });
        return data?.[0]?.image_1920 || null;
    }
    const res = await fetch(imageUrl);
    if (!res.ok) {
        console.warn(`⚠️ No se pudo descargar imagen: ${imageUrl} (${res.status})`);
        return null;
    }
    return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function syncImage(templateId, imageUrl, ctx, pool, variantId) {
    try {
        const base64 = await getImageBase64(imageUrl);
        if (!base64) return;
        // Escribir en product.template con el template ID correcto
        await callOdoo('product.template', 'write', [[templateId], { image_1920: base64 }], { context: ctx });
        // Marcar has_image = true en cache para no re-subir en futuros applies
        if (pool && variantId) {
            await pool.query(
                `UPDATE odoo_products_cache SET has_image = true WHERE odoo_id = $1 AND company = 'preventas'`,
                [variantId]
            );
        }
        console.log(`🖼️ Imagen sincronizada: template ${templateId}`);
    } catch (err) {
        console.warn(`⚠️ No se pudo sincronizar imagen para template ${templateId}:`, err.message);
    }
}

module.exports = { getProductsToSync, applyChanges, getResumen };
