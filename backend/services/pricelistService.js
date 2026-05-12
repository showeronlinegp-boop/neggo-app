// Servicio de listas de precios especiales para clientes
// Fórmula: precio = raw_price × (1 - descuento_lista / 100)

const pool = require('../config/database');

/**
 * Resuelve el % de descuento de lista a aplicar para un supplier dado.
 * Cascada: regla específica (pricelist+supplier) → default_descuento de la lista.
 *
 * @param {number} pricelistId
 * @param {number} supplierId
 * @returns {Promise<number>} descuento en % (ej: 5 → 5%)
 */
async function resolveDescuento(pricelistId, supplierId) {
    // Buscar regla específica por proveedor
    if (supplierId) {
        const { rows } = await pool.query(
            `SELECT descuento_pct FROM client_pricelist_rules
             WHERE pricelist_id = $1 AND supplier_id = $2 AND active = true
             LIMIT 1`,
            [pricelistId, supplierId]
        );
        if (rows.length > 0) return parseFloat(rows[0].descuento_pct);
    }

    // Fallback: default_descuento de la lista
    const { rows } = await pool.query(
        'SELECT default_descuento FROM client_pricelists WHERE id = $1',
        [pricelistId]
    );
    return rows.length > 0 ? parseFloat(rows[0].default_descuento) : 0;
}

/**
 * Calcula el precio especial.
 * precio = rawPrice × (1 - descuentoPct / 100)
 *
 * @param {number} rawPrice — precio de lista del proveedor
 * @param {number} descuentoPct — % descuento (ej: 5 para 5%)
 * @returns {number} precio calculado, redondeado a 2 decimales
 */
function calculateSpecialPrice(rawPrice, descuentoPct) {
    if (!rawPrice || !Number.isFinite(rawPrice)) return null;
    const price = rawPrice * (1 - descuentoPct / 100);
    return Math.round(price * 100) / 100;
}

/**
 * Carga todos los datos de una lista con sus reglas (incluye nombre del proveedor).
 */
async function getPricelistWithRules(pricelistId) {
    const { rows: lists } = await pool.query(
        'SELECT * FROM client_pricelists WHERE id = $1',
        [pricelistId]
    );
    if (!lists.length) return null;

    const { rows: rules } = await pool.query(
        `SELECT r.*, s.name AS supplier_name
         FROM client_pricelist_rules r
         JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.pricelist_id = $1 AND r.active = true
         ORDER BY s.name`,
        [pricelistId]
    );

    return { ...lists[0], rules };
}

module.exports = { resolveDescuento, calculateSpecialPrice, getPricelistWithRules };
