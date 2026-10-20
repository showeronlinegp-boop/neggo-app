// Agrupa cotizaciones de Preventas para la pantalla Pedidos x Proveedor.
// El proveedor sale del mapping local. vendor_name de Odoo es el respaldo.
// Lo que no resuelve queda en un grupo visible para no perder la línea.

const SIN_PROVEEDOR = 'Sin proveedor';

function formatEntero(amount) {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '0';
    const sign = n < 0 ? '-' : '';
    return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Entero con punto de miles. No usa Intl: node:20-alpine no trae el locale es-AR.
function formatMoneyAR(amount) {
    if (amount == null || amount === '') return '—';
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return `${sign}$${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function formatFechaAR(date) {
    const dt = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(dt.getTime())) return '';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${dt.getFullYear()}`;
}

/**
 * Precio para pedirle al proveedor: oferta si hay, si no la lista menos el descuento.
 * No usa el costo interno de Odoo.
 * @returns {number|null}
 */
function supplierNetCost({ raw_price, offer_price, default_discount } = {}) {
    const offer = Number(offer_price);
    if (Number.isFinite(offer) && offer > 0) return Math.round(offer * 100) / 100;
    const raw = Number(raw_price);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const discount = Number(default_discount) || 0;
    const net = discount > 0 ? raw * (1 - discount / 100) : raw;
    return Math.round(net * 100) / 100;
}

function supplierNameFor(productId, localSupplierByProductId, cacheByProductId) {
    const local = localSupplierByProductId[productId];
    if (local) return local;
    const vendor = cacheByProductId[productId]?.vendor_name;
    if (vendor) return vendor;
    return SIN_PROVEEDOR;
}

/**
 * @param {Array} quotations  cotizaciones ya normalizadas (líneas con product_id)
 * @param {object} cacheByProductId  odoo_id → { vendor_name, image_url, standard_price }
 * @param {object} localSupplierByProductId  odoo_id → nombre del proveedor local
 */
function groupQuotationsBySupplier(quotations, cacheByProductId = {}, localSupplierByProductId = {}) {
    const bySupplier = {};

    for (const quotation of quotations) {
        for (const line of quotation.lines || []) {
            if (!line.product_id) continue;

            const cache = cacheByProductId[line.product_id] || null;
            const name = supplierNameFor(line.product_id, localSupplierByProductId, cacheByProductId);

            if (!bySupplier[name]) {
                bySupplier[name] = { supplier_name: name, products: {} };
            }

            const productKey = String(line.product_id);
            if (!bySupplier[name].products[productKey]) {
                bySupplier[name].products[productKey] = {
                    product_id:   line.product_id,
                    product_name: line.product_name,
                    external_id:  line.external_id,
                    image_url:    cache?.image_url || null,
                    unit_cost:    cache?.order_cost ?? cache?.standard_price ?? null,
                    total_qty:    0,
                    quotations:   [],
                };
            }

            const qty = Number(line.quantity) || 0;
            bySupplier[name].products[productKey].total_qty += qty;
            bySupplier[name].products[productKey].quotations.push({
                quotation_id:   quotation.id,
                quotation_name: quotation.name,
                client:         quotation.client,
                date:           quotation.date,
                qty,
                unit_price:     line.unit_price,
            });
        }
    }

    return Object.values(bySupplier).map(s => {
        const products = Object.values(s.products).sort((a, b) =>
            (a.product_name || '').localeCompare(b.product_name || '', 'es')
        );
        const totalCostRaw = products.reduce((sum, p) => {
            return p.unit_cost != null ? sum + (parseFloat(p.unit_cost) * p.total_qty) : sum;
        }, 0);
        const hasCost = products.some(p => p.unit_cost != null);
        return {
            supplier_name:  s.supplier_name,
            products,
            total_products: products.length,
            total_qty:      products.reduce((sum, p) => sum + p.total_qty, 0),
            total_cost:     hasCost ? Math.round(totalCostRaw * 100) / 100 : null,
        };
    }).sort((a, b) => {
        if (a.supplier_name === SIN_PROVEEDOR) return 1;
        if (b.supplier_name === SIN_PROVEEDOR) return -1;
        return a.supplier_name.localeCompare(b.supplier_name, 'es');
    });
}

module.exports = {
    SIN_PROVEEDOR,
    formatEntero,
    formatMoneyAR,
    formatFechaAR,
    groupQuotationsBySupplier,
    supplierNetCost,
};
