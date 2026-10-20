// Precio publicado en WhatsApp: la misma regla del catálogo (rulesEngine).
// No usa list_price de Odoo ni el descuento de una lista de cliente.

const { calculatePrices } = require('./rulesEngine');

const COMPANIES = ['neggo', 'preventas'];

/**
 * Entero con separador de miles es-AR (punto), sin depender de ICU.
 * $1523 → "$1.523". El catálogo ya redondea hacia arriba.
 */
function formatMoneyAR(amount) {
    if (amount == null || amount === '') return null;
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    const v = Math.ceil(n - 1e-9);
    const sign = v < 0 ? '-' : '';
    const body = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}$${body}`;
}

function catalogSalePrice(row, company) {
    if (!COMPANIES.includes(company)) return null;
    if (!row || row.ignored) return null;
    if (!row.rule_id) return null;
    if (!row.has_image || !row.template_id) return null;
    const raw = Number(row.raw_price);
    if (!Number.isFinite(raw) || raw <= 0) return null;

    const supplier = {
        default_discount: row.default_discount,
        default_markup: row.default_markup,
        markup_neggo: row.markup_neggo,
        markup_preventas: row.markup_preventas,
    };
    const rule = {
        discount_override: row.discount_override,
        markup_override: row.markup_override,
        markup_neggo_override: row.markup_neggo_override,
        markup_preventas_override: row.markup_preventas_override,
    };
    const sale = calculatePrices({ raw_price: raw }, supplier, rule, company).sale_price;
    if (!Number.isFinite(sale) || sale <= 0) return null;
    const label = formatMoneyAR(sale);
    if (!label) return null;
    return { amount: sale, label };
}

function buildCaption(name, priceLabel) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean || !priceLabel) return null;
    return `${clean.slice(0, 500)}\n${priceLabel}`;
}

module.exports = { formatMoneyAR, catalogSalePrice, buildCaption, COMPANIES };
