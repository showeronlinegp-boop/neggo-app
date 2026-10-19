// Eliminación de proveedores con reasignación en Odoo Neggo
// Antes de borrar el proveedor de la app, los productos de Neggo en Odoo que lo tienen
// como proveedor (product.supplierinfo) pasan al proveedor de reemplazo elegido.
// Solo toca la empresa Neggo: si el proveedor se usa en Preventas/Precompras no se puede eliminar.
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');

const BATCH = 200;

// Error de negocio con status HTTP para que la ruta lo devuelva tal cual
function businessError(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

/**
 * Busca el contacto de Odoo con el mismo nombre que el proveedor (sin distinguir mayúsculas).
 * Retorna { id, name } o null.
 */
async function findOdooPartner(name) {
    const partners = await callOdoo('res.partner', 'search_read',
        [[['name', '=ilike', name]]],
        { fields: ['id', 'name'], limit: 1, context: { active_test: false } }
    );
    return partners[0] || null;
}

async function countSupplierinfo(partnerId, companyId) {
    if (!partnerId || !companyId) return 0;
    return callOdoo('product.supplierinfo', 'search_count',
        [[['partner_id', '=', partnerId], ['company_id', '=', companyId]]],
        { context: { allowed_company_ids: [companyId] } }
    );
}

/**
 * Junta todo lo que hace falta saber antes de eliminar un proveedor.
 * blocked_reasons vacío = se puede eliminar.
 */
async function getDeletePreview(supplierId) {
    const { rows: [supplier] } = await pool.query(
        'SELECT id, name, prefix FROM suppliers WHERE id = $1',
        [supplierId]
    );
    if (!supplier) throw businessError('Proveedor no encontrado', 404);

    const { rows: [local] } = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM supplier_products        WHERE supplier_id = $1)::int AS scraped_products,
            (SELECT COUNT(*) FROM preventas_sync_state     WHERE supplier_id = $1)::int AS preventas_sync,
            (SELECT COUNT(*) FROM client_pricelist_rules   WHERE supplier_id = $1)::int AS pricelist_rules,
            (SELECT COUNT(*) FROM preventa_supplier_orders WHERE supplier_id = $1)::int AS preventas_orders,
            (SELECT COUNT(*) FROM scraping_runs WHERE supplier_id = $1 AND status = 'running')::int AS running_runs
    `, [supplierId]);

    const companyIds = await getCompanyIds();
    const partner = await findOdooPartner(supplier.name);
    const odooNeggo     = partner ? await countSupplierinfo(partner.id, companyIds.neggo) : 0;
    const odooPreventas = partner ? await countSupplierinfo(partner.id, companyIds.preventas) : 0;

    const blocked = [];
    if (local.preventas_sync > 0 || odooPreventas > 0) {
        blocked.push(`Se usa en Precompras (${odooPreventas} productos en Odoo, ${local.preventas_sync} sincronizados)`);
    }
    if (local.pricelist_rules > 0) blocked.push(`Tiene ${local.pricelist_rules} reglas de listas de precios de Preventas`);
    if (local.preventas_orders > 0) blocked.push(`Tiene ${local.preventas_orders} pedidos de Preventas`);
    if (local.running_runs > 0) blocked.push('Tiene un scraping corriendo');

    return {
        supplier,
        odoo_partner: partner,
        odoo_neggo_products: odooNeggo,
        odoo_preventas_products: odooPreventas,
        scraped_products: local.scraped_products,
        blocked_reasons: blocked,
    };
}

/**
 * En Odoo Neggo pasa los supplierinfo del contacto viejo al nuevo.
 * Si el producto ya tenía al nuevo como proveedor, se borra la línea vieja para no duplicar.
 * Retorna { reassigned, removed_duplicates }.
 */
async function reassignNeggoSupplierinfo(oldPartnerId, newPartnerId, companyId) {
    const ctx = { context: { allowed_company_ids: [companyId] } };

    const oldInfos = await callOdoo('product.supplierinfo', 'search_read',
        [[['partner_id', '=', oldPartnerId], ['company_id', '=', companyId]]],
        { fields: ['id', 'product_tmpl_id'], ...ctx }
    );
    if (oldInfos.length === 0) return { reassigned: 0, removed_duplicates: 0 };

    // Templates que ya tienen al proveedor nuevo
    const templateIds = [...new Set(oldInfos.map(i => i.product_tmpl_id?.[0]).filter(Boolean))];
    const yaTienenNuevo = new Set();
    for (let i = 0; i < templateIds.length; i += BATCH) {
        const existing = await callOdoo('product.supplierinfo', 'search_read',
            [[['partner_id', '=', newPartnerId], ['company_id', '=', companyId],
              ['product_tmpl_id', 'in', templateIds.slice(i, i + BATCH)]]],
            { fields: ['product_tmpl_id'], ...ctx }
        );
        existing.forEach(e => yaTienenNuevo.add(e.product_tmpl_id?.[0]));
    }

    const toUnlink = oldInfos.filter(i => yaTienenNuevo.has(i.product_tmpl_id?.[0])).map(i => i.id);
    const toWrite  = oldInfos.filter(i => !yaTienenNuevo.has(i.product_tmpl_id?.[0])).map(i => i.id);

    for (let i = 0; i < toWrite.length; i += BATCH) {
        await callOdoo('product.supplierinfo', 'write', [toWrite.slice(i, i + BATCH), { partner_id: newPartnerId }], ctx);
    }
    for (let i = 0; i < toUnlink.length; i += BATCH) {
        await callOdoo('product.supplierinfo', 'unlink', [toUnlink.slice(i, i + BATCH)], ctx);
    }

    return { reassigned: toWrite.length, removed_duplicates: toUnlink.length };
}

/**
 * Elimina el proveedor de la app reasignando antes sus productos de Odoo Neggo.
 * Es reintentable: si falla después de Odoo, la segunda vez no queda nada para reasignar.
 */
async function deleteSupplier(supplierId, replacementId) {
    const preview = await getDeletePreview(supplierId);
    if (preview.blocked_reasons.length > 0) {
        throw businessError(`No se puede eliminar: ${preview.blocked_reasons.join('; ')}`, 409);
    }

    let replacement = null;
    let odooResult = { reassigned: 0, removed_duplicates: 0 };

    if (preview.odoo_neggo_products > 0) {
        if (!replacementId) throw businessError('Elegí el proveedor de reemplazo');
        if (Number(replacementId) === Number(supplierId)) {
            throw businessError('El reemplazo tiene que ser otro proveedor');
        }

        const { rows: [rep] } = await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [replacementId]);
        if (!rep) throw businessError('Proveedor de reemplazo no encontrado', 404);

        const repPartner = await findOdooPartner(rep.name);
        if (!repPartner) throw businessError(`"${rep.name}" no existe como contacto en Odoo`, 404);

        const companyIds = await getCompanyIds();
        odooResult = await reassignNeggoSupplierinfo(preview.odoo_partner.id, repPartner.id, companyIds.neggo);
        replacement = { id: rep.id, name: rep.name };

        // El cache local guarda el primer proveedor de cada producto
        await pool.query(
            `UPDATE odoo_products_cache SET vendor_name = $1
             WHERE company = 'neggo' AND vendor_name = $2`,
            [repPartner.name, preview.odoo_partner.name]
        );

        console.log(`📦 Odoo Neggo: ${odooResult.reassigned} productos pasaron de "${preview.supplier.name}" a "${rep.name}" (${odooResult.removed_duplicates} duplicados quitados)`);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Historial que se conserva sin proveedor (sus FKs no tienen ON DELETE)
        for (const table of ['scraping_runs', 'catalogs', 'purchase_suggestions', 'preventa_supplier_orders']) {
            const column = table === 'purchase_suggestions' ? 'best_supplier_id' : 'supplier_id';
            await client.query(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = $1`, [supplierId]);
        }
        // El resto (productos scrapeados, reglas, mapeos) se borra en cascada; ingresos quedan sin proveedor
        await client.query('DELETE FROM suppliers WHERE id = $1', [supplierId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    console.log(`⚠️ Proveedor eliminado: "${preview.supplier.name}" (id: ${supplierId}) — ${preview.scraped_products} productos scrapeados borrados`);
    return {
        id: Number(supplierId),
        name: preview.supplier.name,
        replacement,
        odoo_reassigned: odooResult.reassigned,
        odoo_removed_duplicates: odooResult.removed_duplicates,
        deleted_scraped_products: preview.scraped_products,
    };
}

module.exports = { getDeletePreview, deleteSupplier };
