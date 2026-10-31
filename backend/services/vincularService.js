// Vincular (nota 107, punto 3): pantallas de /productos/vinculos sobre la tabla maestra.
//   - Lote por código: los sugeridos 'codigo' (PRE + referencia Neggo = SKU), todo tildado
//   - Tarjetas por nombre: un producto de Neggo por tarjeta con hasta 3 ofertas parecidas,
//     ordenadas por venta y con tope diario (nota 123)
//   - Conflictos: una oferta confirmada con dos o más productos de Neggo
//   - Sin habitual: productos con oferta web confirmada pero sin habitual (informativo)
//   - Repaso de ingresos: vuelve a pasar todos los ingresos confirmados a la tabla maestra
// Solo Neggo: Preventas es un dato de origen y Precompras (origen "neggo") es base de costos.
// Ninguna decisión escribe en Odoo, salvo "No usar" (nota 118) y cambiar el código de referencia de un
// producto (nota 117), que va a Odoo porque la sincronización lo vuelve a traer. Con la tabla maestra
// prendida, lo confirmado queda activo y el habitual pasa a mover precios (siempre con la alerta de
// Neggo, que se aprueba a mano).

const pool = require('../config/database');
const odoo = require('../config/odoo');
const { vincularDesdeIngresos, listarConflictos, recalcularHabituales, tablaActiva } = require('./tablaMaestraService');
const odooService = require('./odooService');

// Tarjetas que se muestran por día (las revisa una sola persona)
const TARJETAS_POR_DIA = 80;
// Semanas de venta que ordenan las tarjetas y el lote
const SEMANAS_VENTA = 6;
// Productos de Odoo que no son mercadería (anticipos y pedidos de preventa)
const NO_MERCADERIA = ['Down Payment (POS)', 'Pedido Preventa'];
// Métodos del lote (por código) y de las tarjetas (por parecido de nombre)
const METODOS_CODIGO = ['codigo', 'auto_ref'];
// Métodos que alimentan las tarjetas (sugeridos por parecido de nombre)
const METODOS_NOMBRE = ['nombre', 'auto_fuzzy'];

// Venta de las últimas semanas por producto de Neggo (sin anticipos ni pedidos de preventa)
const VENTAS_CTE = `
    ventas AS (
        SELECT psw.odoo_id, SUM(psw.amount_total) AS monto
        FROM product_sales_weekly psw
        WHERE psw.company = 'neggo'
          AND psw.week_start > (SELECT MAX(week_start) FROM product_sales_weekly) - ($1::int * 7)
        GROUP BY psw.odoo_id
    )`;

// Precio neto de la oferta: lista × (1 − descuento de la categoría o del proveedor)
const NETO_SQL = `ROUND(sp.raw_price * (1 - COALESCE(r.discount_override, s.default_discount, 0) / 100.0), 2)`;
const JOIN_REGLA = `LEFT JOIN supplier_category_rules r
                        ON r.supplier_id = sp.supplier_id AND r.source_category = sp.source_category AND r.active`;

/**
 * Sugeridos por código pendientes, para confirmar en lote.
 * @param {{ supplierId?: number }} opts
 */
async function listarLoteCodigo({ supplierId = null } = {}) {
    const { rows } = await pool.query(
        `WITH ${VENTAS_CTE}
         SELECT pm.id, pm.supplier_product_id, pm.odoo_product_id,
                s.id AS supplier_id, s.name AS proveedor,
                sp.sku, sp.name AS oferta_nombre, sp.raw_price, ${NETO_SQL} AS neto, sp.available, sp.image_url,
                opc.name AS odoo_nombre, opc.internal_ref, opc.standard_price, opc.list_price,
                opc.active AS odoo_activo, opc.image_url AS odoo_image_url, COALESCE(v.monto, 0) AS venta
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         JOIN suppliers s ON s.id = sp.supplier_id
         ${JOIN_REGLA}
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = pm.odoo_product_id AND opc.company = 'neggo'
         LEFT JOIN ventas v ON v.odoo_id = pm.odoo_product_id
         WHERE pm.odoo_company = 'neggo' AND pm.estado = 'sugerido' AND pm.metodo = ANY($3::text[])
           AND ($2::int IS NULL OR s.id = $2)
         ORDER BY s.name, COALESCE(v.monto, 0) DESC, sp.sku`,
        [SEMANAS_VENTA, supplierId, METODOS_CODIGO]
    );
    return rows;
}

/**
 * Pasa sugeridos a confirmado o rechazado y anota la decisión (acierto por método).
 * Solo toca sugeridos de Neggo: lo ya decidido no cambia.
 * @param {pg.PoolClient} db
 * @param {number[]} ids — product_mappings.id
 * @param {'confirmado'|'rechazado'} decision
 * @param {number|null} userId
 * @returns {Promise<number>} cuántos cambiaron
 */
async function decidirSugeridos(db, ids, decision, userId) {
    if (!ids.length) return 0;
    const { rows } = await db.query(
        `UPDATE product_mappings
         SET estado = $2::text,
             confirmado_por = CASE WHEN $2::text = 'confirmado' THEN $3::int ELSE confirmado_por END,
             confirmado_at  = CASE WHEN $2::text = 'confirmado' THEN NOW() ELSE confirmado_at END
         WHERE id = ANY($1::int[]) AND odoo_company = 'neggo' AND estado = 'sugerido'
         RETURNING supplier_product_id, odoo_product_id, odoo_company, metodo, match_confidence`,
        [ids, decision, userId]
    );
    for (const r of rows) {
        await db.query(
            `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [r.supplier_product_id, r.odoo_product_id, r.odoo_company, decision, r.metodo, r.match_confidence, userId]
        );
    }
    // Si se confirmó la oferta del proveedor principal de Odoo, pasa a ser la habitual (y, con la
    // tabla maestra prendida, queda activa)
    if (decision === 'confirmado' && rows.length) await recalcularHabituales(db);
    return rows.length;
}

// Corre fn dentro de una transacción con su propio cliente
async function enTransaccion(fn) {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const resultado = await fn(db);
        await db.query('COMMIT');
        return resultado;
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.release();
    }
}

/**
 * Lote por código: los tildados quedan confirmados; los destildados, rechazados solo si se pide.
 * @param {{ confirmar: number[], rechazar?: number[], userId: number }} opts
 */
async function decidirLote({ confirmar = [], rechazar = [], userId }) {
    return enTransaccion(async (db) => ({
        confirmados: await decidirSugeridos(db, confirmar, 'confirmado', userId),
        rechazados: await decidirSugeridos(db, rechazar, 'rechazado', userId),
    }));
}

// Productos con tarjeta ya decidida por una persona desde las 00:00 de hoy, hora de Argentina
// (created_at se guarda en UTC)
async function tarjetasDecididasHoy(db = pool) {
    const { rows } = await db.query(
        `SELECT COUNT(DISTINCT odoo_product_id)::int AS n
         FROM match_decisiones
         WHERE odoo_company = 'neggo' AND metodo = ANY($1::text[]) AND user_id IS NOT NULL
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`,
        [METODOS_NOMBRE]
    );
    return rows[0].n;
}

/**
 * Tarjetas por nombre: productos de Neggo con sugeridos por parecido de nombre, de lo que más se
 * vende a lo que menos, hasta completar el tope del día. Cada tarjeta trae hasta 3 ofertas.
 * @returns {Promise<{ tarjetas: Array, decididas_hoy: number, tope: number, pendientes: number }>}
 */
async function listarTarjetas() {
    const decididas = await tarjetasDecididasHoy();
    const restan = Math.max(TARJETAS_POR_DIA - decididas, 0);

    const { rows: [{ pendientes }] } = await pool.query(
        `SELECT COUNT(DISTINCT pm.odoo_product_id)::int AS pendientes
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         WHERE pm.odoo_company = 'neggo' AND pm.estado = 'sugerido' AND pm.metodo = ANY($1::text[])`,
        [METODOS_NOMBRE]
    );
    if (restan === 0) return { tarjetas: [], decididas_hoy: decididas, tope: TARJETAS_POR_DIA, pendientes };

    const { rows } = await pool.query(
        `WITH ${VENTAS_CTE},
         productos AS (
             SELECT pm.odoo_product_id, COALESCE(MAX(v.monto), 0) AS venta
             FROM product_mappings pm
             JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
             LEFT JOIN ventas v ON v.odoo_id = pm.odoo_product_id
             WHERE pm.odoo_company = 'neggo' AND pm.estado = 'sugerido' AND pm.metodo = ANY($2::text[])
             GROUP BY pm.odoo_product_id
             ORDER BY venta DESC, pm.odoo_product_id
             LIMIT $3
         )
         SELECT p.odoo_product_id, p.venta,
                opc.name AS odoo_nombre, opc.internal_ref, opc.standard_price, opc.list_price,
                opc.vendor_name, opc.active AS odoo_activo, opc.image_url AS odoo_image_url,
                pm.id AS mapping_id, pm.supplier_product_id, pm.match_confidence,
                s.name AS proveedor, sp.sku, sp.name AS oferta_nombre, sp.raw_price, ${NETO_SQL} AS neto, sp.available,
                sp.image_url
         FROM productos p
         JOIN product_mappings pm ON pm.odoo_product_id = p.odoo_product_id AND pm.odoo_company = 'neggo'
              AND pm.estado = 'sugerido' AND pm.metodo = ANY($2::text[])
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         JOIN suppliers s ON s.id = sp.supplier_id
         ${JOIN_REGLA}
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = p.odoo_product_id AND opc.company = 'neggo'
         ORDER BY p.venta DESC, p.odoo_product_id, pm.match_confidence DESC NULLS LAST, sp.available DESC, pm.id`,
        [SEMANAS_VENTA, METODOS_NOMBRE, restan]
    );

    // Una tarjeta por producto, con sus 3 mejores ofertas
    const porProducto = new Map();
    for (const r of rows) {
        if (!porProducto.has(r.odoo_product_id)) {
            porProducto.set(r.odoo_product_id, {
                odoo_product_id: r.odoo_product_id, odoo_nombre: r.odoo_nombre, internal_ref: r.internal_ref,
                standard_price: r.standard_price, list_price: r.list_price, vendor_name: r.vendor_name,
                odoo_activo: r.odoo_activo, odoo_image_url: r.odoo_image_url, venta: r.venta, ofertas: []
            });
        }
        const tarjeta = porProducto.get(r.odoo_product_id);
        if (tarjeta.ofertas.length < 3) {
            tarjeta.ofertas.push({
                mapping_id: r.mapping_id, supplier_product_id: r.supplier_product_id, proveedor: r.proveedor,
                sku: r.sku, nombre: r.oferta_nombre, raw_price: r.raw_price, neto: r.neto,
                available: r.available, parecido: r.match_confidence, image_url: r.image_url
            });
        }
    }
    return { tarjetas: [...porProducto.values()], decididas_hoy: decididas, tope: TARJETAS_POR_DIA, pendientes };
}

/**
 * Decisión de una tarjeta: la oferta elegida queda confirmada y las demás sugeridas por nombre de
 * ese producto, rechazadas. Sin elegida ("ninguna") se rechazan todas.
 * @param {{ odooProductId: number, mappingId?: number|null, userId: number }} opts
 */
async function decidirTarjeta({ odooProductId, mappingId = null, userId }) {
    return enTransaccion(async (db) => {
        const { rows } = await db.query(
            `SELECT id FROM product_mappings
             WHERE odoo_product_id = $1 AND odoo_company = 'neggo' AND estado = 'sugerido'
               AND metodo = ANY($2::text[])`,
            [odooProductId, METODOS_NOMBRE]
        );
        const ids = rows.map(r => r.id);
        if (mappingId && !ids.includes(mappingId)) {
            const err = new Error('La oferta elegida ya no está pendiente en esta tarjeta');
            err.status = 409;
            throw err;
        }
        return {
            confirmados: mappingId ? await decidirSugeridos(db, [mappingId], 'confirmado', userId) : 0,
            rechazados: await decidirSugeridos(db, ids.filter(id => id !== mappingId), 'rechazado', userId),
        };
    });
}

/**
 * Conflictos con los nombres de los productos de Neggo, para decidir cuál no es.
 */
async function listarConflictosDetalle() {
    const conflictos = await listarConflictos();
    if (!conflictos.length) return [];
    const ids = [...new Set(conflictos.flatMap(c => c.odoo_ids))];
    const { rows } = await pool.query(
        `SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.active, opc.vendor_name, opc.image_url,
                pm.supplier_product_id, pm.metodo, pm.confirmado_at
         FROM odoo_products_cache opc
         JOIN product_mappings pm ON pm.odoo_product_id = opc.odoo_id AND pm.odoo_company = 'neggo'
              AND pm.estado = 'confirmado'
         WHERE opc.company = 'neggo' AND opc.odoo_id = ANY($1::int[])`,
        [ids]
    );
    return conflictos.map(c => ({
        ...c,
        productos: rows
            .filter(r => r.supplier_product_id === c.supplier_product_id && c.odoo_ids.includes(r.odoo_id))
            .map(r => ({
                odoo_id: r.odoo_id, nombre: r.name, internal_ref: r.internal_ref, activo: r.active,
                vendor_name: r.vendor_name, metodo: r.metodo, confirmado_at: r.confirmado_at, image_url: r.image_url
            }))
    }));
}

/**
 * "No es este": el par queda rechazado (sale de conflictos y no se vuelve a proponer).
 * @param {{ supplierProductId: number, odooProductId: number, userId: number }} opts
 */
async function rechazarPar({ supplierProductId, odooProductId, userId }) {
    return enTransaccion(async (db) => {
        const { rows } = await db.query(
            `UPDATE product_mappings SET estado = 'rechazado', active = false, es_habitual = false
             WHERE supplier_product_id = $1 AND odoo_product_id = $2 AND odoo_company = 'neggo'
               AND estado <> 'rechazado'
             RETURNING metodo, match_confidence`,
            [supplierProductId, odooProductId]
        );
        if (!rows.length) return { rechazado: false };
        await db.query(
            `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
             VALUES ($1, $2, 'neggo', 'rechazado', $3, $4, $5)`,
            [supplierProductId, odooProductId, rows[0].metodo, rows[0].match_confidence, userId]
        );
        return { rechazado: true };
    });
}

// Largo máximo del código de referencia que se acepta desde la pantalla
const REF_MAX = 64;

// Referencia sin símbolos y en mayúsculas, como la compara el lote por código
const refLimpia = (ref) => String(ref || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Cambia el código de referencia de un producto de Neggo en Odoo y en la app (nota 117).
 * Los vínculos por código de ese producto cuya oferta ya no coincide con el código nuevo
 * (SKU = 'PRE' + referencia sin símbolos) quedan rechazados, como un "No es este".
 * @param {{ odooProductId: number, ref: string, userId: number }} opts — ref vacía borra el código
 * @param {{ callOdoo: Function, getCompanyIds: Function }} deps — reemplazables en los tests
 * @returns {Promise<{ antes: string|null, despues: string|null, desvinculados: number }>}
 */
async function cambiarReferencia({ odooProductId, ref, userId }, deps = odoo) {
    const nueva = String(ref ?? '').trim() || null;
    if (nueva && nueva.length > REF_MAX) {
        throw Object.assign(new Error(`El código no puede tener más de ${REF_MAX} caracteres`), { status: 400 });
    }

    const { rows: [producto] } = await pool.query(
        `SELECT odoo_id, name, internal_ref FROM odoo_products_cache WHERE company = 'neggo' AND odoo_id = $1`,
        [odooProductId]
    );
    if (!producto) throw Object.assign(new Error('No se encontró el producto de Neggo'), { status: 404 });
    if ((producto.internal_ref || null) === nueva) return { antes: producto.internal_ref, despues: nueva, desvinculados: 0 };

    // Otro producto con el mismo código es justamente lo que arma los conflictos
    if (nueva) {
        const { rows: [otro] } = await pool.query(
            `SELECT name FROM odoo_products_cache
             WHERE company = 'neggo' AND odoo_id <> $1
               AND regexp_replace(UPPER(internal_ref), '[^A-Z0-9]', '', 'g') = $2
             LIMIT 1`,
            [odooProductId, refLimpia(nueva)]
        );
        if (otro) throw Object.assign(new Error(`Ese código ya lo tiene "${otro.name}"`), { status: 409 });
    }

    // Primero Odoo: si falla, la app no queda distinta de Odoo
    const { neggo } = await deps.getCompanyIds();
    await deps.callOdoo('product.product', 'write',
        [[odooProductId], { default_code: nueva || false }],
        { context: { allowed_company_ids: [neggo] } }
    );
    console.log(`✅ Código de ${producto.name} (${odooProductId}) cambiado en Odoo: ${producto.internal_ref || '—'} → ${nueva || '—'}`);

    const desvinculados = await enTransaccion(async (db) => {
        await db.query(
            `UPDATE odoo_products_cache SET internal_ref = $1 WHERE company = 'neggo' AND odoo_id = $2`,
            [nueva, odooProductId]
        );
        const { rows } = await db.query(
            `UPDATE product_mappings pm SET estado = 'rechazado', active = false, es_habitual = false
             FROM supplier_products sp
             WHERE sp.id = pm.supplier_product_id
               AND pm.odoo_product_id = $1 AND pm.odoo_company = 'neggo'
               AND pm.metodo = ANY($2::text[]) AND pm.estado <> 'rechazado'
               AND ($3::text = '' OR UPPER(sp.sku) <> 'PRE' || $3::text)
             RETURNING pm.supplier_product_id, pm.metodo, pm.match_confidence`,
            [odooProductId, METODOS_CODIGO, refLimpia(nueva)]
        );
        for (const r of rows) {
            await db.query(
                `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
                 VALUES ($1, $2, 'neggo', 'rechazado', $3, $4, $5)`,
                [r.supplier_product_id, odooProductId, r.metodo, r.match_confidence, userId]
            );
        }
        await db.query(
            `UPDATE product_mappings SET odoo_internal_ref = $1 WHERE odoo_product_id = $2 AND odoo_company = 'neggo'`,
            [nueva, odooProductId]
        );
        return rows.length;
    });
    if (desvinculados) console.log(`📦 ${desvinculados} vínculo(s) por código de ${producto.name} rechazados por el cambio de código`);
    return { antes: producto.internal_ref, despues: nueva, desvinculados };
}

/**
 * "No usar" (nota 118): marca el producto "[NO USAR]" en Odoo (leyenda en el nombre + archivado) y
 * lo saca de la app: rechaza todos sus vínculos y lo borra del cache sin esperar al sync, que
 * desde ahora lo deja afuera. Es la única acción de Vincular que escribe en Odoo.
 * @param {{ odooProductId: number, userId: number }} opts
 */
async function marcarNoUsar({ odooProductId, userId }) {
    const odoo = await odooService.marcarNoUsar(odooProductId, 'neggo');
    return enTransaccion(async (db) => {
        const { rows } = await db.query(
            `UPDATE product_mappings SET estado = 'rechazado', active = false, es_habitual = false
             WHERE odoo_product_id = $1 AND estado <> 'rechazado'
             RETURNING supplier_product_id, odoo_company, metodo, match_confidence`,
            [odooProductId]
        );
        for (const r of rows) {
            await db.query(
                `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
                 VALUES ($1, $2, $3, 'rechazado', $4, $5, $6)`,
                [r.supplier_product_id, odooProductId, r.odoo_company, r.metodo, r.match_confidence, userId]
            );
        }
        await db.query('DELETE FROM invoice_code_mappings WHERE odoo_product_id = $1', [odooProductId]);
        const { rowCount } = await db.query('DELETE FROM odoo_products_cache WHERE odoo_id = $1', [odooProductId]);
        return { ...odoo, vinculos_rechazados: rows.length, sacado_del_cache: rowCount > 0 };
    });
}

/**
 * Productos de Neggo con alguna oferta web confirmada y sin habitual (informativo: el habitual es
 * la oferta del proveedor principal de Odoo; si el principal no tiene oferta, queda sin habitual).
 */
async function listarSinHabitual() {
    const { rows } = await pool.query(
        `WITH ${VENTAS_CTE}
         SELECT opc.odoo_id, opc.name AS odoo_nombre, opc.internal_ref, opc.vendor_name, opc.active AS odoo_activo,
                opc.image_url AS odoo_image_url, COALESCE(v.monto, 0) AS venta,
                array_agg(DISTINCT s.name ORDER BY s.name) AS proveedores_vinculados,
                COUNT(*)::int AS ofertas
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         JOIN suppliers s ON s.id = sp.supplier_id
         JOIN odoo_products_cache opc ON opc.odoo_id = pm.odoo_product_id AND opc.company = 'neggo'
         LEFT JOIN ventas v ON v.odoo_id = opc.odoo_id
         WHERE pm.odoo_company = 'neggo' AND pm.estado = 'confirmado' AND opc.name <> ALL($2::text[])
           AND NOT EXISTS (SELECT 1 FROM product_mappings h
                           WHERE h.odoo_product_id = pm.odoo_product_id AND h.odoo_company = 'neggo' AND h.es_habitual)
         GROUP BY opc.odoo_id, opc.name, opc.internal_ref, opc.vendor_name, opc.active, opc.image_url, v.monto
         ORDER BY COALESCE(v.monto, 0) DESC, opc.name`,
        [SEMANAS_VENTA, NO_MERCADERIA]
    );
    return rows;
}

/**
 * Repasa todos los ingresos confirmados, proveedor por proveedor.
 * @param {{ userId: number }} opts
 */
async function repasarIngresos({ userId }) {
    const { rows } = await pool.query(
        `SELECT DISTINCT supplier_id FROM ingreso_mercaderia
         WHERE estado = 'confirmado' AND supplier_id IS NOT NULL ORDER BY supplier_id`
    );
    const total = { proveedores: rows.length, renglones: 0, creados: 0, confirmados: 0, sin_cambios: 0, conflictos: 0 };
    for (const { supplier_id } of rows) {
        const r = await vincularDesdeIngresos({ supplierId: supplier_id, userId });
        for (const k of ['renglones', 'creados', 'confirmados', 'sin_cambios']) total[k] += r[k];
        total.conflictos = r.conflictos;
    }
    return total;
}

/**
 * Cantidades para las pestañas.
 */
async function resumen() {
    const { rows: [r] } = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE pm.estado = 'sugerido' AND pm.metodo = ANY($2::text[]))::int AS lote,
            COUNT(DISTINCT pm.odoo_product_id) FILTER (WHERE pm.estado = 'sugerido' AND pm.metodo = ANY($1::text[]))::int AS tarjetas
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         WHERE pm.odoo_company = 'neggo'`,
        [METODOS_NOMBRE, METODOS_CODIGO]
    );
    const conflictos = (await listarConflictos()).length;
    const sinHabitual = (await listarSinHabitual()).length;
    return { lote: r.lote, tarjetas: r.tarjetas, conflictos, sin_habitual: sinHabitual, activa: await tablaActiva() };
}

module.exports = {
    listarLoteCodigo, decidirLote, listarTarjetas, decidirTarjeta, listarConflictosDetalle,
    rechazarPar, marcarNoUsar, cambiarReferencia, listarSinHabitual, repasarIngresos, resumen, TARJETAS_POR_DIA
};
