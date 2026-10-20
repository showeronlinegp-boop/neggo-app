// Fotos de productos en Odoo Neggo (lo usan Ingreso y Reposición)

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');

/**
 * Sube la foto a un producto de Odoo Neggo (image_1920: Odoo arma las miniaturas)
 * y actualiza el cache local, así WhatsApp y el catálogo la ven sin esperar el sync.
 */
async function writeOdooImage(odooProductId, base64) {
    const companyIds = await getCompanyIds();
    const companyId  = companyIds.neggo;
    if (!companyId) {
        const err = new Error('Company Neggo no encontrada');
        err.statusCode = 503;
        throw err;
    }
    const ctx = { context: { allowed_company_ids: [companyId] } };

    await callOdoo('product.product', 'write', [[odooProductId], { image_1920: base64 }], ctx);
    const [product] = await callOdoo('product.product', 'read', [[odooProductId], ['product_tmpl_id']], ctx);
    const templateId = product?.product_tmpl_id?.[0] || null;

    const { rows } = await pool.query(
        `UPDATE odoo_products_cache
         SET has_image   = true,
             template_id = COALESCE($2, template_id),
             image_url   = CASE WHEN COALESCE($2, template_id) IS NOT NULL
                                THEN '/api/products/odoo-image/neggo/' || COALESCE($2, template_id)
                                ELSE image_url END
         WHERE odoo_id = $1 AND company = 'neggo'
         RETURNING image_url`,
        [odooProductId, templateId]
    );
    return { template_id: templateId, image_url: rows[0]?.image_url || null };
}

module.exports = { writeOdooImage };
