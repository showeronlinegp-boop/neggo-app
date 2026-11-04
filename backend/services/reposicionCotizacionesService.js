// Cotizaciones con la etiqueta "Pendiente" como insumo de la reposición.
// Son encargues de clientes o mercadería que faltó en un pedido (las arma el control
// de Armado como "Pendientes de S0xxx" o el equipo a mano), de Neggo y de Preventas.
// Solo lectura de Odoo: cotizaciones vivas (borrador o enviada) y sus productos físicos.
// Cada producto se cruza con el cache de la empresa de la cotización y, para Neggo,
// con el estado en la cola de reposición.
// Nota 149: también marca lo de Neggo que ya llegó en un ingreso después de la cotización
// (para avisarle al cliente) y manda a la cola en lote lo que falta pedir, con la cantidad
// que espera el cliente.
// Nota 150: lo de Neggo que ya está separado para el cliente se tilda (tabla propia, no va a
// Odoo) y deja de pedirse. Desde acá también se quita un producto de la cotización (borra la
// línea en Odoo) o se cancela la cotización entera (la pasa a cancelada en Odoo).

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { ETIQUETA_PENDIENTES } = require('./pedidoEnvioService');
const reposicion = require('./reposicionService');
const odooService = require('./odooService');

const MIGRACION = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '061_cotizacion_separados.sql'), 'utf8');
let schemaReady = null;

function ensureSchema() {
    if (!schemaReady) {
        schemaReady = pool.query(MIGRACION).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

function httpError(message, status) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}

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
                barcode: p.barcode || null,
                image_url: p.image_url || null,
                standard_price: p.standard_price ?? null,
                vendor_name: p.vendor_name || 'Sin proveedor',
                estado_cola: p.estado_cola || null,
                puede_reponer: false,
                qty_total: 0,
                qty_falta: 0,
                cotizaciones: [],
            };
            prev.qty_total += p.qty;
            // Lo que falta conseguir: sin separar y sin lo que ya llegó (puede ser una parte)
            if (!p.separado) prev.qty_falta += Math.max(p.qty - (p.llego ? p.qty : (p.qty_llegada || 0)), 0);
            if (p.puede_reponer) prev.puede_reponer = true;
            prev.cotizaciones.push({
                name: c.name, partner_name: c.partner_name, qty: p.qty,
                qty_llegada: p.qty_llegada || 0,
                llego: p.llego || null, separado: p.separado || null,
            });
            porProducto.set(key, prev);
        }
    }
    // Llegó solo si llegó para todas sus cotizaciones (un ingreso viejo no cubre una cotización nueva)
    for (const p of porProducto.values()) {
        p.llego = p.cotizaciones.every(c => c.llego) ? p.cotizaciones[0].llego : null;
        p.separado = p.cotizaciones.every(c => c.separado) ? p.cotizaciones[0].separado : null;
    }
    return [...porProducto.values()].sort((a, b) =>
        a.vendor_name.localeCompare(b.vendor_name, 'es') || (b.qty_total - a.qty_total)
    );
}

/**
 * Reparte lo que entró en los ingresos entre las cotizaciones, la más vieja primero. A cada una
 * solo le sirve lo que entró en o después de su fecha, y una unidad no se cuenta dos veces.
 * @param {Array<{odoo_order_id, date_order, productos: Array<{odoo_id, qty}>}>} cotizaciones
 * @param {Map<number, Array<{ingreso_id, comprobante, at, qty}>>} ingresos — más viejos primero
 * @returns {Map<string, {llego, qty_llegada}>} clave `${odoo_order_id}|${odoo_id}`; llego es el
 *   ingreso que completó la cantidad, o null si todavía falta
 */
function repartirIngresos(cotizaciones, ingresos) {
    const quedan = new Map();
    for (const [odooId, lista] of ingresos || []) {
        quedan.set(odooId, lista.map(i => ({ ...i, queda: Number(i.qty) || 0 })));
    }
    const ordenadas = [...cotizaciones].sort((a, b) =>
        String(a.date_order || '').localeCompare(String(b.date_order || '')) || (a.odoo_order_id - b.odoo_order_id)
    );
    const reparto = new Map();
    for (const c of ordenadas) {
        const limite = c.date_order ? new Date(c.date_order).getTime() : null;
        for (const p of c.productos) {
            let recibido = 0;
            let ultimo = null;
            for (const ingreso of quedan.get(p.odoo_id) || []) {
                if (recibido >= p.qty) break;
                if (ingreso.queda <= 0) continue;
                if (limite != null && new Date(ingreso.at).getTime() < limite) continue;
                const toma = Math.min(ingreso.queda, p.qty - recibido);
                ingreso.queda -= toma;
                recibido += toma;
                ultimo = ingreso;
            }
            reparto.set(`${c.odoo_order_id}|${p.odoo_id}`, {
                llego: ultimo && recibido >= p.qty
                    ? { ingreso_id: ultimo.ingreso_id, comprobante: ultimo.comprobante, at: ultimo.at }
                    : null,
                qty_llegada: recibido,
            });
        }
    }
    return reparto;
}

/**
 * Se puede mandar a la cola: de Neggo, conocido, no Liquidar, fuera de la cola, sin llegar
 * y sin separar para el cliente.
 */
function puedeReponer(p, company) {
    return company === 'neggo' && p.en_cache !== false && !p.es_liquidar && !p.estado_cola && !p.llego && !p.separado;
}

/**
 * Cuánto pedir por producto al mandarlo a la cola: lo que esperan los clientes sin contar lo
 * que ya llegó o está separado, mínimo 1.
 */
function qtyParaCola(p) {
    const n = Math.round(Number(p.qty_falta ?? p.qty_total) || 0);
    return n > 0 ? n : 1;
}

/** Cotización «lista»: cada producto llegó o está separado. */
function contarListos(productos) {
    return productos.filter(p => p.llego || p.separado).length;
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

/**
 * Ingresos que trajeron estos productos para Neggo, con el mismo criterio que cierra la cola
 * de reposición: matcheado, activo para Neggo, no rechazado y no todo a Preventas.
 * qty es lo que quedó para Neggo: lo ingresado menos lo confirmado para Preventas.
 * @returns {Map<number, Array<{ingreso_id, comprobante, at, qty}>>} más viejos primero
 */
async function ingresosNeggo(odooIds, desde) {
    if (!odooIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT ii.odoo_product_id AS odoo_id, im.id AS ingreso_id,
                im.comprobante_numero AS comprobante, im.created_at AS at,
                ii.cantidad - COALESCE(ii.preventa_qty_confirmed, 0) AS qty
         FROM ingreso_items ii
         JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
         WHERE ii.odoo_product_id = ANY($1::int[])
           AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'
           AND ii.estado_item = 'matched'
           AND ii.odoo_active IS DISTINCT FROM FALSE
           AND im.estado IS DISTINCT FROM 'rechazado'
           AND COALESCE(ii.preventa_qty_confirmed, 0) < ii.cantidad
           AND ($2::timestamptz IS NULL OR im.created_at >= $2::timestamptz)
         ORDER BY im.created_at`,
        [odooIds, desde || null]
    );
    const mapa = new Map();
    for (const r of rows) {
        if (!mapa.has(r.odoo_id)) mapa.set(r.odoo_id, []);
        mapa.get(r.odoo_id).push({ ingreso_id: r.ingreso_id, comprobante: r.comprobante, at: r.at, qty: Number(r.qty) });
    }
    return mapa;
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

    // Lo de Neggo que ya entró en un ingreso desde la cotización más vieja
    const deNeggo = cotizaciones.filter(c => c.company === 'neggo');
    const desde = deNeggo.reduce((min, c) => (!min || (c.date_order && c.date_order < min) ? c.date_order : min), null);
    const idsNeggo = [...new Set(deNeggo.flatMap(c => c.productos.map(p => p.odoo_id)))];
    let ingresos = new Map();
    try {
        ingresos = await ingresosNeggo(idsNeggo, desde);
    } catch (err) {
        console.warn(`⚠️ Reposición/cotizaciones: no se pudieron leer los ingresos: ${err.message}`);
    }
    const reparto = repartirIngresos(deNeggo, ingresos);

    let separados = new Map();
    try {
        separados = await separadosDe(deNeggo.map(c => c.odoo_order_id));
    } catch (err) {
        console.warn(`⚠️ Reposición/cotizaciones: no se pudo leer lo separado: ${err.message}`);
    }

    const filtro = proveedor ? String(proveedor).trim().toLowerCase() : null;
    const completas = cotizaciones
        .map(c => {
            const productos = c.productos
                .map(p => {
                    const prod = completarProducto(p, info.get(claveProducto(c.company, p.odoo_id)));
                    const llegada = c.company === 'neggo' ? reparto.get(`${c.odoo_order_id}|${p.odoo_id}`) : null;
                    prod.llego = llegada?.llego || null;
                    prod.qty_llegada = llegada?.qty_llegada || 0;
                    prod.separado = c.company === 'neggo' ? separados.get(`${c.odoo_order_id}|${p.odoo_id}`) || null : null;
                    prod.puede_reponer = puedeReponer(prod, c.company);
                    return prod;
                })
                .filter(p => !filtro || p.vendor_name.toLowerCase() === filtro);
            return {
                ...c,
                productos,
                n_llegados: productos.filter(p => p.llego).length,
                n_separados: productos.filter(p => p.separado).length,
                n_listos: contarListos(productos),
            };
        })
        .filter(c => c.productos.length > 0);

    return {
        etiqueta: ETIQUETA_PENDIENTES,
        cotizaciones: completas,
        productos: resumirPorProducto(completas),
    };
}

/**
 * Lo separado de estas cotizaciones de Neggo.
 * @returns {Map<string, {at, por}>} clave `${odoo_order_id}|${odoo_id}`
 */
async function separadosDe(orderIds) {
    if (!orderIds.length) return new Map();
    await ensureSchema();
    const { rows } = await pool.query(
        `SELECT cs.odoo_order_id, cs.odoo_id, cs.created_at AS at,
                COALESCE(u.display_name, u.username) AS por
         FROM cotizacion_separados cs
         LEFT JOIN users u ON u.id = cs.user_id
         WHERE cs.company = 'neggo' AND cs.odoo_order_id = ANY($1::int[])`,
        [orderIds]
    );
    return new Map(rows.map(r => [`${r.odoo_order_id}|${r.odoo_id}`, { at: r.at, por: r.por || null }]));
}

/**
 * Cotización viva de Neggo con la etiqueta «Pendiente», leída de nuevo en Odoo antes de
 * tocarla. Falla si ya no está (confirmada, cancelada, sin la etiqueta o de Preventas).
 */
async function cotizacionVivaNeggo(odooOrderId) {
    const ids = await getCompanyIds();
    if (!ids.neggo) throw new Error('No se encontró la empresa Neggo en Odoo');
    const [order] = await callOdoo(
        'sale.order',
        'search_read',
        [[
            ['id', '=', odooOrderId],
            ['tag_ids.name', '=ilike', ETIQUETA_PENDIENTES],
            ['state', 'in', ESTADOS_VIVOS],
            ['company_id', '=', ids.neggo],
        ]],
        { fields: ['id', 'name'], limit: 1, context: { allowed_company_ids: [ids.neggo] } }
    ) || [];
    if (!order) {
        throw httpError('La cotización ya no está pendiente en Odoo (se confirmó, se canceló o es de Preventas). Tocá «Actualizar».', 409);
    }
    return { order, companyId: ids.neggo };
}

/** Tilda o destilda un producto de una cotización de Neggo como separado para el cliente. */
async function marcarSeparado({ odooOrderId, odooId, separado }, userId) {
    await ensureSchema();
    if (!separado) {
        await pool.query(
            `DELETE FROM cotizacion_separados WHERE company = 'neggo' AND odoo_order_id = $1 AND odoo_id = $2`,
            [odooOrderId, odooId]
        );
        return { separado: false };
    }
    const cotizaciones = await leerOdoo({ refrescar: false });
    const c = cotizaciones.find(x => x.odoo_order_id === odooOrderId && x.company === 'neggo');
    const p = c && c.productos.find(x => x.odoo_id === odooId);
    if (!p) throw httpError('Ese producto no está en una cotización pendiente de Neggo. Tocá «Actualizar».', 404);
    await pool.query(
        `INSERT INTO cotizacion_separados (company, odoo_order_id, order_name, odoo_id, qty, user_id)
         VALUES ('neggo', $1, $2, $3, $4, $5)
         ON CONFLICT (company, odoo_order_id, odoo_id) DO NOTHING`,
        [odooOrderId, c.name, odooId, p.qty, userId || null]
    );
    return { separado: true };
}

/**
 * Quita un producto de una cotización de Neggo: borra en Odoo sus líneas (todas las del
 * mismo producto) y la marca de separado.
 */
async function quitarProducto({ odooOrderId, odooId }, userId) {
    const { order, companyId } = await cotizacionVivaNeggo(odooOrderId);
    const lineas = await callOdoo(
        'sale.order.line',
        'search_read',
        [[['order_id', '=', odooOrderId], ['product_id', '=', odooId], ['display_type', '=', false]]],
        { fields: ['id'], limit: 100, context: { allowed_company_ids: [companyId] } }
    ) || [];
    if (!lineas.length) throw httpError(`El producto ya no está en ${order.name}. Tocá «Actualizar».`, 404);
    await odooService.unlinkSaleOrderLines(lineas.map(l => l.id), 'neggo');
    await ensureSchema();
    await pool.query(
        `DELETE FROM cotizacion_separados WHERE company = 'neggo' AND odoo_order_id = $1 AND odoo_id = $2`,
        [odooOrderId, odooId]
    );
    cacheOdoo = { at: 0, data: null };
    console.log(`✅ Reposición/cotizaciones: producto ${odooId} quitado de ${order.name} en Odoo por usuario ${userId}`);
    return { order_name: order.name, lineas: lineas.length };
}

/** Cancela en Odoo una cotización pendiente de Neggo y borra lo separado de ella. */
async function cancelarCotizacion({ odooOrderId }, userId) {
    const { order } = await cotizacionVivaNeggo(odooOrderId);
    await odooService.cancelSaleOrder(odooOrderId, 'neggo');
    await ensureSchema();
    await pool.query(
        `DELETE FROM cotizacion_separados WHERE company = 'neggo' AND odoo_order_id = $1`,
        [odooOrderId]
    );
    cacheOdoo = { at: 0, data: null };
    console.log(`✅ Reposición/cotizaciones: ${order.name} cancelada en Odoo por usuario ${userId}`);
    return { order_name: order.name };
}

/**
 * Manda a la cola de reposición los productos de Neggo de las cotizaciones que todavía no
 * se pidieron, con la cantidad que esperan los clientes. Filtra por odoo_ids, por proveedor
 * o va todo. Los que ya están en la cola, llegaron o son de Liquidar no se tocan.
 */
async function reponerLote({ odooIds = null, proveedor = null } = {}, userId) {
    const { productos } = await listar({ refrescar: false });
    const ids = Array.isArray(odooIds) && odooIds.length ? new Set(odooIds.map(Number)) : null;
    const prov = proveedor ? String(proveedor).trim().toLowerCase() : null;
    const candidatos = productos.filter(p =>
        p.company === 'neggo' && p.puede_reponer
        && (!ids || ids.has(p.odoo_id))
        && (!prov || p.vendor_name.toLowerCase() === prov)
    );

    const agregados = [];
    const errores = [];
    for (const p of candidatos) {
        try {
            const nota = `Cotización pendiente ${p.cotizaciones.map(c => c.name).join(', ')}`;
            const item = await reposicion.agregarReponer(p.odoo_id, userId, nota);
            const qty = qtyParaCola(p);
            await pool.query(
                `UPDATE reposicion_items SET qty_decidida = $2 WHERE id = $1 AND qty_decidida IS NULL`,
                [item.id, qty]
            );
            agregados.push({ id: item.id, odoo_id: p.odoo_id, name: item.name, vendor_name: p.vendor_name, qty });
        } catch (err) {
            errores.push({ odoo_id: p.odoo_id, name: p.name, error: err.message });
        }
    }
    console.log(`✅ Reposición/cotizaciones: ${agregados.length} a la cola${errores.length ? `, ⚠️ ${errores.length} con error` : ''}`);
    return { agregados, errores };
}

module.exports = {
    listar,
    reponerLote,
    marcarSeparado,
    quitarProducto,
    cancelarCotizacion,
    // Puros, para tests
    contarListos,
    armarCotizaciones,
    resumirPorProducto,
    repartirIngresos,
    puedeReponer,
    qtyParaCola,
};
