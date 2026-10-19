// Productos de Odoo publicables: foto real + precio de catálogo.
// Una lista de cliente, si se elige, solo filtra proveedores. No cambia el precio.

const { catalogSalePrice, buildCaption, COMPANIES } = require('./whatsappPrice');

const MAX_BATCH = 2000;

function assertCompany(company) {
    if (!COMPANIES.includes(company)) {
        throw new Error('La lista tiene que ser neggo o preventas');
    }
    return company;
}

function buildFilter(filters) {
    const company = assertCompany(filters.company);
    const params = [company];
    const where = [
        'opc.company = $1',
        'opc.active = true',
        'COALESCE(opc.locally_archived, false) = false',
        'opc.has_image = true',
        'opc.template_id IS NOT NULL',
        'sp.raw_price IS NOT NULL',
        'sp.raw_price > 0',
        'pm.active = true',
        's.active = true',
        'scr.id IS NOT NULL',
        'COALESCE(scr.ignored, false) = false',
    ];
    if (filters.category) {
        params.push(String(filters.category));
        where.push(`opc.categ_name = $${params.length}`);
    }
    if (filters.destCategory) {
        params.push(String(filters.destCategory));
        const col = company === 'neggo' ? 'scr.dest_category_neggo' : 'scr.dest_category_preventas';
        where.push(`${col} = $${params.length}`);
    }
    if (filters.pricelistId) {
        params.push(Number(filters.pricelistId));
        where.push(`EXISTS (
            SELECT 1 FROM client_pricelist_rules r
            WHERE r.pricelist_id = $${params.length}
              AND r.supplier_id = s.id
              AND r.active = true
        )`);
    }
    return { company, params, where };
}

const SELECT_COLUMNS = `
    opc.odoo_id,
    opc.company,
    opc.name,
    opc.categ_name,
    opc.template_id,
    opc.has_image,
    sp.raw_price,
    s.default_discount,
    s.markup_neggo,
    s.markup_preventas,
    scr.id AS rule_id,
    scr.ignored,
    scr.discount_override,
    scr.markup_neggo_override,
    scr.markup_preventas_override,
    CASE WHEN opc.company = 'neggo' THEN scr.dest_category_neggo ELSE scr.dest_category_preventas END AS dest_category
`;

async function queryRows(pool, filters) {
    const { params, where } = buildFilter(filters);
    const { rows } = await pool.query(`
        SELECT * FROM (
            SELECT DISTINCT ON (opc.odoo_id)
                ${SELECT_COLUMNS}
            FROM odoo_products_cache opc
            JOIN product_mappings pm
              ON pm.odoo_product_id = opc.odoo_id
             AND pm.odoo_company = opc.company
            JOIN supplier_products sp ON sp.id = pm.supplier_product_id
            JOIN suppliers s ON s.id = sp.supplier_id
            JOIN supplier_category_rules scr
              ON scr.supplier_id = sp.supplier_id
             AND scr.source_category = sp.source_category
             AND scr.active = true
            WHERE ${where.join('\n              AND ')}
            ORDER BY opc.odoo_id, pm.match_confidence DESC NULLS LAST, sp.id
        ) q
        ORDER BY q.name ASC
        LIMIT ${MAX_BATCH + 1}
    `, params);
    return rows;
}

function priceRows(rows, company) {
    const priced = [];
    for (const row of rows) {
        const price = catalogSalePrice(row, company);
        const caption = price ? buildCaption(row.name, price.label) : null;
        if (!price || !caption) continue;
        priced.push({
            odoo_id: row.odoo_id,
            company: row.company,
            name: caption.split('\n')[0],
            categ_name: row.categ_name,
            dest_category: row.dest_category,
            template_id: row.template_id,
            price_amount: price.amount,
            price_label: price.label,
            caption,
        });
    }
    return priced;
}

async function findPublishable(pool, filters) {
    const company = assertCompany(filters.company);
    const rows = await queryRows(pool, filters);
    if (rows.length > MAX_BATCH) {
        throw new Error(`Hay más de ${MAX_BATCH} productos. Filtá por categoría o por lista.`);
    }
    return priceRows(rows, company);
}

async function listFilters(pool, company) {
    assertCompany(company);
    const categories = await pool.query(`
        SELECT DISTINCT opc.categ_name AS name
        FROM odoo_products_cache opc
        WHERE opc.company = $1
          AND opc.active = true
          AND opc.categ_name IS NOT NULL
          AND opc.categ_name <> ''
        ORDER BY 1
    `, [company]);
    const destCol = company === 'neggo' ? 'dest_category_neggo' : 'dest_category_preventas';
    const dest = await pool.query(`
        SELECT DISTINCT ${destCol} AS name
        FROM supplier_category_rules
        WHERE active = true
          AND COALESCE(ignored, false) = false
          AND ${destCol} IS NOT NULL
          AND ${destCol} <> ''
        ORDER BY 1
    `);
    const lists = await pool.query(`
        SELECT id, name
        FROM client_pricelists
        WHERE active = true
        ORDER BY name
    `);
    return {
        categories: categories.rows.map((r) => r.name),
        dest_categories: dest.rows.map((r) => r.name),
        pricelists: lists.rows,
    };
}

module.exports = { findPublishable, listFilters, MAX_BATCH };
