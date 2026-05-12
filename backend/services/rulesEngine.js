// Motor de reglas de precios para Neggo y Preventas
// Aplica descuentos y markups según proveedor y categoría

/**
 * Calcula costo y precio de venta para una empresa específica.
 * Usa los campos de markup por empresa (markup_neggo / markup_preventas).
 * Mantiene compatibilidad con markup_override / default_markup como fallback.
 *
 * - costo:     lista × (1 - descuento/100 + 0.015)   [flete 1.5% sobre lista]
 * - neggo:     lista × 1.015 × (1 + markup_neggo/100)
 * - preventas: lista × 1.015 × (1 + markup_preventas/100)
 */
function calculatePrices(supplierProduct, supplier, categoryRule, company) {
    const rawPrice = parseFloat(supplierProduct.raw_price);

    // Descuento: override de regla > default del proveedor
    const discount = categoryRule?.discount_override != null
        ? parseFloat(categoryRule.discount_override)
        : parseFloat(supplier.default_discount ?? 0);

    // Markup por empresa: nuevos campos primero, fallback a markup_override / default_markup
    let markup;
    if (company === 'neggo') {
        markup = categoryRule?.markup_neggo_override != null
            ? parseFloat(categoryRule.markup_neggo_override)
            : categoryRule?.markup_override != null
                ? parseFloat(categoryRule.markup_override)
                : parseFloat(supplier.markup_neggo ?? supplier.default_markup ?? 0);
    } else {
        markup = categoryRule?.markup_preventas_override != null
            ? parseFloat(categoryRule.markup_preventas_override)
            : categoryRule?.markup_override != null
                ? parseFloat(categoryRule.markup_override)
                : parseFloat(supplier.markup_preventas ?? supplier.default_markup ?? 0);
    }

    const FLETE = 0.015;
    const cost      = rawPrice * (1 - discount / 100 + FLETE);
    const salePrice = rawPrice * (1 + FLETE) * (1 + markup / 100);

    return {
        raw_price: rawPrice,
        discount_pct: discount,
        markup_pct: markup,
        cost: Math.round(cost * 100) / 100,
        sale_price: Math.ceil(salePrice),
        company
    };
}

/**
 * Calcula precios para ambas empresas en un solo llamado.
 * Retorna { neggo: {...}, preventas: {...} }
 */
function calculatePricesForBoth(supplierProduct, supplier, categoryRule) {
    return {
        neggo: calculatePrices(supplierProduct, supplier, categoryRule, 'neggo'),
        preventas: calculatePrices(supplierProduct, supplier, categoryRule, 'preventas')
    };
}

/**
 * Busca la regla de categoría activa para un proveedor, categoría origen y empresa.
 * Retorna la regla con `dest_category` normalizado según la empresa solicitada,
 * o null si no existe regla.
 *
 * @param {object} pool - Pool de PostgreSQL
 * @param {number} supplierId
 * @param {string} sourceCategory - Categoría tal como vino del scraping
 * @param {string} company - 'neggo' o 'preventas'
 */
async function getCategoryRule(pool, supplierId, sourceCategory, company) {
    const result = await pool.query(`
        SELECT id, supplier_id, source_category,
               dest_category_neggo, dest_category_preventas,
               odoo_categ_id_neggo, odoo_categ_id_preventas,
               discount_override,
               markup_override, markup_neggo_override, markup_preventas_override,
               ignored, active
        FROM supplier_category_rules
        WHERE supplier_id = $1
          AND source_category = $2
          AND active = true
        LIMIT 1
    `, [supplierId, sourceCategory]);

    const rule = result.rows[0];
    if (!rule) return null;

    // Si la categoría está marcada como ignorada, tratarla como sin regla
    if (rule.ignored) return null;

    return {
        ...rule,
        // dest_category y odoo_categ_id normalizados según empresa
        dest_category: company === 'neggo'
            ? rule.dest_category_neggo
            : rule.dest_category_preventas,
        odoo_categ_id: company === 'neggo'
            ? rule.odoo_categ_id_neggo
            : rule.odoo_categ_id_preventas
    };
}

/**
 * Retorna la regla de categoría sin filtrar por empresa.
 * Útil cuando se necesita la regla completa (ambas empresas) en un solo llamado.
 */
async function getCategoryRuleFull(pool, supplierId, sourceCategory) {
    const result = await pool.query(`
        SELECT id, supplier_id, source_category,
               dest_category_neggo, dest_category_preventas,
               odoo_categ_id_neggo, odoo_categ_id_preventas,
               discount_override,
               markup_override, markup_neggo_override, markup_preventas_override,
               ignored, active
        FROM supplier_category_rules
        WHERE supplier_id = $1
          AND source_category = $2
          AND active = true
        LIMIT 1
    `, [supplierId, sourceCategory]);

    const rule = result.rows[0];
    if (!rule || rule.ignored) return null;
    return rule;
}

module.exports = { calculatePrices, calculatePricesForBoth, getCategoryRule, getCategoryRuleFull };
