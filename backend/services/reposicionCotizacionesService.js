// Cotizaciones con la etiqueta "Pendiente" como insumo de la reposición.
// Son encargues de clientes o mercadería que faltó en un pedido (las arma el control
// de Armado como "Pendientes de S0xxx" o el equipo a mano), de Neggo y de Preventas.
// Solo lectura de Odoo: cotizaciones vivas (borrador o enviada) y sus productos físicos.
// Cada producto se cruza con el cache de la empresa de la cotización y, para Neggo,
// con el estado en la cola de reposición.

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { ETIQUETA_PENDIENTES } = require('./pedidoEnvioService');

const ESTADOS_VIVOS = ['draft', 'sent'];
const LOTE_ORDENES = 200;
const CACHE_MS = 60 * 1000;
const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;
const EMPRESA_LABEL = { neggo: 'Neggo', preventas: 'Preventas' };

let cacheOdoo = { at: 0, data: null };

function m2oId(value) {
    return Array.isArray(value) ? value[0] : (value || null);
}

function m2oName(value) {
    return Array.isArray(value) ? value[1] : null;
}

/** Odoo devuelve date_order en UTC sin zona: lo pasamos a ISO. */
function isoDeOdoo(fecha) {
    if (!fecha) return null;
    return `${String(fecha).replace(' ', 'T')}Z`;
}

function claveProducto(company, odooId) {
    return `${company}|${odooId}`;
}

/**
 * Arma las cotizaciones con sus productos. Suma el mismo producto repetido y descarta
 * las cotizaciones sin productos físicos. Más nuevas primero.
 * @param {Array} orders — sale.order de Odoo
 * @param {Array} lines — sale.order.line ya filtradas a productos físicos
 * @param {Object<string, number>} companyIds — { neggo: id, preventas: id }
 */
function armarCotizaciones(orders, lines, companyIds) {
    const companyPorId = new Map(Object.entries(companyIds).map(([k, id]) => [id, k]));
    const porOrden = new Map();
    for (const l of lines) {
        const orderId = m2oId(l.order_id);
        const productId = m2oId(l.product_id);
        const qty = Number(l.product_uom_qty) || 0;
        if (!orderId || !productId || qty <= 0) continue;
        if (!porOrden.has(orderId)) porOrden.set(orderId, new Map());
        const productos = porOrden.get(orderId);
        const prev = productos.get(productId) || {
            odoo_id: productId,
            nombre_odoo: m2oName(l.product_id),
            qty: 0,
            price_unit: Number(l.price_unit) || 0,
        };
        prev.qty += qty;
        productos.set(productId, prev);
    }

    const resultado = [];
    for (const o of orders) {
        const productos = porOrden.get(o.id);
        if (!productos || productos.size === 0) continue;
        const company = companyPorId.get(m2oId(o.company_id)) || 'neggo';
        resultado.push({
            odoo_order_id: o.id,
            name: o.name,
            estado: o.state === 'sent' ? 'enviada' : 'borrador',
            company,
            empresa: EMPRESA_LABEL[company] || company,
            partner_name: m2oName(o.partner_id),
            vendedor: m2oName(o.user_id),
            origen: o.origin || null,
            date_order: isoDeOdoo(o.date_order),
            amount_total: Number(o.amount_total) || 0,
            productos: [...productos.values()],
        });
    }
    resultado.sort((a, b) => String(b.date_order || '').localeCompare(String(a.date_order || '')));
    return resultado;
}

/**
 * Total pendiente por producto sumando todas las cotizaciones (lo que hay que conseguir).
 * Ordena por proveedor y después por cantidad.
 */
function resumirPorProducto(cotizaciones) {
    const porProducto = new Map();
    for (const c of cotizaciones) {
        for (const p of c.productos) {
            const key = claveProducto(c.company, p.odoo_id);
            const prev = porProducto.get(key) || {
                odoo_id: p.odoo_id,
                company: c.company,
                empresa: c.empresa,
                name: p.name || p.nombre_odoo,
                internal_ref: p.internal_ref || null,
                vendor_name: p.vendor_name || 'Sin proveedor',
                estado_cola: p.estado_cola || null,
                qty_total: 0,
                cotizaciones: [],
            };
            prev.qty_total += p.qty;
            prev.cotizaciones.push({ name: c.name, partner_name: c.partner_name, qty: p.qty });
            porProducto.set(key, prev);
        }
    }
    return [...porProducto.values()].sort((a, b) =>
        a.vendor_name.localeCompare(b.vendor_name, 'es') || (b.qty_total - a.qty_total)
    );
}

async function leerOdoo({ refrescar = false } = {}) {
    if (!refrescar && cacheOdoo.data && Date.now() - cacheOdoo.at < CACHE_MS) return cacheOdoo.data;

    const ids = await getCompanyIds();
    const companyIds = Object.fromEntries(Object.entries(ids).filter(([, id]) => id));
    const permitidas = Object.values(companyIds);
    if (!permitidas.length) throw new Error('No se encontraron las empresas en Odoo');
    const context = { allowed_company_ids: permitidas };

    const orders = await callOdoo(
        'sale.order',
        'search_read',
        [[
            ['tag_ids.name', '=ilike', ETIQUETA_PENDIENTES],
            ['state', 'in', ESTADOS_VIVOS],
            ['company_id', 'in', permitidas],
        ]],
        { fields: ['id', 'name', 'state', 'company_id', 'partner_id', 'user_id', 'date_order', 'origin', 'amount_total'], order: 'date_order desc', limit: 1000, context }
    ) || [];

    const lines = [];
    const orderIds = orders.map(o => o.id);
    for (let i = 0; i < orderIds.length; i += LOTE_ORDENES) {
        const rows = await callOdoo(
            'sale.order.line',
            'search_read',
            [[
                ['order_id', 'in', orderIds.slice(i, i + LOTE_ORDENES)],
                ['product_id.type', '=', 'consu'],
                ['display_type', '=', false],
            ]],
            { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit'], limit: 20000, context }
        );
        if (rows && rows.length) lines.push(...rows);
    }

    const data = armarCotizaciones(orders, lines, companyIds);
    cacheOdoo = { at: Date.now(), data };
    console.log(`📦 Reposición/cotizaciones: ${data.length} cotización(es) con etiqueta "${ETIQUETA_PENDIENTES}"`);
    return data;
}

/** Datos del cache por empresa + odoo_id; el estado en la cola es solo de Neggo. */
async function datosProductos(odooIds) {
    if (!odooIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT opc.company, opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
                opc.list_price, opc.standard_price, opc.active,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                cola.estado AS estado_cola
         FROM odoo_products_cache opc
         LEFT JOIN LATERAL (
             SELECT ri.estado FROM reposicion_items ri
             WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo' AND opc.company = 'neggo'
               AND ri.estado IN ('pendiente', 'encargado')
             LIMIT 1
         ) cola ON TRUE
         WHERE opc.odoo_id = ANY($1::int[])`,
        [odooIds]
    );
    return new Map(rows.map(r => [claveProducto(r.company, r.odoo_id), r]));
}

function completarProducto(p, info) {
    if (!info) return { ...p, name: p.nombre_odoo, vendor_name: 'Sin proveedor', en_cache: false, estado_cola: null };
    return {
        ...p,
        name: info.name || p.nombre_odoo,
        internal_ref: info.internal_ref,
        barcode: info.barcode,
        image_url: info.image_url,
        list_price: info.list_price,
        standard_price: info.standard_price,
        active: info.active,
        vendor_name: info.vendor_name,
        es_liquidar: info.es_liquidar,
        estado_cola: info.estado_cola,
        en_cache: true,
    };
}

/**
 * Cotizaciones vivas con la etiqueta "Pendiente" de Neggo y Preventas, con sus productos
 * y el total por producto. proveedor (opcional) filtra los productos de ese proveedor.
 */
async function listar({ refrescar = false, proveedor = null } = {}) {
    const cotizaciones = await leerOdoo({ refrescar });
    const odooIds = [...new Set(cotizaciones.flatMap(c => c.productos.map(p => p.odoo_id)))];
    const info = await datosProductos(odooIds);

    const filtro = proveedor ? String(proveedor).trim().toLowerCase() : null;
    const completas = cotizaciones
        .map(c => ({
            ...c,
            productos: c.productos
                .map(p => completarProducto(p, info.get(claveProducto(c.company, p.odoo_id))))
                .filter(p => !filtro || p.vendor_name.toLowerCase() === filtro),
        }))
        .filter(c => c.productos.length > 0);

    return {
        etiqueta: ETIQUETA_PENDIENTES,
        cotizaciones: completas,
        productos: resumirPorProducto(completas),
    };
}

module.exports = {
    listar,
    // Puros, para tests
    armarCotizaciones,
    resumirPorProducto,
};
