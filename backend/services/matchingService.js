// Servicio de matching automático: supplier_products <-> odoo_products_cache
// Nivel 1: match por referencia interna (confianza 1.0)
// Nivel 2: fuzzy matching por nombre (confianza 0.5–0.9)

const pool = require('../config/database');

// =============================================
// Utilidades de texto
// =============================================

/**
 * Normaliza un string: lowercase, sin acentos, solo alfanuméricos y espacios.
 */
function normalize(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Distancia de Levenshtein — implementación iterativa con matriz DP.
 * No usa librerías externas.
 */
function levenshtein(a, b) {
    const la = a.length;
    const lb = b.length;

    // Caso trivial
    if (la === 0) return lb;
    if (lb === 0) return la;

    // Usamos dos filas en lugar de la matriz completa (optimización de memoria)
    let prev = [];
    let curr = [];

    for (let j = 0; j <= lb; j++) prev[j] = j;

    for (let i = 1; i <= la; i++) {
        curr[0] = i;
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,       // eliminación
                curr[j - 1] + 1,   // inserción
                prev[j - 1] + cost // sustitución
            );
        }
        // Intercambiar filas
        [prev, curr] = [curr, prev];
    }

    return prev[lb];
}

/**
 * Similitud entre dos strings: 1 - (distancia / maxLen).
 * Retorna valor entre 0.0 y 1.0.
 */
function similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

// =============================================
// Matching por referencia interna (Nivel 1)
// =============================================

/**
 * Verifica si una referencia interna de Odoo corresponde al
 * prefijo + SKU del proveedor.
 *
 * Odoo usa `{PREFIX}-{SKU}` para neggo y `PRE{PREFIX}-{SKU}` para preventas.
 */
function matchByRef(odooRef, supplierPrefix, supplierSku) {
    if (!odooRef || !supplierSku) return false;
    const cleanRef = odooRef.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanSku = supplierSku.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prefix = supplierPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return cleanRef.includes(prefix + cleanSku);
}

// =============================================
// Función principal: match por referencia
// =============================================

/**
 * Para cada supplier_product del proveedor, busca en odoo_products_cache
 * (ambas empresas) por internal_ref.
 * Inserta en product_mappings con match_type='auto_ref', confidence=1.0, como sugerido e inactivo:
 * un vínculo activo mueve precios en Odoo, así que solo lo activa una confirmación.
 *
 * @param {number} supplierId
 * @returns {Promise<{ matched: number, skipped: number }>}
 */
async function autoMatchByRef(supplierId) {
    console.log(`📦 Iniciando match por referencia para proveedor ID: ${supplierId}`);

    // Obtener proveedor y su prefijo
    const { rows: supplierRows } = await pool.query(
        'SELECT id, name, prefix FROM suppliers WHERE id = $1 AND active = true',
        [supplierId]
    );

    if (supplierRows.length === 0) {
        throw new Error(`Proveedor ${supplierId} no encontrado o inactivo`);
    }
    const supplier = supplierRows[0];

    // Obtener todos los supplier_products del proveedor con SKU
    const { rows: supplierProducts } = await pool.query(
        `SELECT id, sku, name FROM supplier_products
         WHERE supplier_id = $1 AND sku IS NOT NULL AND sku <> ''`,
        [supplierId]
    );

    if (supplierProducts.length === 0) {
        console.log(`⚠️ Proveedor ${supplierId} no tiene productos con SKU`);
        return { matched: 0, skipped: 0 };
    }

    // Obtener todos los productos del cache de Odoo (ambas empresas) con referencia interna
    const { rows: odooProducts } = await pool.query(
        `SELECT id, odoo_id, company, name, internal_ref
         FROM odoo_products_cache
         WHERE internal_ref IS NOT NULL AND internal_ref <> '' AND active = true`
    );

    let matched = 0;
    let skipped = 0;

    for (const sp of supplierProducts) {
        for (const op of odooProducts) {
            if (!matchByRef(op.internal_ref, supplier.prefix, sp.sku)) continue;

            try {
                await pool.query(
                    `INSERT INTO product_mappings
                        (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                         match_type, match_confidence, active, estado, metodo)
                     VALUES ($1, $2, $3, $4, 'auto_ref', 1.0, false, 'sugerido', 'auto_ref')
                     ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`,
                    [sp.id, op.odoo_id, op.company, op.internal_ref]
                );
                matched++;
                console.log(`✅ Sugerido por ref: "${sp.sku}" <-> "${op.internal_ref}" [${op.company}]`);
            } catch (err) {
                console.error(`❌ Error insertando mapping ref (sp=${sp.id}, odoo=${op.odoo_id}):`, err.message);
                skipped++;
            }
        }
    }

    console.log(`📦 Match por referencia completado — coincidencias: ${matched}, omitidos: ${skipped}`);
    return { matched, skipped };
}

// =============================================
// Función principal: match por nombre fuzzy
// =============================================

/**
 * Match fuzzy por nombre para supplier_products sin vínculo activo ni confirmado.
 * Todo lo que supera el umbral (0.7 por defecto) queda sugerido e inactivo, aunque llegue a 0.9:
 * por nombre nunca se vincula solo.
 *
 * @param {number} supplierId
 * @param {number} [threshold=0.7]
 * @returns {Promise<{ autoLinked: number, suggested: number, noMatch: number }>}
 */
async function autoMatchByName(supplierId, threshold = 0.7) {
    console.log(`📦 Iniciando match fuzzy por nombre para proveedor ID: ${supplierId} (umbral: ${threshold})`);

    // Solo procesar productos SIN vínculo activo ni confirmado (los sugeridos se vuelven a evaluar)
    const { rows: unmapped } = await pool.query(
        `SELECT sp.id, sp.name, sp.sku
         FROM supplier_products sp
         WHERE sp.supplier_id = $1
           AND NOT EXISTS (
               SELECT 1 FROM product_mappings pm
               WHERE pm.supplier_product_id = sp.id
                 AND (pm.active = true OR pm.estado = 'confirmado')
           )`,
        [supplierId]
    );

    if (unmapped.length === 0) {
        console.log(`⚠️ No hay productos sin mapping para el proveedor ${supplierId}`);
        return { autoLinked: 0, suggested: 0, noMatch: 0 };
    }

    // Obtener todos los productos de Odoo del cache
    const { rows: odooProducts } = await pool.query(
        `SELECT id, odoo_id, company, name, internal_ref
         FROM odoo_products_cache
         WHERE active = true AND name IS NOT NULL`
    );

    if (odooProducts.length === 0) {
        console.log('⚠️ Cache de Odoo vacío — no hay candidatos para fuzzy matching');
        return { autoLinked: 0, suggested: 0, noMatch: unmapped.length };
    }

    let autoLinked = 0;
    let suggested = 0;
    let noMatch = 0;

    for (const sp of unmapped) {
        const normalizedSpName = normalize(sp.name);

        // Encontrar el mejor candidato para cada empresa por separado
        // para evitar duplicar entre neggo y preventas
        const bestByCompany = {};

        for (const op of odooProducts) {
            const normalizedOpName = normalize(op.name);
            const sim = similarity(normalizedSpName, normalizedOpName);

            if (sim < threshold) continue;

            if (!bestByCompany[op.company] || sim > bestByCompany[op.company].sim) {
                bestByCompany[op.company] = { op, sim };
            }
        }

        if (Object.keys(bestByCompany).length === 0) {
            noMatch++;
            continue;
        }

        for (const company of Object.keys(bestByCompany)) {
            const { op, sim } = bestByCompany[company];
            const confidence = Math.round(sim * 1000) / 1000;

            try {
                // Si el par ya existe (por ejemplo, rechazado) no se toca
                await pool.query(
                    `INSERT INTO product_mappings
                        (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                         match_type, match_confidence, active, estado, metodo)
                     VALUES ($1, $2, $3, $4, 'auto_fuzzy', $5, false, 'sugerido', 'auto_fuzzy')
                     ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`,
                    [sp.id, op.odoo_id, op.company, op.internal_ref, confidence]
                );

                suggested++;
                console.log(`⚠️ Sugerido (${sim.toFixed(3)}): "${sp.name}" <-> "${op.name}" [${company}]`);
            } catch (err) {
                console.error(`❌ Error insertando mapping fuzzy (sp=${sp.id}, odoo=${op.odoo_id}):`, err.message);
            }
        }
    }

    console.log(`📦 Match fuzzy completado — auto-vinculados: ${autoLinked}, sugeridos: ${suggested}, sin match: ${noMatch}`);
    return { autoLinked, suggested, noMatch };
}

// =============================================
// Orquestador: ejecutar ambos niveles
// =============================================

/**
 * Ejecuta match por referencia primero, luego fuzzy para los que no matchearon.
 *
 * @param {number} supplierId
 * @returns {Promise<object>} resumen combinado de ambos niveles
 */
async function runAutoMatch(supplierId) {
    console.log(`📦 Iniciando auto-match completo para proveedor ID: ${supplierId}`);

    const refResult = await autoMatchByRef(supplierId);
    const fuzzyResult = await autoMatchByName(supplierId);

    const summary = {
        ref: refResult,
        fuzzy: fuzzyResult,
        total: {
            matched: refResult.matched + fuzzyResult.autoLinked,
            suggested: fuzzyResult.suggested,
            noMatch: fuzzyResult.noMatch
        }
    };

    console.log(`✅ Auto-match completado para proveedor ${supplierId}:`, JSON.stringify(summary.total));
    return summary;
}

// =============================================
// Productos sin mapping
// =============================================

/**
 * Lista de supplier_products sin ningún mapping activo para un proveedor.
 *
 * @param {number} supplierId
 * @returns {Promise<Array>}
 */
async function getUnmappedProducts(supplierId) {
    const { rows } = await pool.query(
        `SELECT sp.id, sp.sku, sp.name, sp.raw_price, sp.source_category,
                sp.available, sp.last_scraped_at, sp.image_url
         FROM supplier_products sp
         WHERE sp.supplier_id = $1
           AND NOT EXISTS (
               SELECT 1 FROM product_mappings pm
               WHERE pm.supplier_product_id = sp.id AND pm.active = true
           )
         ORDER BY sp.name ASC`,
        [supplierId]
    );
    return rows;
}

module.exports = {
    autoMatchByRef,
    autoMatchByName,
    runAutoMatch,
    getUnmappedProducts
};
