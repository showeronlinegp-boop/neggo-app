// Sorteo de fotos para WhatsApp: productos de Odoo con foto y precio de venta de Odoo
// (el mismo precio del catálogo PDF). No depende de los mapeos con proveedores.

const { formatMoneyAR, buildCaption, COMPANIES } = require('./whatsappPrice');
const { productLink, withLink } = require('./whatsappMessage');

const MAX_PICK = 50;
// Días en que un producto ya publicado no vuelve a salir en un sorteo.
const RECENT_DAYS = 7;

function assertCompany(company) {
    if (!COMPANIES.includes(company)) {
        throw new Error('La lista tiene que ser neggo o preventas');
    }
    return company;
}

const BASE_WHERE = `
    opc.company = $1
    AND opc.active = true
    AND COALESCE(opc.locally_archived, false) = false
    AND opc.has_image = true
    AND opc.template_id IS NOT NULL
    AND opc.list_price > 0
`;

// Ni lo que ya está en cola ni lo publicado en los últimos $2 días.
const NOT_RECENT = `
    NOT EXISTS (
        SELECT 1 FROM whatsapp_messages wm
        JOIN whatsapp_batches wb ON wb.id = wm.batch_id
        WHERE wm.odoo_id = opc.odoo_id
          AND wm.company = opc.company
          AND (
              (wm.status IN ('pendiente', 'enviando') AND wb.status IN ('programada', 'en_curso', 'pausada'))
              OR (wm.status = 'enviado' AND wm.sent_at > NOW() - ($2::int * INTERVAL '1 day'))
          )
    )
`;

// Ni lo descargado como imagen de estado en los últimos $2 días (tabla de sql/estados_imagenes.sql).
const NOT_DOWNLOADED = `
    NOT EXISTS (
        SELECT 1 FROM estado_imagenes_descargas eid
        WHERE eid.odoo_id = opc.odoo_id
          AND eid.company = opc.company
          AND eid.created_at > NOW() - ($2::int * INTERVAL '1 day')
    )
`;

function toProduct(row) {
    const amount = Math.ceil(Number(row.list_price) - 1e-9);
    const label = formatMoneyAR(amount);
    const caption = label ? buildCaption(row.name, label) : null;
    if (!caption) return null;
    return {
        odoo_id: row.odoo_id,
        company: row.company,
        name: caption.split('\n')[0],
        categ_name: row.categ_name,
        template_id: row.template_id,
        price_amount: amount,
        price_label: label,
        caption,
    };
}

// Odoo de solo lectura: website_url de cada plantilla (/shop/<slug>-<id>).
async function odooWebsiteUrls(company, templateIds) {
    const { callOdoo, getCompanyIds } = require('../config/odoo');
    const ids = await getCompanyIds();
    const companyId = ids[company];
    if (!companyId) throw new Error(`No encuentro la empresa ${company} en Odoo`);
    const rows = await callOdoo('product.template', 'read', [templateIds], {
        fields: ['website_url'],
        context: { allowed_company_ids: [companyId] },
    });
    return new Map((rows || []).map((r) => [r.id, r.website_url || null]));
}

// Agrega el link de la web al texto. Si Odoo no responde se corta: no sale nada sin link.
async function attachLinks(products, company, loadUrls = odooWebsiteUrls) {
    if (!products.length) return products;
    const templateIds = [...new Set(products.map((p) => p.template_id))];
    let urls;
    try {
        urls = await loadUrls(company, templateIds);
    } catch (err) {
        throw new Error(`No pude leer los links de Odoo: ${err.message}`);
    }
    return products.map((p) => {
        const url = productLink(urls.get(p.template_id));
        return { ...p, url, caption: withLink(p.caption, url) };
    });
}

async function listCategories(pool, company) {
    assertCompany(company);
    const { rows } = await pool.query(`
        SELECT opc.categ_name AS name, COUNT(*)::int AS count
        FROM odoo_products_cache opc
        WHERE ${BASE_WHERE}
          AND NULLIF(TRIM(opc.categ_name), '') IS NOT NULL
        GROUP BY opc.categ_name
        ORDER BY opc.categ_name
    `, [company]);
    return rows;
}

async function pickRandom(pool, { company, category, count = 20, excludeIds = [], excludeDownloaded = false }) {
    assertCompany(company);
    if (!category) throw new Error('Elegí al menos una categoría');
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PICK) {
        throw new Error(`La cantidad tiene que estar entre 1 y ${MAX_PICK}`);
    }
    const exclude = (excludeIds || []).map(Number).filter(Number.isInteger);
    const { rows } = await pool.query(`
        SELECT opc.odoo_id, opc.company, opc.name, opc.categ_name, opc.template_id, opc.list_price
        FROM odoo_products_cache opc
        WHERE ${BASE_WHERE}
          AND opc.categ_name = $3
          AND NOT (opc.odoo_id = ANY($4::int[]))
          AND ${NOT_RECENT}
          ${excludeDownloaded ? `AND ${NOT_DOWNLOADED}` : ''}
        ORDER BY random()
        LIMIT $5
    `, [company, RECENT_DAYS, String(category), exclude, n]);
    return attachLinks(rows.map(toProduct).filter(Boolean), company);
}

// Revalida lo elegido en pantalla: precio y foto se leen acá, no se confía en el cliente.
async function findByIds(pool, company, odooIds) {
    assertCompany(company);
    const ids = [...new Set((odooIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return [];
    if (ids.length > 1000) throw new Error('Demasiados productos en una tanda');
    const { rows } = await pool.query(`
        SELECT opc.odoo_id, opc.company, opc.name, opc.categ_name, opc.template_id, opc.list_price
        FROM odoo_products_cache opc
        WHERE ${BASE_WHERE}
          AND opc.odoo_id = ANY($2::int[])
    `, [company, ids]);
    const byId = new Map(rows.map(toProduct).filter(Boolean).map((p) => [p.odoo_id, p]));
    const found = ids.map((id) => byId.get(id)).filter(Boolean);
    return attachLinks(found, company);
}

module.exports = { listCategories, pickRandom, findByIds, attachLinks, toProduct, MAX_PICK, RECENT_DAYS };
