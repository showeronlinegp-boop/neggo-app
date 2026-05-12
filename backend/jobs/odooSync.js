// Sync completo de productos Odoo → cache local PostgreSQL
// Cada sync trae TODOS los productos (activos e inactivos) de cada empresa.
// Al finalizar, cualquier odoo_id que no haya aparecido en el resultado
// se marca como inactive=true en el cache — fue eliminado o movido de empresa.

const { callOdoo, getCompanyIds } = require('../config/odoo');
const pool = require('../config/database');
const { scheduleRecompute } = require('../services/preventasMatchService');

const PAGE_SIZE = 200;

// =============================================
// Registro de sincronizaciones
// =============================================

async function setLastSync(company, recordsSynced = 0) {
    await pool.query(
        `INSERT INTO sync_log (company, last_sync, records_synced)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (company) DO UPDATE SET last_sync = NOW(), records_synced = $2`,
        [company, recordsSynced]
    );
}

// =============================================
// Fetch completo desde Odoo
// =============================================

async function fetchAllProducts(companyId) {
    // Incluir productos propios de la empresa Y productos compartidos (company_id = False).
    // Los compartidos no tienen company_id asignado pero son accesibles desde todas las empresas.
    const domain = [
        ['active', 'in', [true, false]],
        '|',
        ['company_id', '=', companyId],
        ['company_id', '=', false]
    ];

    const fields = [
        'id', 'name', 'default_code', 'barcode',
        'list_price', 'standard_price', 'categ_id',
        'qty_available', 'active', 'description_purchase',
        'product_tmpl_id', 'type', 'has_image'
    ];

    const allProducts = [];
    let offset = 0;
    const DEBUG_ID = 54537;

    while (true) {
        const batch = await callOdoo(
            'product.product',
            'search_read',
            [domain],
            {
                fields,
                limit:   PAGE_SIZE,
                offset,
                context: { allowed_company_ids: [companyId] }
            }
        );

        const page = Math.floor(offset / PAGE_SIZE) + 1;
        console.log(`🔍 Fetch página ${page}: offset=${offset} → ${batch.length} productos (IDs ${batch[0]?.id}..${batch[batch.length-1]?.id})`);

        const found = batch.find(p => p.id === DEBUG_ID);
        if (found) {
            console.log(`⚠️  ENCONTRADO ID ${DEBUG_ID} en página ${page}:`, JSON.stringify({
                id: found.id, name: found.name, active: found.active,
                company_id: found.company_id, default_code: found.default_code,
                product_tmpl_id: found.product_tmpl_id
            }));
        }

        allProducts.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    // Verificar si el ID de debug está en el resultado final
    if (!allProducts.find(p => p.id === DEBUG_ID)) {
        console.log(`✅ ID ${DEBUG_ID} NO está en los resultados de Odoo — debería eliminarse del cache`);
    }

    if (allProducts.length === 0) return allProducts;

    // Buscar external IDs en ir.model.data — primero en product.product, después en product.template
    const productIds  = allProducts.map(p => p.id);
    const templateIds = [...new Set(allProducts.map(p => p.product_tmpl_id?.[0]).filter(Boolean))];

    const [variantMap, templateMap] = await Promise.all([
        fetchExternalIds('product.product',  productIds),
        fetchExternalIds('product.template', templateIds),
    ]);

    // Construir mapa templateId → nombre externo
    for (const p of allProducts) {
        const tmplId = p.product_tmpl_id?.[0];
        p.external_id =
            variantMap[p.id]          ||
            (tmplId && templateMap[tmplId]) ||
            null;
    }

    const withExternalId = allProducts.filter(p => p.external_id).length;
    if (withExternalId > 0) {
        console.log(`📦 external_ids encontrados: ${withExternalId}/${allProducts.length}`);
    } else {
        console.warn(`⚠️ Ningún producto tiene external_id en ir.model.data`);
    }

    // Traer el primer proveedor (vendor) de cada producto desde product.supplierinfo
    const vendorMap = await fetchVendors(templateIds, companyId);
    for (const p of allProducts) {
        const tmplId = p.product_tmpl_id?.[0];
        p.vendor_name = (tmplId && vendorMap[tmplId]) || null;
    }

    return allProducts;
}

/**
 * Trae campos de product.template que no están disponibles en product.product:
 * available_in_pos, website_published, public_categ_ids (primer categoría web).
 * Retorna un objeto { templateId: { available_in_pos, is_published, web_categ_id } }.
 */
async function fetchTemplateFields(templateIds, companyId) {
    const map = {};
    if (templateIds.length === 0) return map;

    const BATCH = 200;
    const allWebCategIds = new Set();

    for (let i = 0; i < templateIds.length; i += BATCH) {
        const batch = templateIds.slice(i, i + BATCH);
        try {
            const templates = await callOdoo(
                'product.template', 'read',
                [batch, ['id', 'available_in_pos', 'website_published', 'public_categ_ids']],
                { context: { allowed_company_ids: [companyId] } }
            );
            for (const t of templates) {
                const webCategId = t.public_categ_ids?.[0] || null;
                if (webCategId) allWebCategIds.add(webCategId);
                map[t.id] = {
                    available_in_pos: t.available_in_pos || false,
                    is_published:     t.website_published || false,
                    web_categ_id:     webCategId,
                    web_categ_name:   null,
                };
            }
        } catch (err) {
            console.warn('⚠️ No se pudo obtener campos de templates Odoo:', err.message);
        }
    }

    // Resolver nombres de categorías web
    if (allWebCategIds.size > 0) {
        try {
            const catNames = await callOdoo(
                'product.public.category', 'read',
                [[...allWebCategIds], ['id', 'name']],
                { context: { allowed_company_ids: [companyId] } }
            );
            const nameMap = Object.fromEntries(catNames.map(c => [c.id, c.name]));
            for (const tf of Object.values(map)) {
                if (tf.web_categ_id) tf.web_categ_name = nameMap[tf.web_categ_id] || null;
            }
        } catch (err) {
            console.warn('⚠️ No se pudo obtener nombres de categorías web:', err.message);
        }
    }

    return map;
}

/**
 * Trae el primer proveedor (seller) de cada template desde product.supplierinfo.
 * Retorna un objeto { templateId: vendorName }.
 * Necesita companyId para pasar el contexto correcto en multi-empresa.
 */
async function fetchVendors(templateIds, companyId) {
    const map = {};
    if (templateIds.length === 0) return map;

    const BATCH = 500;
    for (let i = 0; i < templateIds.length; i += BATCH) {
        const batch = templateIds.slice(i, i + BATCH);
        try {
            const infos = await callOdoo(
                'product.supplierinfo',
                'search_read',
                [[['product_tmpl_id', 'in', batch]]],
                {
                    fields: ['product_tmpl_id', 'partner_id', 'sequence', 'company_id'],
                    order: 'sequence asc',
                    ...(companyId ? { context: { allowed_company_ids: [companyId] } } : {}),
                }
            );
            for (const info of infos) {
                const tmplId = info.product_tmpl_id?.[0];
                if (tmplId && !map[tmplId]) {
                    map[tmplId] = info.partner_id?.[1] || null;
                }
            }
        } catch (err) {
            console.warn('⚠️ No se pudo obtener proveedores de Odoo:', err.message);
        }
    }
    return map;
}

/**
 * Trae los IDs externos de ir.model.data para un modelo y lista de res_ids.
 * Retorna un objeto { res_id: name } donde name es el nombre sin el prefijo de módulo.
 */
async function fetchExternalIds(model, resIds) {
    const map = {};
    if (resIds.length === 0) return map;

    // ir.model.data en lotes para no superar límites de Odoo
    const BATCH = 500;
    for (let i = 0; i < resIds.length; i += BATCH) {
        const batchIds = resIds.slice(i, i + BATCH);
        const records = await callOdoo(
            'ir.model.data',
            'search_read',
            [[['model', '=', model], ['res_id', 'in', batchIds]]],
            { fields: ['res_id', 'name', 'module'] }
        );
        for (const r of records) {
            // Preferir registros con module != '__export__' si existe
            if (!map[r.res_id] || r.module !== '__export__') {
                map[r.res_id] = r.name;
            }
        }
    }
    return map;
}

// =============================================
// Upsert por lotes
// =============================================

async function upsertProducts(products, companyKey) {
    if (products.length === 0) return 0;

    const BATCH = 50;
    let total = 0;

    for (let i = 0; i < products.length; i += BATCH) {
        const slice = products.slice(i, i + BATCH);

        const artCodeRe = /\bArt\.\s+(\S+)\s*$/i;
        const values = [];
        const placeholders = slice.map((p, idx) => {
            const base = idx * 21;
            let internalRef = p.default_code || null;
            if (!internalRef && companyKey === 'preventas' && p.name) {
                const m = p.name.match(artCodeRe);
                if (m) internalRef = `PRE${m[1]}`;
            }
            const templateId = p.product_tmpl_id?.[0] || null;
            const imageUrl = (p.has_image && templateId)
                ? `/api/products/odoo-image/${companyKey}/${templateId}`
                : null;
            values.push(
                p.id,
                companyKey,
                p.name || null,
                internalRef,
                p.barcode || null,
                p.list_price        ?? null,
                p.standard_price    ?? null,
                p.categ_id ? p.categ_id[1] : null,
                p.categ_id ? p.categ_id[0] : null,
                p.qty_available     ?? null,
                p.description_purchase || null,
                p.external_id || null,
                p.external_id ? p.external_id.toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
                p.vendor_name || null,
                templateId,
                p.has_image ? true : false,
                imageUrl,
                p.available_in_pos ?? false,
                p.is_published     ?? false,
                p.web_categ_id     ?? null,
                p.web_categ_name   ?? null
            );
            return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},${p.active ? 'true' : 'false'},NOW(),$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16},$${base+17},$${base+18},$${base+19},$${base+20},$${base+21})`;
        });

        await pool.query(
            `INSERT INTO odoo_products_cache
                (odoo_id, company, name, internal_ref, barcode, list_price, standard_price, categ_name, categ_id_odoo, qty_available, active, synced_at, description_purchase, external_id, ext_id_clean, vendor_name, template_id, has_image, image_url, available_in_pos, is_published, web_categ_id, web_categ_name)
             VALUES ${placeholders.join(',')}
             ON CONFLICT (odoo_id, company) DO UPDATE SET
                name                 = EXCLUDED.name,
                internal_ref         = EXCLUDED.internal_ref,
                barcode              = EXCLUDED.barcode,
                list_price           = EXCLUDED.list_price,
                standard_price       = EXCLUDED.standard_price,
                categ_name           = EXCLUDED.categ_name,
                categ_id_odoo        = EXCLUDED.categ_id_odoo,
                qty_available        = EXCLUDED.qty_available,
                active               = EXCLUDED.active,
                description_purchase = EXCLUDED.description_purchase,
                external_id          = EXCLUDED.external_id,
                ext_id_clean         = EXCLUDED.ext_id_clean,
                vendor_name          = EXCLUDED.vendor_name,
                template_id          = EXCLUDED.template_id,
                has_image            = EXCLUDED.has_image,
                image_url            = EXCLUDED.image_url,
                available_in_pos     = EXCLUDED.available_in_pos,
                is_published         = EXCLUDED.is_published,
                web_categ_id         = EXCLUDED.web_categ_id,
                web_categ_name       = EXCLUDED.web_categ_name,
                synced_at            = NOW()`,
            values
        );

        total += slice.length;
    }

    return total;
}

// =============================================
// Cleanup: marcar como inactivos los IDs no vistos
// =============================================

async function cleanupMissing(seenIds, companyKey) {
    if (seenIds.length === 0) return 0;

    // Ver qué productos del cache no están en seenIds (diagnóstico)
    const { rows: orphans } = await pool.query(
        `SELECT odoo_id, name, active FROM odoo_products_cache
         WHERE company = $1
           AND odoo_id NOT IN (SELECT unnest($2::int[]))`,
        [companyKey, seenIds]
    );
    if (orphans.length > 0) {
        console.log(`🔍 Sync Odoo [${companyKey}]: ${orphans.length} producto(s) en cache pero NO en Odoo:`);
        for (const o of orphans) {
            console.log(`   → odoo_id=${o.odoo_id} active=${o.active} name="${o.name}"`);
        }
    }

    // Eliminar del cache los productos que ya no existen en Odoo.
    // Los archivados (active=false en Odoo) SÍ aparecen en el sync y se actualizan
    // por upsertProducts — no caen acá. Solo los eliminados quedan fuera de seenIds.
    const { rowCount, rows: deleted } = await pool.query(
        `DELETE FROM odoo_products_cache
         WHERE company = $1
           AND odoo_id NOT IN (SELECT unnest($2::int[]))
         RETURNING odoo_id`,
        [companyKey, seenIds]
    );

    // Limpiar invoice_code_mappings que apuntaban a esos productos eliminados.
    if (deleted.length > 0) {
        const deletedIds = deleted.map(r => r.odoo_id);
        const { rowCount: mappingsDeleted } = await pool.query(
            `DELETE FROM invoice_code_mappings
             WHERE odoo_company = $1 AND odoo_product_id = ANY($2::int[])`,
            [companyKey, deletedIds]
        );
        if (mappingsDeleted > 0) {
            console.log(`🧹 Sync Odoo [${companyKey}]: ${mappingsDeleted} mapping(s) eliminados junto con productos borrados en Odoo`);
        }
    }

    return rowCount;
}

// =============================================
// Sync principal
// =============================================

async function syncOdooProducts() {
    const companyIds = await getCompanyIds();

    const empresas = [
        { key: 'neggo',     id: companyIds.neggo     },
        { key: 'preventas', id: companyIds.preventas  }
    ];

    for (const empresa of empresas) {
        if (!empresa.id) {
            console.warn(`⚠️ Sync Odoo: company "${empresa.key}" no encontrada. Omitiendo.`);
            continue;
        }

        // Registrar el inicio del sync ANTES del upsert para que el cleanup sea correcto
        const syncStart = new Date();
        console.log(`📦 Sync Odoo [${empresa.key}]: iniciando sync completo...`);

        try {
            const products = await fetchAllProducts(empresa.id);

            // Campos de template no disponibles en product.product
            const templateIds = [...new Set(products.map(p => p.product_tmpl_id?.[0]).filter(Boolean))];
            const templateFieldsMap = await fetchTemplateFields(templateIds, empresa.id);
            for (const p of products) {
                const tf = templateFieldsMap[p.product_tmpl_id?.[0]] || {};
                p.available_in_pos = tf.available_in_pos ?? false;
                p.is_published     = tf.is_published     ?? false;
                p.web_categ_id     = tf.web_categ_id     ?? null;
                p.web_categ_name   = tf.web_categ_name   ?? null;
            }

            const odooActivos   = products.filter(p => p.active).length;
            const odooInactivos = products.filter(p => !p.active).length;
            const byType = products.reduce((acc, p) => {
                const t = p.type || 'unknown';
                acc[t] = (acc[t] || 0) + 1;
                return acc;
            }, {});
            console.log(`📦 Sync Odoo [${empresa.key}]: ${products.length} recibidos (activos=${odooActivos}, inactivos=${odooInactivos})`);
            console.log(`📦 Tipos [${empresa.key}]:`, JSON.stringify(byType));

            if (products.length === 0) {
                console.warn(`⚠️ Sync Odoo [${empresa.key}]: Odoo no devolvió productos. Abortando cleanup para evitar borrar todo el cache.`);
                continue;
            }

            const { rows: cacheAntes } = await pool.query(
                `SELECT COUNT(*) FILTER (WHERE active) AS activos,
                        COUNT(*) FILTER (WHERE NOT active) AS inactivos
                 FROM odoo_products_cache WHERE company = $1`,
                [empresa.key]
            );
            console.log(`📊 Cache ANTES  [${empresa.key}]: activos=${cacheAntes[0].activos}, inactivos=${cacheAntes[0].inactivos}`);

            const upserted = await upsertProducts(products, empresa.key);

            const { rows: cacheDespues } = await pool.query(
                `SELECT COUNT(*) FILTER (WHERE active) AS activos,
                        COUNT(*) FILTER (WHERE NOT active) AS inactivos
                 FROM odoo_products_cache WHERE company = $1`,
                [empresa.key]
            );
            console.log(`📊 Cache DESPUÉS [${empresa.key}]: activos=${cacheDespues[0].activos}, inactivos=${cacheDespues[0].inactivos}`);

            // Comparar por ID externo: cualquier entrada no actualizada en este sync
            // no está en Odoo → fue eliminada o movida de empresa
            const removed = await cleanupMissing(
                products.map(p => p.id),
                empresa.key
            );

            if (removed > 0) {
                console.log(`🧹 Sync Odoo [${empresa.key}]: ${removed} producto(s) eliminados de Odoo → marcados inactivos y mappings limpiados`);
            }

            // Para Preventas: copiar vendor_name desde el producto Neggo matcheado
            // cuando el producto Preventas no tiene vendor propio en Odoo.
            if (empresa.key === 'preventas') {
                const { rowCount: vendorsFilled } = await pool.query(`
                    UPDATE odoo_products_cache opc_p
                    SET vendor_name = opc_n.vendor_name
                    FROM odoo_products_cache opc_n
                    WHERE opc_p.company = 'preventas'
                      AND opc_n.company = 'neggo'
                      AND opc_p.vendor_name IS NULL
                      AND opc_n.vendor_name IS NOT NULL
                      AND opc_p.internal_ref IS NOT NULL
                      AND opc_n.internal_ref IS NOT NULL
                      AND REPLACE(REPLACE(UPPER(opc_p.internal_ref), '-', ''), ' ', '')
                          = CONCAT('PRE', REPLACE(REPLACE(UPPER(opc_n.internal_ref), '-', ''), ' ', ''))
                `);
                if (vendorsFilled > 0) {
                    console.log(`✅ Sync Odoo [preventas]: ${vendorsFilled} productos rellenaron vendor_name desde Neggo`);
                }
            }

            await setLastSync(empresa.key, upserted);
            console.log(`✅ Sync Odoo [${empresa.key}]: ${upserted} actualizados, ${removed} eliminados del cache`);

        } catch (err) {
            console.error(`❌ Sync Odoo [${empresa.key}]: ${err.message}`);
        }
    }

    // Recomputar relaciones después de sincronizar Odoo Preventas
    scheduleRecompute(pool);
}

module.exports = { syncOdooProducts };
