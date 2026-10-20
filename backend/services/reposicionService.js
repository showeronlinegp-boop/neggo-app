// Cola de reposición de Neggo.
// Orígenes: archivado (sync), reponer (manual), recorrida (escáner), bajo_stock (umbral).
// Se resuelven como repuesto o descartado. Solo lee Odoo vía cache; Generar OC sí escribe
// un borrador de purchase.order (reusa odooService.createPurchaseOrder).

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const SCHEMA_029 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '029_reposicion.sql'), 'utf8'
);
const SCHEMA_030 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '030_reposicion_completo.sql'), 'utf8'
);

const NO_REPONER_SQL = `LOWER(TRIM(COALESCE(opc.vendor_name, ''))) = 'liquidar'`;
const ESTADOS_FINALES = ['repuesto', 'descartado'];
// Prioridad al actualizar un pendiente existente (mayor gana)
const ORIGEN_RANK = { archivado: 4, bajo_stock: 3, recorrida: 2, reponer: 1 };

/** Umbral de stock para origen bajo_stock (env o default 3). */
function stockMin() {
    const n = parseInt(process.env.REPOSICION_STOCK_MIN, 10);
    return Number.isInteger(n) && n >= 0 ? n : 3;
}

/** Semanas de cobertura para qty sugerida (env o default 2). */
function semanasCobertura() {
    const n = parseFloat(process.env.REPOSICION_COBERTURA_SEMANAS);
    return Number.isFinite(n) && n > 0 ? n : 2;
}

async function ensureSchema(db = pool) {
    await db.query(SCHEMA_029);
    await db.query(SCHEMA_030);
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Compara el estado activo del cache ANTES del sync con lo que trajo Odoo.
 * @param {Map<number, boolean>} antes — odoo_id → active previo en el cache
 * @param {Array<{id:number, active:boolean}>} productos — productos recibidos de Odoo
 * @returns {{ archivados: number[], reactivados: number[] }}
 */
function detectarTransiciones(antes, productos) {
    const archivados = [];
    const reactivados = [];
    for (const p of productos) {
        if (!antes.has(p.id)) continue;
        const eraActivo = antes.get(p.id) === true;
        if (eraActivo && !p.active) archivados.push(p.id);
        if (!eraActivo && p.active) reactivados.push(p.id);
    }
    return { archivados, reactivados };
}

/**
 * Productos activos con stock bajo el umbral (y no Liquidar).
 * @param {Array<{id:number, active:boolean, qty_available?:number}>} productos
 */
function detectarBajoStock(productos, umbral = stockMin()) {
    const ids = [];
    for (const p of productos) {
        if (!p.active) continue;
        const qty = p.qty_available == null ? null : Number(p.qty_available);
        if (qty === null || Number.isNaN(qty)) continue;
        if (qty <= umbral) ids.push(p.id);
    }
    return ids;
}

/**
 * Mete en la cola productos archivados (origen 'archivado'), salvo los de "Liquidar".
 * Si ya estaban pendientes con otro origen, suben a 'archivado'.
 */
async function registrarArchivados(odooIds, { createdBy = null, db = pool } = {}) {
    if (!odooIds.length) return [];
    const { rows } = await db.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, created_by)
         SELECT opc.odoo_id, 'neggo', 'archivado', $2
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo'
           AND opc.odoo_id = ANY($1::int[])
           AND NOT ${NO_REPONER_SQL}
         ON CONFLICT (odoo_id, company) WHERE estado = 'pendiente'
         DO UPDATE SET origen = 'archivado'
         RETURNING odoo_id`,
        [odooIds, createdBy]
    );
    return rows.map(r => r.odoo_id);
}

/**
 * Encola activos con stock bajo. No pisa un pendiente 'archivado'.
 */
async function registrarBajoStock(odooIds, { createdBy = null, db = pool } = {}) {
    if (!odooIds.length) return [];
    const { rows } = await db.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, created_by)
         SELECT opc.odoo_id, 'neggo', 'bajo_stock', $2
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo'
           AND opc.odoo_id = ANY($1::int[])
           AND opc.active = true
           AND NOT ${NO_REPONER_SQL}
         ON CONFLICT (odoo_id, company) WHERE estado = 'pendiente'
         DO UPDATE SET origen = CASE
             WHEN reposicion_items.origen = 'archivado' THEN reposicion_items.origen
             ELSE 'bajo_stock'
         END
         RETURNING odoo_id`,
        [odooIds, createdBy]
    );
    return rows.map(r => r.odoo_id);
}

/**
 * Stock se recuperó por encima del umbral: los pendientes solo por bajo_stock se resuelven.
 */
async function resolverStockRecuperado(odooIdsSobreUmbral, { resolvedBy = null, db = pool } = {}) {
    if (!odooIdsSobreUmbral.length) return 0;
    const { rowCount } = await db.query(
        `UPDATE reposicion_items
         SET estado = 'repuesto', resolved_at = NOW(), resolved_by = $2,
             nota = COALESCE(nota, 'Stock recuperado por encima del umbral')
         WHERE company = 'neggo' AND estado = 'pendiente'
           AND origen = 'bajo_stock'
           AND odoo_id = ANY($1::int[])`,
        [odooIdsSobreUmbral, resolvedBy]
    );
    return rowCount;
}

async function resolverReactivados(odooIds, { resolvedBy = null, db = pool } = {}) {
    if (!odooIds.length) return 0;
    const { rowCount } = await db.query(
        `UPDATE reposicion_items
         SET estado = 'repuesto', resolved_at = NOW(), resolved_by = $2,
             nota = COALESCE(nota, 'Se reactivó en Odoo')
         WHERE company = 'neggo' AND estado = 'pendiente' AND odoo_id = ANY($1::int[])`,
        [odooIds, resolvedBy]
    );
    return rowCount;
}

/**
 * Lo llama el sync de Odoo (empresa Neggo) con el estado previo del cache.
 */
async function procesarSync(antes, productos) {
    const { archivados, reactivados } = detectarTransiciones(antes, productos);
    const bajoIds = detectarBajoStock(productos);
    const umbral = stockMin();
    const recuperados = productos
        .filter(p => p.active && p.qty_available != null && Number(p.qty_available) > umbral)
        .map(p => p.id);

    const encolados = await registrarArchivados(archivados);
    const encoladosBajo = await registrarBajoStock(bajoIds);
    const repuestos = await resolverReactivados(reactivados);
    const stockOk = await resolverStockRecuperado(recuperados);

    if (encolados.length || encoladosBajo.length || repuestos || stockOk) {
        console.log(
            `📦 Reposición: ${encolados.length} archivado(s), ${encoladosBajo.length} bajo stock, `
            + `${repuestos} reactivado(s), ${stockOk} stock recuperado`
        );
    }
    return {
        encolados: encolados.length,
        bajoStock: encoladosBajo.length,
        repuestos,
        stockRecuperado: stockOk,
    };
}

const SELECT_ITEM = `
    SELECT ri.id, ri.odoo_id, ri.origen, ri.estado, ri.qty_decidida, ri.qty_sugerida, ri.nota,
           ri.odoo_po_id, ri.created_at, ri.resolved_at,
           COALESCE(uc.display_name, uc.username) AS created_by_name,
           COALESCE(ur.display_name, ur.username) AS resolved_by_name,
           opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.has_image,
           opc.list_price, opc.standard_price, opc.categ_name, opc.active, opc.qty_available,
           COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name
    FROM reposicion_items ri
    LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ri.odoo_id AND opc.company = ri.company
    LEFT JOIN users uc ON uc.id = ri.created_by
    LEFT JOIN users ur ON ur.id = ri.resolved_by
`;

async function listar({ estado = 'pendiente' } = {}) {
    if (estado === 'resueltos') {
        const { rows } = await pool.query(
            `${SELECT_ITEM} WHERE ri.estado = ANY($1::text[]) ORDER BY ri.resolved_at DESC NULLS LAST LIMIT 200`,
            [ESTADOS_FINALES]
        );
        return rows;
    }
    const { rows } = await pool.query(
        `${SELECT_ITEM} WHERE ri.estado = 'pendiente' ORDER BY vendor_name, ri.created_at`
    );
    return rows;
}

/**
 * Marca un producto para reponer. origen: reponer | recorrida.
 */
async function agregarReponer(odooId, userId, nota = null, origen = 'reponer') {
    // Desde la UI solo se permite reponer (manual) o recorrida (escáner)
    if (origen !== 'reponer' && origen !== 'recorrida') {
        throw httpError('Origen inválido: usá reponer o recorrida', 400);
    }
    const origenFinal = origen;

    const { rows: [prod] } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.active, ${NO_REPONER_SQL} AS es_liquidar
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.odoo_id = $1`,
        [odooId]
    );
    if (!prod) throw httpError('Producto no encontrado en Neggo', 404);
    if (prod.es_liquidar) throw httpError(`"${prod.name}" es de Liquidar: no se repone`, 400);

    // Si ya hay pendiente, no duplicar; si el nuevo origen es más fuerte, actualizar
    const { rows: [existente] } = await pool.query(
        `SELECT id, origen FROM reposicion_items
         WHERE company = 'neggo' AND estado = 'pendiente' AND odoo_id = $1`,
        [odooId]
    );
    if (existente) {
        if ((ORIGEN_RANK[origenFinal] || 0) > (ORIGEN_RANK[existente.origen] || 0)) {
            await pool.query(
                `UPDATE reposicion_items SET origen = $2, nota = COALESCE($3, nota) WHERE id = $1`,
                [existente.id, origenFinal, nota || null]
            );
        }
        const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [existente.id]);
        if ((ORIGEN_RANK[origenFinal] || 0) <= (ORIGEN_RANK[existente.origen] || 0)) {
            throw httpError(`"${prod.name}" ya está en la cola de reposición`, 409);
        }
        return item;
    }

    const { rows } = await pool.query(
        `INSERT INTO reposicion_items (odoo_id, company, origen, nota, created_by)
         VALUES ($1, 'neggo', $2, $3, $4)
         RETURNING id`,
        [odooId, origenFinal, nota || null, userId]
    );
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [rows[0].id]);
    return item;
}

async function cambiarEstado(id, { estado, qtyDecidida, nota }, userId) {
    if (![...ESTADOS_FINALES, 'pendiente'].includes(estado)) {
        throw httpError('Estado inválido: usá pendiente, repuesto o descartado', 400);
    }
    const qty = qtyDecidida == null || qtyDecidida === '' ? null : Number(qtyDecidida);
    if (qty !== null && (!Number.isInteger(qty) || qty < 0)) {
        throw httpError('La cantidad tiene que ser un número entero', 400);
    }
    const final = estado !== 'pendiente';
    try {
        const { rows } = await pool.query(
            `UPDATE reposicion_items
             SET estado = $2,
                 qty_decidida = COALESCE($3, qty_decidida),
                 nota = COALESCE($4, nota),
                 resolved_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
                 resolved_by = CASE WHEN $5 THEN $6::int ELSE NULL END
             WHERE id = $1
             RETURNING id`,
            [id, estado, qty, nota ?? null, final, userId]
        );
        if (!rows.length) throw httpError('Ítem de reposición no encontrado', 404);
    } catch (err) {
        if (err.code === '23505') throw httpError('Ese producto ya tiene otro pendiente en la cola', 409);
        throw err;
    }
    const { rows: [item] } = await pool.query(`${SELECT_ITEM} WHERE ri.id = $1`, [id]);
    return item;
}

async function buscarProductos(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url, opc.list_price,
                opc.qty_available,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                EXISTS (SELECT 1 FROM reposicion_items ri
                        WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
                          AND ri.estado = 'pendiente') AS en_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.active = true
           AND (opc.name ILIKE $1 OR opc.internal_ref ILIKE $1 OR opc.barcode = $2)
         ORDER BY (opc.barcode = $2) DESC, opc.name
         LIMIT 20`,
        [`%${term}%`, term]
    );
    return rows;
}

/** Busca un producto activo de Neggo por código de barras exacto (recorrida). */
async function buscarPorBarcode(barcode) {
    const code = String(barcode || '').trim();
    if (!code) return null;
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.barcode, opc.image_url,
                opc.list_price, opc.standard_price, opc.qty_available,
                COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') AS vendor_name,
                ${NO_REPONER_SQL} AS es_liquidar,
                EXISTS (SELECT 1 FROM reposicion_items ri
                        WHERE ri.odoo_id = opc.odoo_id AND ri.company = 'neggo'
                          AND ri.estado = 'pendiente') AS en_cola
         FROM odoo_products_cache opc
         WHERE opc.company = 'neggo' AND opc.barcode = $1
         LIMIT 1`,
        [code]
    );
    return rows[0] || null;
}

/**
 * Lunes ISO (UTC date string YYYY-MM-DD) de una fecha.
 */
function lunesDe(fecha) {
    const d = new Date(fecha);
    const day = d.getUTCDay(); // 0=dom
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
}

/**
 * Métricas de venta por odoo_id a partir de product_sales_weekly.
 * qty_7d = semana actual (parcial) + fracción; usamos suma de la semana más reciente
 * y promedio de las últimas 4 semanas completas como ritmo.
 */
async function metricasVenta(odooIds) {
    if (!odooIds.length) return new Map();
    const { rows } = await pool.query(
        `SELECT odoo_id, week_start, qty_vendida, amount_total
         FROM product_sales_weekly
         WHERE company = 'neggo' AND odoo_id = ANY($1::int[])
           AND week_start >= (CURRENT_DATE - INTERVAL '35 days')
         ORDER BY odoo_id, week_start DESC`,
        [odooIds]
    );
    const byId = new Map();
    for (const r of rows) {
        if (!byId.has(r.odoo_id)) byId.set(r.odoo_id, []);
        byId.get(r.odoo_id).push(r);
    }
    const out = new Map();
    const cobertura = semanasCobertura();
    for (const id of odooIds) {
        const weeks = byId.get(id) || [];
        const qty7 = weeks[0] ? Number(weeks[0].qty_vendida) : 0;
        const last4 = weeks.slice(0, 4);
        const avgWeekly = last4.length
            ? last4.reduce((s, w) => s + Number(w.qty_vendida), 0) / last4.length
            : 0;
        const amount30 = weeks.reduce((s, w) => s + Number(w.amount_total), 0);
        // Semáforo: ritmo reciente vs promedio
        let ritmo = 'sin_datos';
        if (avgWeekly > 0 || qty7 > 0) {
            if (avgWeekly <= 0) ritmo = 'reponer';
            else if (qty7 >= avgWeekly * 1.15) ritmo = 'reponer';
            else if (qty7 <= avgWeekly * 0.7) ritmo = 'flojo';
            else ritmo = 'estable';
        }
        out.set(id, { qty_7d: qty7, avg_weekly: avgWeekly, amount_30d: amount30, ritmo });
    }
    // qty sugerida se completa en detalleProveedor con stock
    void cobertura;
    return out;
}

/** Clasificación ABC por amount_30d (A = top ~80% acumulado, B ~15%, C resto). */
function clasificarAbc(itemsConAmount) {
    const sorted = [...itemsConAmount].sort((a, b) => b.amount_30d - a.amount_30d);
    const total = sorted.reduce((s, i) => s + i.amount_30d, 0);
    const labels = new Map();
    if (total <= 0) {
        for (const i of sorted) labels.set(i.odoo_id, 'C');
        return labels;
    }
    let acum = 0;
    for (const i of sorted) {
        acum += i.amount_30d;
        const pct = acum / total;
        labels.set(i.odoo_id, pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C');
    }
    return labels;
}

/**
 * Detalle de un proveedor: pendientes + métricas de venta + sugerencias.
 */
async function detalleProveedor(vendorName) {
    const nombre = String(vendorName || '').trim();
    if (!nombre) throw httpError('Proveedor requerido', 400);

    const { rows: items } = await pool.query(
        `${SELECT_ITEM}
         WHERE ri.estado = 'pendiente'
           AND COALESCE(NULLIF(TRIM(opc.vendor_name), ''), 'Sin proveedor') = $1
         ORDER BY ri.created_at`,
        [nombre]
    );

    const ids = items.map(i => i.odoo_id);
    const metrics = await metricasVenta(ids);
    const forAbc = ids.map(id => ({
        odoo_id: id,
        amount_30d: metrics.get(id)?.amount_30d || 0,
    }));
    const abc = clasificarAbc(forAbc);
    const cobertura = semanasCobertura();

    const enriched = items.map(it => {
        const m = metrics.get(it.odoo_id) || { qty_7d: 0, avg_weekly: 0, amount_30d: 0, ritmo: 'sin_datos' };
        const stock = it.qty_available == null ? 0 : Number(it.qty_available);
        const sugerida = Math.max(0, Math.ceil(m.avg_weekly * cobertura - stock));
        return {
            ...it,
            qty_7d: m.qty_7d,
            avg_weekly: Math.round(m.avg_weekly * 100) / 100,
            amount_30d: m.amount_30d,
            ritmo: m.ritmo,
            abc: abc.get(it.odoo_id) || 'C',
            qty_sugerida_calc: sugerida,
        };
    });

    return {
        vendor_name: nombre,
        items: enriched,
        resumen: {
            pendientes: enriched.length,
            reponer: enriched.filter(i => i.ritmo === 'reponer').length,
            flojo: enriched.filter(i => i.ritmo === 'flojo').length,
            sin_datos: enriched.filter(i => i.ritmo === 'sin_datos').length,
        },
    };
}

/**
 * Genera un borrador de OC en Odoo Neggo para los ítems del proveedor.
 * @param {{ vendorName: string, items: Array<{id:number, qty_decidida?:number}>, partnerId?: number }} opts
 */
async function generarOc({ vendorName, items, partnerId, userId }) {
    if (!items?.length) throw httpError('Seleccioná al menos un producto', 400);
    const odooService = require('./odooService');

    const ids = items.map(i => parseInt(i.id, 10)).filter(Number.isInteger);
    const { rows: filas } = await pool.query(
        `${SELECT_ITEM} WHERE ri.id = ANY($1::int[]) AND ri.estado = 'pendiente'`,
        [ids]
    );
    if (!filas.length) throw httpError('No hay pendientes válidos para generar la OC', 400);

    const vendor = vendorName
        || filas[0].vendor_name
        || 'Sin proveedor';

    let partner = partnerId ? parseInt(partnerId, 10) : null;
    if (!partner) {
        // Buscar en scrape_config de suppliers locales
        const { rows: [sup] } = await pool.query(
            `SELECT (scrape_config->>'odoo_partner_id')::int AS partner_id
             FROM suppliers
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
               AND scrape_config ? 'odoo_partner_id'
             LIMIT 1`,
            [vendor]
        );
        partner = sup?.partner_id || null;
    }
    if (!partner) {
        const partners = await odooService.getPartners({ type: 'supplier', search: vendor });
        const exact = partners.find(p => p.name.trim().toLowerCase() === vendor.trim().toLowerCase());
        partner = (exact || partners[0])?.id || null;
    }
    if (!partner) {
        throw httpError(
            `No encontré el proveedor "${vendor}" en Odoo. Pasá partner_id o vinculalo en Proveedores.`,
            400
        );
    }

    const qtyById = new Map(items.map(i => [parseInt(i.id, 10), i.qty_decidida]));
    const lines = [];
    for (const f of filas) {
        let qty = qtyById.get(f.id);
        if (qty == null || qty === '') qty = f.qty_decidida;
        if (qty == null || qty === '') {
            const m = (await metricasVenta([f.odoo_id])).get(f.odoo_id);
            const stock = f.qty_available == null ? 0 : Number(f.qty_available);
            qty = Math.max(1, Math.ceil((m?.avg_weekly || 0) * semanasCobertura() - stock));
        }
        qty = parseInt(qty, 10);
        if (!Number.isInteger(qty) || qty < 1) {
            throw httpError(`Cantidad inválida para "${f.name}"`, 400);
        }
        lines.push({
            product_id: f.odoo_id,
            name: f.name || `Producto ${f.odoo_id}`,
            quantity: qty,
            unit_price: Number(f.standard_price) || 0,
        });
    }

    const poId = await odooService.createPurchaseOrder(partner, lines, 'neggo');

    for (const f of filas) {
        const line = lines.find(l => l.product_id === f.odoo_id);
        await pool.query(
            `UPDATE reposicion_items
             SET estado = 'repuesto',
                 qty_decidida = $2,
                 odoo_po_id = $3,
                 resolved_at = NOW(),
                 resolved_by = $4,
                 nota = COALESCE(nota, $5)
             WHERE id = $1`,
            [f.id, line.quantity, poId, userId, `OC Odoo #${poId}`]
        );
    }

    console.log(`✅ Reposición: OC borrador ${poId} para "${vendor}" (${lines.length} líneas)`);
    return { odoo_po_id: poId, partner_id: partner, vendor_name: vendor, lineas: lines.length };
}

module.exports = {
    ensureSchema,
    stockMin,
    detectarTransiciones,
    detectarBajoStock,
    registrarArchivados,
    registrarBajoStock,
    resolverReactivados,
    resolverStockRecuperado,
    procesarSync,
    listar,
    agregarReponer,
    cambiarEstado,
    buscarProductos,
    buscarPorBarcode,
    detalleProveedor,
    generarOc,
    metricasVenta,
    clasificarAbc,
    lunesDe,
};
