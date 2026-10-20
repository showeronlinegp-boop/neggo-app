// Órdenes de venta como tareas de reposición (empresa Neggo).
// Lee de Odoo las ventas confirmadas (sale.order) y los tickets de POS (pos.order)
// de los últimos días. Por cada producto se decide reponer o archivar con las
// acciones de la cola (reposicionService); terminar la orden la pasa a «Revisadas».
// Solo productos físicos (type consu): las señas, saldos, descuentos y envíos
// son servicios y ya están en la venta original, así que no se muestran.

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');

const DIAS_DEFAULT = 7;
const LOTE_ORDENES = 200;
const CACHE_MS = 60 * 1000;
const ORIGENES = new Set(['venta', 'pos']);
const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;

// Cache corto de la lectura de Odoo: cambiar de pestaña no vuelve a pegarle
let cacheOdoo = { at: 0, dias: null, data: null };

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function diasValidos(dias) {
    const n = parseInt(dias, 10);
    return Number.isInteger(n) && n > 0 && n <= 31 ? n : DIAS_DEFAULT;
}

/** Fecha en formato de Odoo (UTC, 'YYYY-MM-DD HH:MM:SS') de hace `dias` días. */
function fechaDesdeOdoo(dias, ahora = new Date()) {
    const d = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

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

function claveOrden(origen, id) {
    return `${origen}|${id}`;
}

/**
 * Arma las órdenes con sus productos. Suma el mismo producto repetido en una orden
 * y descarta las órdenes que no tienen ningún producto (cobros, señas, saldos).
 * @param {Array} orders — sale.order o pos.order de Odoo
 * @param {Array} lines — líneas ya filtradas a productos físicos
 * @param {'venta'|'pos'} origen
 */
function armarOrdenes(orders, lines, origen) {
    const qtyField = origen === 'pos' ? 'qty' : 'product_uom_qty';
    const porOrden = new Map();
    for (const l of lines) {
        const orderId = m2oId(l.order_id);
        const productId = m2oId(l.product_id);
        const qty = Number(l[qtyField]) || 0;
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
        resultado.push({
            key: claveOrden(origen, o.id),
            origen,
            odoo_order_id: o.id,
            name: origen === 'pos' ? (o.pos_reference || o.name) : o.name,
            partner_name: m2oName(o.partner_id),
            vendedor: m2oName(o.user_id),
            date_order: isoDeOdoo(o.date_order),
            amount_total: Number(o.amount_total) || 0,
            productos: [...productos.values()],
        });
    }
    return resultado;
}

/**
 * Separa pendientes y revisadas. Más nuevas primero.
 * @param {Array} ordenes
 * @param {Map<string, object>} revisadas — key → fila de reposicion_ordenes
 */
function separarRevisadas(ordenes, revisadas) {
    const pendientes = [];
    const hechas = [];
    for (const o of ordenes) {
        const r = revisadas.get(o.key);
        if (r) hechas.push({ ...o, revisada_at: r.revisada_at, revisada_by_name: r.revisada_by_name });
        else pendientes.push(o);
    }
    const porFecha = (a, b) => String(b.date_order || '').localeCompare(String(a.date_order || ''));
    pendientes.sort(porFecha);
    hechas.sort((a, b) => String(b.revisada_at || '').localeCompare(String(a.revisada_at || '')) || porFecha(a, b));
    return { pendientes, revisadas: hechas };
}

async function leerLineas(model, orderIds, domainExtra, fields, context) {
    const todas = [];
    for (let i = 0; i < orderIds.length; i += LOTE_ORDENES) {
        const lote = orderIds.slice(i, i + LOTE_ORDENES);
        const rows = await callOdoo(
            model,
            'search_read',
            [[['order_id', 'in', lote], ['product_id.type', '=', 'consu'], ...domainExtra]],
            { fields, limit: 20000, context }
        );
        if (rows && rows.length) todas.push(...rows);
    }
    return todas;
}

async function leerVentas(companyId, desde, context) {
    const orders = await callOdoo(
        'sale.order',
        'search_read',
        [[
            ['company_id', '=', companyId],
            ['state', 'in', ['sale', 'done']],
            ['date_order', '>=', desde],
        ]],
        { fields: ['id', 'name', 'partner_id', 'user_id', 'date_order', 'amount_total'], order: 'date_order desc', limit: 1000, context }
    ) || [];
    if (!orders.length) return [];
    const lines = await leerLineas(
        'sale.order.line',
        orders.map(o => o.id),
        [['display_type', '=', false]],
        ['order_id', 'product_id', 'product_uom_qty', 'price_unit'],
        context
    );
    return armarOrdenes(orders, lines, 'venta');
}

async function leerPos(companyId, desde, context) {
    let orders;
    try {
        orders = await callOdoo(
            'pos.order',
            'search_read',
            [[
                ['company_id', '=', companyId],
                ['state', 'not in', ['draft', 'cancel']],
                ['date_order', '>=', desde],
            ]],
            { fields: ['id', 'name', 'pos_reference', 'partner_id', 'user_id', 'date_order', 'amount_total'], order: 'date_order desc', limit: 2000, context }
        ) || [];
    } catch (err) {
        // Base sin módulo de POS: seguimos solo con ventas
        console.warn('⚠️ Reposición/órdenes: no se pudo leer pos.order:', err.message);
        return [];
    }
    if (!orders.length) return [];
    const lines = await leerLineas(
        'pos.order.line',
        orders.map(o => o.id),
        // Lo que se cobra de una venta ya aparece en esa venta
        [['qty', '>', 0], ['sale_order_origin_id', '=', false]],
        ['order_id', 'product_id', 'qty', 'price_unit'],
        context
    );
    return armarOrdenes(orders, lines, 'pos');
}

async function leerOrdenesOdoo(dias, { refrescar = false } = {}) {
    const vigente = cacheOdoo.data && cacheOdoo.dias === dias && Date.now() - cacheOdoo.at < CACHE_MS;
    if (vigente && !refrescar) return cacheOdoo.data;

    const ids = await getCompanyIds();
    const companyId = ids.neggo;
    if (!companyId) throw new Error('No se encontró la empresa Neggo en Odoo');
    const context = { allowed_company_ids: [companyId] };
    const desde = fechaDesdeOdoo(dias);

    const [ventas, pos] = await Promise.all([
        leerVentas(companyId, desde, context),
        leerPos(companyId, desde, context),
    ]);
    const data = [...ventas, ...pos];
    cacheOdoo = { at: Date.now(), dias, data };
    console.log(`📦 Reposición/órdenes: ${ventas.length} venta(s) y ${pos.length} ticket(s) de POS con productos (${dias} días)`);
    return data;
}

/** Datos del cache de productos y estado en la cola, por odoo_id. */
async function datosProductos(odooIds) {
    if (!odooIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
                opc.list_price, opc.standard_price, opc.active,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                cola.estado AS estado_cola, cola.origen AS origen_cola
         FROM odoo_products_cache opc
         LEFT JOIN LATERAL (
             SELECT ri.estado, ri.origen FROM reposicion_items ri
             WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
               AND ri.estado IN ('pendiente', 'encargado')
             LIMIT 1
         ) cola ON TRUE
         WHERE opc.company = 'neggo' AND opc.odoo_id = ANY($1::int[])`,
        [odooIds]
    );
    return new Map(rows.map(r => [r.odoo_id, r]));
}

function completarProducto(p, info) {
    if (!info) {
        // No está en el cache de Neggo: se muestra pero no se puede accionar
        return { ...p, name: p.nombre_odoo, en_cache: false, en_cola: false, estado_cola: null };
    }
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
        origen_cola: info.origen_cola,
        en_cola: !!info.estado_cola,
        en_cache: true,
    };
}

/**
 * Órdenes de los últimos `dias` días, separadas en pendientes y revisadas.
 */
async function listar({ dias = DIAS_DEFAULT, refrescar = false } = {}) {
    const d = diasValidos(dias);
    const ordenes = await leerOrdenesOdoo(d, { refrescar });

    const odooIds = [...new Set(ordenes.flatMap(o => o.productos.map(p => p.odoo_id)))];
    const [info, revisadasRes] = await Promise.all([
        datosProductos(odooIds),
        pool.query(
            `SELECT ro.origen, ro.odoo_order_id, ro.revisada_at,
                    COALESCE(u.display_name, u.username) AS revisada_by_name
             FROM reposicion_ordenes ro
             LEFT JOIN users u ON u.id = ro.revisada_by
             WHERE ro.company = 'neggo'`
        ),
    ]);
    const revisadas = new Map(revisadasRes.rows.map(r => [claveOrden(r.origen, r.odoo_order_id), r]));

    const completas = ordenes.map(o => ({
        ...o,
        productos: o.productos.map(p => completarProducto(p, info.get(p.odoo_id))),
    }));
    return { dias: d, ...separarRevisadas(completas, revisadas) };
}

function validarOrden(origen, odooOrderId) {
    if (!ORIGENES.has(origen)) throw httpError('Origen inválido: usá venta o pos', 400);
    const id = parseInt(odooOrderId, 10);
    if (!Number.isInteger(id) || id <= 0) throw httpError('odoo_order_id es requerido', 400);
    return id;
}

/** Termina la orden: sale de pendientes para todos. */
async function marcarRevisada({ origen, odooOrderId, orderName }, userId) {
    const id = validarOrden(origen, odooOrderId);
    await pool.query(
        `INSERT INTO reposicion_ordenes (company, origen, odoo_order_id, order_name, revisada_by)
         VALUES ('neggo', $1, $2, $3, $4)
         ON CONFLICT (company, origen, odoo_order_id) DO NOTHING`,
        [origen, id, orderName ? String(orderName).slice(0, 100) : null, userId]
    );
    return { origen, odoo_order_id: id, revisada: true };
}

/** Reabre una orden revisada: vuelve a pendientes. */
async function reabrir({ origen, odooOrderId }) {
    const id = validarOrden(origen, odooOrderId);
    const { rowCount } = await pool.query(
        `DELETE FROM reposicion_ordenes WHERE company = 'neggo' AND origen = $1 AND odoo_order_id = $2`,
        [origen, id]
    );
    if (!rowCount) throw httpError('Esa orden no estaba revisada', 404);
    return { origen, odoo_order_id: id, revisada: false };
}

module.exports = {
    listar,
    marcarRevisada,
    reabrir,
    // Puros, para tests
    armarOrdenes,
    separarRevisadas,
    fechaDesdeOdoo,
    diasValidos,
    isoDeOdoo,
};
