// Asignar proveedor en Odoo (Preventas) a los productos matcheados que no tienen vendor.
// Corre en segundo plano con un candado: tarda minutos y nginx corta a los 120 s, así que
// si corriera dentro del request la pantalla se quedaba sin respuesta y un segundo click
// lanzaba otra corrida en paralelo que duplicaba los product.supplierinfo (nota 142).
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');

const LOTE_BUSQUEDA = 200;
const LOTE_CREACION = 100;

let job = { running: false, progreso: null, result: null, error: null, startedAt: null, finishedAt: null };

function getEstadoAsignacion() {
    return job;
}

// Productos matcheados sin vendor en el cache de Preventas, agrupados por proveedor de la app
async function buscarPendientes(db, supplierId) {
    const sidWhere = supplierId ? 'AND pss.supplier_id = $1' : '';
    const sidParam = supplierId ? [parseInt(supplierId, 10)] : [];
    const { rows } = await db.query(`
        SELECT
            pss.odoo_product_id,
            opc.template_id AS odoo_template_id,
            s.id            AS supplier_id,
            s.name          AS supplier_name
        FROM preventas_sync_state pss
        JOIN supplier_products sp  ON sp.id  = pss.supplier_product_id
        JOIN suppliers s           ON s.id   = sp.supplier_id
        JOIN odoo_products_cache opc
            ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
        WHERE pss.match_type IS NOT NULL
          AND pss.supplier_product_id IS NOT NULL
          AND (opc.vendor_name IS NULL OR opc.vendor_name = '')
          ${sidWhere}
        ORDER BY s.name, pss.odoo_product_id
    `, sidParam);

    const porProveedor = new Map();
    for (const t of rows) {
        if (!porProveedor.has(t.supplier_id)) porProveedor.set(t.supplier_id, { name: t.supplier_name, products: [] });
        porProveedor.get(t.supplier_id).products.push(t);
    }
    return { total: rows.length, porProveedor };
}

// Crea los supplierinfo de a lotes; si un lote falla, reintenta de a uno para no perder el resto
async function crearSupplierinfos(odoo, tmplIds, partnerId, companyId, ctx) {
    let creados = 0;
    let errores = 0;
    for (let i = 0; i < tmplIds.length; i += LOTE_CREACION) {
        const lote = tmplIds.slice(i, i + LOTE_CREACION);
        const vals = lote.map(id => ({ product_tmpl_id: id, partner_id: partnerId, price: 0, min_qty: 0, company_id: companyId }));
        try {
            await odoo('product.supplierinfo', 'create', [vals], { context: ctx });
            creados += lote.length;
        } catch (err) {
            console.warn(`⚠️ Falló un lote de ${lote.length} supplierinfo, reintento de a uno: ${err.message}`);
            for (const v of vals) {
                try {
                    await odoo('product.supplierinfo', 'create', [v], { context: ctx });
                    creados++;
                } catch (e) {
                    errores++;
                    console.error(`❌ Error creando supplierinfo tmpl ${v.product_tmpl_id}:`, e.message);
                }
            }
        }
    }
    return { creados, errores };
}

// Procesa un proveedor: busca el partner, completa templates, crea lo que falta y actualiza el cache
async function asignarProveedor(group, { odoo, db, preventasId, ctx }) {
    const r = { asignados: 0, omitidos: 0, errores: 0, sinPartner: false };

    // Nombre EXACTO (sin distinguir mayúsculas): con 'ilike' "ZLE" encontraba a la clienta "Yamii GonZLEz"
    const partners = await odoo('res.partner', 'search_read',
        [[['name', '=ilike', (group.name || '').trim()]]],
        { fields: ['id', 'name'], order: 'id asc', limit: 1, context: ctx }
    );
    if (!partners.length) {
        console.warn(`⚠️ Partner no encontrado en Odoo para proveedor "${group.name}"`);
        r.errores = group.products.length;
        r.sinPartner = true;
        return r;
    }
    const partnerId = partners[0].id;

    // Template: preferimos el del cache; si falta, lo pedimos a Odoo
    const sinTemplate = group.products.filter(p => !p.odoo_template_id);
    if (sinTemplate.length > 0) {
        const variants = await odoo('product.product', 'search_read',
            [[['id', 'in', sinTemplate.map(p => p.odoo_product_id)]]],
            { fields: ['id', 'product_tmpl_id'], context: ctx }
        );
        const tmplById = new Map(variants.map(v => [v.id, v.product_tmpl_id?.[0]]));
        for (const p of sinTemplate) p.odoo_template_id = tmplById.get(p.odoo_product_id) || null;
    }

    const withTemplate = group.products.filter(p => p.odoo_template_id);
    r.errores += group.products.length - withTemplate.length;
    const tmplIds = [...new Set(withTemplate.map(p => p.odoo_template_id))];

    for (let i = 0; i < tmplIds.length; i += LOTE_BUSQUEDA) {
        const lote = tmplIds.slice(i, i + LOTE_BUSQUEDA);
        const existing = await odoo('product.supplierinfo', 'search_read',
            [[['product_tmpl_id', 'in', lote], ['partner_id', '=', partnerId], ['company_id', '=', preventasId]]],
            { fields: ['product_tmpl_id'], context: ctx }
        );
        const existingSet = new Set(existing.map(e => e.product_tmpl_id?.[0]));
        r.omitidos += existingSet.size;
        const { creados, errores } = await crearSupplierinfos(odoo, lote.filter(id => !existingSet.has(id)), partnerId, preventasId, ctx);
        r.asignados += creados;
        r.errores += errores;
    }

    // Marcar en el cache local los que ya quedaron con proveedor
    const productIds = withTemplate.map(p => p.odoo_product_id);
    if (productIds.length > 0) {
        await db.query(
            `UPDATE odoo_products_cache SET vendor_name = $1 WHERE odoo_id = ANY($2::int[]) AND company = 'preventas'`,
            [group.name, productIds]
        );
    }
    return r;
}

// Recorre todos los proveedores. deps se inyecta en los tests.
async function asignarProveedores({ supplierId } = {}, deps = {}) {
    const odoo = deps.callOdoo || callOdoo;
    const db = deps.pool || pool;
    const onProgreso = deps.onProgreso || (() => {});

    const companyIds = await (deps.getCompanyIds || getCompanyIds)();
    const preventasId = companyIds.preventas;
    if (!preventasId) throw new Error('No se encontró empresa Preventas en Odoo');
    const ctx = { allowed_company_ids: [preventasId] };

    const { total, porProveedor } = await buscarPendientes(db, supplierId);
    const stats = { asignados: 0, omitidos: 0, errores: 0, total, sin_partner: [] };
    let hechos = 0;

    for (const [, group] of porProveedor) {
        onProgreso({ proveedor: group.name, hechos, total });
        const r = await asignarProveedor(group, { odoo, db, preventasId, ctx });
        stats.asignados += r.asignados;
        stats.omitidos += r.omitidos;
        stats.errores += r.errores;
        hechos += group.products.length;
        if (r.sinPartner) { stats.sin_partner.push(group.name); continue; }
        console.log(`✅ ${group.name}: ${r.asignados} asignados, ${r.omitidos} ya tenían, ${r.errores} errores`);
    }
    onProgreso({ proveedor: null, hechos, total });
    return stats;
}

// Lanza la asignación en segundo plano. Devuelve false si ya hay una corriendo.
function iniciarAsignacion({ supplierId } = {}) {
    if (job.running) return false;
    const startedAt = new Date();
    job = { running: true, progreso: { proveedor: null, hechos: 0, total: 0 }, result: null, error: null, startedAt, finishedAt: null };
    asignarProveedores({ supplierId }, { onProgreso: p => { job.progreso = p; } })
        .then(result => {
            job = { running: false, progreso: null, result, error: null, startedAt, finishedAt: new Date() };
            console.log(`✅ Asignar proveedor terminado: ${result.asignados} asignados, ${result.omitidos} ya tenían, ${result.errores} errores`);
        })
        .catch(err => {
            job = { running: false, progreso: null, result: null, error: err.message, startedAt, finishedAt: new Date() };
            console.error('❌ Asignar proveedor:', err.message);
        });
    return true;
}

module.exports = { asignarProveedores, iniciarAsignacion, getEstadoAsignacion };
