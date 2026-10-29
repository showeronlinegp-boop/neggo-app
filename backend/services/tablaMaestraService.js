// Tabla maestra / vincular productos (nota 107) — PRIMER PASO, sin pantallas.
// Carga en product_mappings todo lo que se puede saber sin que nadie decida nada:
//   1. codigo_proveedor: el SKU sin el prefijo de la app ("PREBB89172" → "89172")
//   2. semillas confirmadas: origen "neggo", sync de Preventas por SKU, códigos de factura e ingresos confirmados
//   3. candidatos sugeridos: por código (PRE + referencia Neggo = SKU, mismo proveedor) y por nombre
//      (trigramas, mismo proveedor) para los productos que hacen el 80 % de la venta
//   4. pack con doble señal (nombre "xN" + costo Odoo ÷ neto ≈ 1/N) y lista de dudosos
//   5. proveedor habitual: el principal de Odoo (vendor_name), nunca una oferta de Precompras
// Después del primer paso:
//   - corregirDatos: saca habituales de Precompras o que no son el principal, y rechaza ofertas de
//     Precompras cruzadas con otro producto
//   - vincularDesdeIngresos: al confirmar un ingreso (y como repaso), cada renglón con oferta web +
//     producto de Odoo queda confirmado. Sentido único: Ingresos alimenta la tabla maestra, pero
//     ningún código de Ingresos lee product_mappings, match_decisiones ni producto_reemplazos.
// Todo entra con active = false: ningún vínculo nuevo mueve precios en Odoo hasta que se activen
// junto con el cambio de priceAlertService (solo el habitual escribe en Odoo).
// Es idempotente: ON CONFLICT DO NOTHING, nunca pisa un vínculo existente.

const pool = require('../config/database');

// Parecido mínimo de nombre (pg_trgm) para proponer un candidato, y cuántos por producto
const MIN_NAME_SIMILARITY = 0.35;
const MAX_NAME_CANDIDATES = 3;
// Porción de la venta que define el "top" y semanas que se miran
const TOP_SALES_SHARE = 0.80;
const TOP_WEEKS = 6;
// Productos de Odoo que no son mercadería (anticipos y pedidos de preventa)
const NOT_MERCHANDISE = ['Down Payment (POS)', 'Pedido Preventa'];
// Pack: tolerancia entre costo Odoo ÷ neto y 1/N
const PACK_TOLERANCE = 0.15;
const PACK_MAX = 500;

// Nombre normalizado para comparar (sin acentos, minúsculas)
const normName = col => `translate(LOWER(${col}), 'áéíóúüàèìòùñ', 'aeiouuaeioun')`;

// "x12", "x 50 un", "X100" → 12, 50, 100. No toma medidas ("40x60", "22 X 29") ni contenidos
// ("x42 hojas", "x 500 ml"): la x va suelta, sin un número antes, y sin unidad de medida después.
const NOT_PACK_UNIT = '(?:hojas?|hjs?|h|ml|cc|lts?|l|gr?s?|kg|cm|mm|mts?|m|w|gb|mah|v)\\b';
const PACK_RE = new RegExp(`(?<!\\d\\s?)(?:^|\\s)x\\s?(\\d{1,3})(?=\\s|$|un|u\\b|pz|pcs)(?!\\s*${NOT_PACK_UNIT})`, 'i');

function packFromName(name) {
    const m = String(name || '').match(PACK_RE);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 2 && n <= PACK_MAX ? n : null;
}

// Cuántas unidades de Odoo entran en la oferta: neto ÷ costo Odoo (≈ N si es un pack), o null
function costRatio(odooCost, offerNet) {
    const cost = Number(odooCost), net = Number(offerNet);
    if (!(cost > 0) || !(net > 0)) return null;
    return net / cost;
}

// Decide el pack con las dos señales:
//   el nombre dice N y el costo da ≈ N (±15 %)       → pack N
//   el nombre dice N y el costo da ≈ 1               → Odoo vende el mismo pack: 1
//   el nombre dice N y el costo no da ni 1 ni N      → dudoso
//   sin N en el nombre pero el costo da 2 o más veces → dudoso
function decidirPack(nombreN, ratio) {
    if (nombreN && ratio && Math.abs(ratio - nombreN) / nombreN <= PACK_TOLERANCE) {
        return { cantidad: nombreN, origen: 'ambos' };
    }
    if (nombreN && ratio && Math.abs(ratio - 1) <= PACK_TOLERANCE) {
        return { cantidad: 1, origen: 'costo' };
    }
    if (nombreN || (ratio && ratio >= 2 - PACK_TOLERANCE && ratio <= PACK_MAX)) {
        return { cantidad: 1, origen: 'dudoso' };
    }
    return null;
}

// 1. codigo_proveedor = SKU sin "PRE" + prefijo (y sin "NEG" en las ofertas de origen neggo)
async function backfillCodigoProveedor(db) {
    const { rowCount } = await db.query(
        `UPDATE supplier_products sp
         SET codigo_proveedor = CASE
                 WHEN sp.source = 'neggo' THEN regexp_replace(substr(UPPER(sp.sku), length('PRE' || s.prefix) + 1), '^NEG', '')
                 ELSE substr(UPPER(sp.sku), length('PRE' || s.prefix) + 1)
             END
         FROM suppliers s
         WHERE s.id = sp.supplier_id
           AND sp.codigo_proveedor IS NULL
           AND UPPER(sp.sku) LIKE 'PRE' || UPPER(s.prefix) || '_%'`
    );
    return rowCount;
}

// 2. Semillas: vínculos que ya existen en la app por construcción o porque alguien los hizo
async function cargarSemillas(db) {
    const res = {};

    // Origen "neggo": la oferta sale del mismo producto de Odoo Neggo
    res.semilla_neggo = (await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo, confirmado_at)
         SELECT sp.id, sp.neggo_odoo_id, 'neggo', opc.internal_ref,
                'semilla', 1.0, false, 'confirmado', 'semilla_neggo', NOW()
         FROM supplier_products sp
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = sp.neggo_odoo_id AND opc.company = 'neggo'
         WHERE sp.source = 'neggo' AND sp.neggo_odoo_id IS NOT NULL
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`
    )).rowCount;

    // Sync de Preventas: por SKU o código de barras es el mismo producto (el sync lo creó desde la oferta).
    // Por nombre queda sugerido.
    res.semilla_preventas = (await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo, confirmado_at)
         SELECT pss.supplier_product_id, pss.odoo_product_id, 'preventas', opc.internal_ref,
                'semilla', ROUND(COALESCE(pss.match_score, 100) / 100.0, 2), false,
                CASE WHEN pss.match_type IN ('exact_sku', 'barcode') THEN 'confirmado' ELSE 'sugerido' END,
                CASE WHEN pss.match_type IN ('exact_sku', 'barcode') THEN 'semilla_preventas' ELSE 'nombre' END,
                CASE WHEN pss.match_type IN ('exact_sku', 'barcode') THEN NOW() END
         FROM preventas_sync_state pss
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
         WHERE pss.supplier_product_id IS NOT NULL AND pss.odoo_product_id IS NOT NULL
           AND pss.match_type IS NOT NULL
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`
    )).rowCount;

    // Códigos de factura vinculados a mano en el Ingreso
    res.factura = (await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
         SELECT DISTINCT ON (sp.id, icm.odoo_product_id, icm.odoo_company)
                sp.id, icm.odoo_product_id, icm.odoo_company, opc.internal_ref,
                'semilla', 1.0, false, 'confirmado', 'factura', icm.created_by, icm.created_at
         FROM invoice_code_mappings icm
         JOIN suppliers s ON s.id = icm.supplier_id
         JOIN supplier_products sp ON sp.supplier_id = icm.supplier_id
              AND UPPER(sp.sku) = 'PRE' || UPPER(s.prefix) || regexp_replace(UPPER(icm.raw_code), '[^A-Z0-9]', '', 'g')
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = icm.odoo_product_id AND opc.company = icm.odoo_company
         ORDER BY sp.id, icm.odoo_product_id, icm.odoo_company, icm.created_at
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`
    )).rowCount;

    // Ítems de ingresos confirmados con oferta y producto de Odoo
    res.ingreso = (await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
         SELECT DISTINCT ON (ii.supplier_product_id, ii.odoo_product_id, COALESCE(ii.odoo_company, 'neggo'))
                ii.supplier_product_id, ii.odoo_product_id, COALESCE(ii.odoo_company, 'neggo'), opc.internal_ref,
                'semilla', 1.0, false, 'confirmado', 'ingreso', ii.checked_by, COALESCE(ii.checked_at, im.created_at)
         FROM ingreso_items ii
         JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
         JOIN supplier_products sp ON sp.id = ii.supplier_product_id AND sp.source = 'web'
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ii.odoo_product_id
              AND opc.company = COALESCE(ii.odoo_company, 'neggo')
         WHERE im.estado = 'confirmado' AND ii.estado_item = 'matched'
           AND ii.supplier_product_id IS NOT NULL AND ii.odoo_product_id IS NOT NULL
         ORDER BY ii.supplier_product_id, ii.odoo_product_id, COALESCE(ii.odoo_company, 'neggo'), im.created_at DESC
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`
    )).rowCount;

    return res;
}

// Productos de Neggo que hacen el 80 % de la venta de las últimas semanas (sin anticipos)
async function crearTopVentas(db) {
    await db.query(`DROP TABLE IF EXISTS tmp_top_ventas`);
    await db.query(
        `CREATE TEMP TABLE tmp_top_ventas AS
         WITH ventas AS (
             SELECT psw.odoo_id, SUM(psw.amount_total) AS monto
             FROM product_sales_weekly psw
             JOIN odoo_products_cache opc ON opc.odoo_id = psw.odoo_id AND opc.company = 'neggo'
             WHERE psw.company = 'neggo'
               AND psw.week_start > (SELECT MAX(week_start) FROM product_sales_weekly) - ($1::int * 7)
               AND opc.name <> ALL($2::text[])
             GROUP BY psw.odoo_id
             HAVING SUM(psw.amount_total) > 0
         ), acum AS (
             SELECT odoo_id, monto,
                    SUM(monto) OVER (ORDER BY monto DESC, odoo_id) AS acumulado,
                    SUM(monto) OVER () AS total
             FROM ventas
         )
         SELECT odoo_id, monto FROM acum
         WHERE acumulado - monto < total * $3`,
        [TOP_WEEKS, NOT_MERCHANDISE, TOP_SALES_SHARE]
    );
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM tmp_top_ventas`);
    return rows[0].n;
}

// 3a. Candidatos por código: 'PRE' + referencia Neggo sin símbolos = SKU, dentro del mismo proveedor.
// Incluye archivados. Quedan sugeridos para el lote de confirmación.
async function candidatosPorCodigo(db) {
    const { rowCount } = await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo)
         SELECT sp.id, opc.odoo_id, 'neggo', opc.internal_ref, 'codigo', 1.0, false, 'sugerido', 'codigo'
         FROM odoo_products_cache opc
         JOIN suppliers s ON s.name = opc.vendor_name
         JOIN supplier_products sp ON sp.supplier_id = s.id AND sp.source = 'web'
              AND UPPER(sp.sku) = 'PRE' || regexp_replace(UPPER(opc.internal_ref), '[^A-Z0-9]', '', 'g')
         WHERE opc.company = 'neggo' AND COALESCE(opc.internal_ref, '') <> ''
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`
    );
    return rowCount;
}

// 3b. Candidatos por nombre para el top que todavía no tiene ninguna oferta de su proveedor,
// solo dentro del mismo proveedor (vendor_name) y nunca un par ya rechazado.
async function candidatosPorNombre(db) {
    const { rowCount } = await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo)
         SELECT supplier_product_id, odoo_id, 'neggo', internal_ref, 'nombre', ROUND(sim::numeric, 2), false, 'sugerido', 'nombre'
         FROM (
             SELECT sp.id AS supplier_product_id, opc.odoo_id, opc.internal_ref,
                    similarity(${normName('sp.name')}, ${normName('opc.name')}) AS sim,
                    ROW_NUMBER() OVER (
                        PARTITION BY opc.odoo_id
                        ORDER BY similarity(${normName('sp.name')}, ${normName('opc.name')}) DESC, sp.available DESC, sp.id
                    ) AS orden
             FROM tmp_top_ventas t
             JOIN odoo_products_cache opc ON opc.odoo_id = t.odoo_id AND opc.company = 'neggo'
             JOIN suppliers s ON s.name = opc.vendor_name
             JOIN supplier_products sp ON sp.supplier_id = s.id AND sp.source = 'web'
             WHERE NOT EXISTS (
                     SELECT 1 FROM product_mappings pm
                     JOIN supplier_products sp2 ON sp2.id = pm.supplier_product_id
                     WHERE pm.odoo_product_id = opc.odoo_id AND pm.odoo_company = 'neggo'
                       AND sp2.supplier_id = s.id AND pm.estado <> 'rechazado')
               AND NOT EXISTS (
                     SELECT 1 FROM match_decisiones md
                     WHERE md.supplier_product_id = sp.id AND md.odoo_product_id = opc.odoo_id
                       AND md.odoo_company = 'neggo' AND md.decision = 'rechazado')
               AND similarity(${normName('sp.name')}, ${normName('opc.name')}) >= $1
         ) c
         WHERE orden <= $2
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`,
        [MIN_NAME_SIMILARITY, MAX_NAME_CANDIDATES]
    );
    return rowCount;
}

// 4. Pack de las ofertas web vinculadas: la señal de costo sale del mejor vínculo de la oferta
// (confirmado o por código). Sin vínculo no hay segunda señal y el pack queda sin decidir.
async function detectarPacks(db) {
    const { rows } = await db.query(
        `SELECT DISTINCT ON (sp.id)
                sp.id, s.name AS proveedor, sp.sku, sp.name, sp.raw_price,
                ROUND(sp.raw_price * (1 - COALESCE(r.discount_override, s.default_discount, 0) / 100.0), 2) AS neto,
                opc.odoo_id, opc.name AS odoo_name, opc.standard_price
         FROM supplier_products sp
         JOIN suppliers s ON s.id = sp.supplier_id
         LEFT JOIN supplier_category_rules r
                ON r.supplier_id = sp.supplier_id AND r.source_category = sp.source_category AND r.active
         JOIN product_mappings pm ON pm.supplier_product_id = sp.id AND pm.odoo_company = 'neggo'
                AND (pm.estado = 'confirmado' OR pm.metodo = 'codigo')
         JOIN odoo_products_cache opc ON opc.odoo_id = pm.odoo_product_id AND opc.company = 'neggo'
         WHERE sp.source = 'web' AND sp.pack_origen IS NULL AND sp.raw_price > 0
         ORDER BY sp.id, (pm.estado = 'confirmado') DESC, pm.id`
    );

    const resultado = { ambos: 0, mismo_pack_que_odoo: 0, dudosos: [] };
    for (const row of rows) {
        const nombreN = packFromName(row.name);
        const ratio = costRatio(row.standard_price, row.neto);
        const pack = decidirPack(nombreN, ratio);
        if (!pack) continue;
        await db.query(
            'UPDATE supplier_products SET pack_cantidad = $1, pack_origen = $2 WHERE id = $3',
            [pack.cantidad, pack.origen, row.id]
        );
        if (pack.origen === 'ambos') resultado.ambos++;
        else if (pack.origen === 'costo') resultado.mismo_pack_que_odoo++;
        else resultado.dudosos.push({
            supplier_product_id: row.id, proveedor: row.proveedor, sku: row.sku, nombre: row.name,
            pack_por_nombre: nombreN, neto_sobre_costo: ratio === null ? null : Math.round(ratio * 100) / 100,
            neto: row.neto, odoo_id: row.odoo_id, odoo_nombre: row.odoo_name, costo_odoo: row.standard_price
        });
    }
    return resultado;
}

// 5. Habitual (máximo uno por producto y empresa), solo entre confirmados: la oferta del proveedor
//    principal de Odoo. Precompras (origen "neggo") nunca es habitual: es la base de costos, no un
//    precio de proveedor. Preventas tampoco: sus vínculos (activos y archivados) son solo un dato
//    para saber de dónde viene cada producto de Neggo. Los ingresos no deciden el habitual
//    (vincular no es elegir a quién comprar).
async function marcarHabituales(db) {
    const porOdoo = (await db.query(
        `UPDATE product_mappings pm SET es_habitual = true
         FROM (
             SELECT DISTINCT ON (pm2.odoo_product_id, pm2.odoo_company) pm2.id
             FROM product_mappings pm2
             JOIN supplier_products sp ON sp.id = pm2.supplier_product_id
             JOIN suppliers s ON s.id = sp.supplier_id
             JOIN odoo_products_cache opc ON opc.odoo_id = pm2.odoo_product_id AND opc.company = pm2.odoo_company
             WHERE pm2.estado = 'confirmado' AND pm2.odoo_company = 'neggo'
               AND opc.vendor_name = s.name AND sp.source <> 'neggo'
               AND NOT EXISTS (SELECT 1 FROM product_mappings h
                               WHERE h.odoo_product_id = pm2.odoo_product_id
                                 AND h.odoo_company = pm2.odoo_company AND h.es_habitual)
             ORDER BY pm2.odoo_product_id, pm2.odoo_company, sp.available DESC, pm2.confirmado_at DESC NULLS LAST, pm2.id
         ) elegido
         WHERE pm.id = elegido.id`
    )).rowCount;

    return { porOdoo };
}

// Casos para mirar: una oferta propuesta para varios productos, o un producto con varias ofertas
// del mismo proveedor por código
async function sospechososPorCodigo(db) {
    const { rows } = await db.query(
        `SELECT 'oferta_en_varios_productos' AS caso, sp.sku, MIN(sp.name) AS nombre,
                array_agg(pm.odoo_product_id ORDER BY pm.odoo_product_id) AS odoo_ids
         FROM product_mappings pm JOIN supplier_products sp ON sp.id = pm.supplier_product_id
         WHERE pm.metodo = 'codigo' AND pm.estado = 'sugerido'
         GROUP BY sp.sku HAVING COUNT(*) > 1
         UNION ALL
         SELECT 'producto_con_varias_ofertas', MIN(opc.internal_ref), MIN(opc.name), array_agg(pm.supplier_product_id)
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id
         JOIN odoo_products_cache opc ON opc.odoo_id = pm.odoo_product_id AND opc.company = 'neggo'
         WHERE pm.metodo = 'codigo' AND pm.estado = 'sugerido'
         GROUP BY pm.odoo_product_id, sp.supplier_id HAVING COUNT(*) > 1`
    );
    return rows;
}

// Métrica del plan: % del top con alguna oferta disponible vinculada (confirmada) o propuesta
async function medirCobertura(db) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS top,
                COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM product_mappings pm JOIN supplier_products sp ON sp.id = pm.supplier_product_id
                    WHERE pm.odoo_product_id = t.odoo_id AND pm.odoo_company = 'neggo'
                      AND pm.estado = 'confirmado' AND sp.available))::int AS con_confirmado,
                COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM product_mappings pm JOIN supplier_products sp ON sp.id = pm.supplier_product_id
                    WHERE pm.odoo_product_id = t.odoo_id AND pm.odoo_company = 'neggo'
                      AND pm.estado <> 'rechazado' AND sp.available))::int AS con_confirmado_o_sugerido
         FROM tmp_top_ventas t`
    );
    return rows[0];
}

/**
 * Corre el PRIMER PASO completo en una transacción.
 * @param {{ aplicar?: boolean }} opts — sin aplicar hace todo y deshace (ROLLBACK) al final
 */
async function primerPaso({ aplicar = false } = {}) {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const { rows: antes } = await db.query(
            `SELECT (SELECT COUNT(*) FROM product_mappings WHERE active)::int AS vinculos_activos,
                    (SELECT COUNT(*) FROM supplier_products)::int AS ofertas`
        );

        const resumen = { aplicado: aplicar };
        resumen.codigo_proveedor = await backfillCodigoProveedor(db);
        resumen.semillas = await cargarSemillas(db);
        resumen.top_productos = await crearTopVentas(db);
        resumen.candidatos_codigo = await candidatosPorCodigo(db);
        resumen.candidatos_nombre = await candidatosPorNombre(db);
        const packs = await detectarPacks(db);
        resumen.packs = { ambos: packs.ambos, mismo_pack_que_odoo: packs.mismo_pack_que_odoo, dudosos: packs.dudosos.length };
        resumen.habituales = await marcarHabituales(db);
        resumen.cobertura_top = await medirCobertura(db);

        const { rows: despues } = await db.query(
            `SELECT (SELECT COUNT(*) FROM product_mappings WHERE active)::int AS vinculos_activos,
                    (SELECT COUNT(*) FROM supplier_products)::int AS ofertas`
        );
        // Control: ningún vínculo activo nuevo y ninguna oferta perdida
        if (despues[0].vinculos_activos !== antes[0].vinculos_activos || despues[0].ofertas !== antes[0].ofertas) {
            throw new Error(`Control fallido: antes ${JSON.stringify(antes[0])}, después ${JSON.stringify(despues[0])}`);
        }
        resumen.control = { antes: antes[0], despues: despues[0] };

        const { rows: porMetodo } = await db.query(
            `SELECT odoo_company, metodo, estado, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE es_habitual)::int AS habituales
             FROM product_mappings GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
        );
        resumen.vinculos_por_metodo = porMetodo;

        const detalle = { packs_dudosos: packs.dudosos, sospechosos_codigo: await sospechososPorCodigo(db) };

        await db.query(aplicar ? 'COMMIT' : 'ROLLBACK');
        console.log(aplicar ? '✅ Primer paso aplicado' : '⚠️ Prueba sin aplicar: se deshizo todo (ROLLBACK)');
        return { resumen, detalle };
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('❌ Error en el primer paso de la tabla maestra:', err.message);
        throw err;
    } finally {
        db.release();
    }
}

// =============================================
// Corrección de datos de la carga inicial (nota 107, 29/10)
// =============================================

/**
 * Deja la carga inicial con las definiciones nuevas. Todo está inactivo: no mueve precios.
 *   1. Precompras (origen "neggo") no es habitual ni en Neggo ni en Preventas
 *   2. El habitual es el principal de Odoo: se saca el que salió por ingreso
 *   3. Una oferta de Precompras sale de un producto de Odoo: cruzada con OTRO producto de Neggo es
 *      un error o un duplicado de Odoo → rechazada (ej. "Abrochadora 207" → "Abrochadora nº 10 Art. 260")
 * @param {{ aplicar?: boolean }} opts — sin aplicar hace todo y deshace (ROLLBACK)
 */
async function corregirDatos({ aplicar = false } = {}) {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const resumen = { aplicado: aplicar };

        resumen.habitual_precompras = (await db.query(
            `UPDATE product_mappings pm SET es_habitual = false
             FROM supplier_products sp
             WHERE sp.id = pm.supplier_product_id AND sp.source = 'neggo' AND pm.es_habitual
             RETURNING pm.odoo_company`
        )).rows.reduce((acc, r) => ({ ...acc, [r.odoo_company]: (acc[r.odoo_company] || 0) + 1 }), {});

        // Preventas es solo un dato de origen: no lleva habitual
        resumen.habitual_preventas = (await db.query(
            `UPDATE product_mappings SET es_habitual = false
             WHERE odoo_company = 'preventas' AND es_habitual`
        )).rowCount;

        resumen.habitual_no_principal = (await db.query(
            `UPDATE product_mappings pm SET es_habitual = false
             FROM supplier_products sp, suppliers s
             WHERE sp.id = pm.supplier_product_id AND s.id = sp.supplier_id AND pm.es_habitual
               AND NOT EXISTS (SELECT 1 FROM odoo_products_cache opc
                               WHERE opc.odoo_id = pm.odoo_product_id AND opc.company = pm.odoo_company
                                 AND opc.vendor_name = s.name)`
        )).rowCount;

        const { rows: cruzados } = await db.query(
            `UPDATE product_mappings pm
             SET estado = 'rechazado', active = false, es_habitual = false
             FROM supplier_products sp
             WHERE sp.id = pm.supplier_product_id AND sp.source = 'neggo'
               AND pm.odoo_company = 'neggo' AND pm.estado <> 'rechazado'
               AND pm.odoo_product_id IS DISTINCT FROM sp.neggo_odoo_id
             RETURNING pm.supplier_product_id, pm.odoo_product_id, pm.odoo_company, pm.metodo`
        );
        for (const c of cruzados) {
            await db.query(
                `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo)
                 VALUES ($1, $2, $3, 'rechazado', $4)`,
                [c.supplier_product_id, c.odoo_product_id, c.odoo_company, c.metodo]
            );
        }
        resumen.precompras_cruzadas_rechazadas = cruzados.length;

        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS activos FROM product_mappings WHERE active`
        );
        if (rows[0].activos !== 0) throw new Error(`Control fallido: hay ${rows[0].activos} vínculos activos`);

        await db.query(aplicar ? 'COMMIT' : 'ROLLBACK');
        console.log(aplicar ? '✅ Corrección de datos aplicada' : '⚠️ Prueba sin aplicar: se deshizo todo (ROLLBACK)');
        return resumen;
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('❌ Error en la corrección de datos de la tabla maestra:', err.message);
        throw err;
    } finally {
        db.release();
    }
}

// =============================================
// Ingresos → tabla maestra (sentido único)
// =============================================

// Los vínculos nuevos nacen inactivos hasta la activación del MVP (habitual + priceAlertService)
const ACTIVO_AL_CREAR = false;

// Un renglón es "hecho a mano" si una persona eligió el producto de Odoo o la oferta
function esRenglonManual(item) {
    return item.match_level === 'manual' || item.supplier_match_level === 'manual';
}

// Método con el que queda el vínculo, para medir el acierto por separado
function metodoDesdeIngreso(item) {
    if (esRenglonManual(item)) return 'ingreso_manual';
    if (item.supplier_match_level === 'fuzzy') return 'ingreso_nombre';
    return 'ingreso';
}

/**
 * Crea o confirma en product_mappings los vínculos de los ingresos confirmados.
 * Se llama al confirmar un ingreso con { supplierId } (ese ingreso + repaso de los anteriores del
 * mismo proveedor) y a mano desde scripts/tablaMaestra.js.
 * Reglas:
 *   - Solo Neggo y ofertas web (Precompras es base de costos, no se vincula).
 *   - Renglón manual: solo si se tildó en la revisión (vinculo_revisado_at).
 *   - Oferta borrada por el scraper (quedó NULL): si era por código, se busca de nuevo por SKU.
 *   - Sugerido → confirmado (se anota el acierto del método que lo propuso).
 *   - Rechazado antes de confirmar el ingreso → gana el ingreso. Rechazado después ("Borrar
 *     vinculación") → se respeta y no se vuelve a crear.
 *   - No toca es_habitual.
 * @param {{ ingresoId?: number, supplierId?: number, userId?: number }} opts
 * @returns {Promise<{ renglones: number, creados: number, confirmados: number, sin_cambios: number, conflictos: number }>}
 */
async function vincularDesdeIngresos({ ingresoId = null, supplierId = null, userId = null } = {}) {
    if (!ingresoId && !supplierId) throw new Error('Falta ingresoId o supplierId');
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const { rows: candidatos } = await db.query(
            `SELECT DISTINCT ON (c.supplier_product_id, c.odoo_product_id) c.*
             FROM (
                 SELECT ii.id AS item_id, ii.odoo_product_id, ii.match_level, ii.supplier_match_level,
                        ii.vinculo_revisado_at, im.confirmed_at,
                        COALESCE(ii.vinculo_revisado_por, im.confirmed_by_user_id, $3) AS user_id,
                        COALESCE(ii.supplier_product_id, rec.id) AS supplier_product_id
                 FROM ingreso_items ii
                 JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id AND im.estado = 'confirmado'
                 JOIN suppliers s ON s.id = im.supplier_id
                 LEFT JOIN LATERAL (
                     SELECT sp.id FROM supplier_products sp
                     WHERE ii.supplier_product_id IS NULL AND ii.supplier_match_level = 'exact_code'
                       AND sp.supplier_id = im.supplier_id AND sp.source = 'web'
                       AND regexp_replace(UPPER(sp.sku), '[^A-Z0-9]', '', 'g')
                           = 'PRE' || UPPER(COALESCE(s.prefix, '')) || regexp_replace(UPPER(ii.codigo), '[^A-Z0-9]', '', 'g')
                     ORDER BY sp.available DESC, sp.id DESC
                     LIMIT 1
                 ) rec ON true
                 WHERE ii.estado_item = 'matched' AND ii.odoo_product_id IS NOT NULL
                   AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'
                   -- Renglón manual: solo si se tildó en la revisión
                   AND (ii.vinculo_revisado_at IS NOT NULL
                        OR (COALESCE(ii.match_level, '') <> 'manual' AND COALESCE(ii.supplier_match_level, '') <> 'manual'))
                   AND ($1::int IS NULL OR im.id = $1)
                   AND ($2::int IS NULL OR im.supplier_id = $2)
             ) c
             JOIN supplier_products sp ON sp.id = c.supplier_product_id AND sp.source = 'web'
             WHERE NOT EXISTS (
                 SELECT 1 FROM match_decisiones md
                 WHERE md.supplier_product_id = c.supplier_product_id AND md.odoo_product_id = c.odoo_product_id
                   AND md.odoo_company = 'neggo' AND md.decision = 'rechazado'
                   AND md.created_at > COALESCE(c.confirmed_at, '-infinity'))
             ORDER BY c.supplier_product_id, c.odoo_product_id, c.confirmed_at DESC NULLS LAST, c.item_id DESC`,
            [ingresoId, supplierId, userId]
        );

        const resultado = { renglones: 0, creados: 0, confirmados: 0, sin_cambios: 0, conflictos: 0 };
        for (const c of candidatos) {
            resultado.renglones++;
            const metodo = metodoDesdeIngreso(c);
            const { rows: previo } = await db.query(
                `SELECT id, estado, metodo, match_confidence FROM product_mappings
                 WHERE supplier_product_id = $1 AND odoo_product_id = $2 AND odoo_company = 'neggo'`,
                [c.supplier_product_id, c.odoo_product_id]
            );
            if (previo[0]?.estado === 'confirmado') { resultado.sin_cambios++; continue; }

            if (previo.length === 0) {
                await db.query(
                    `INSERT INTO product_mappings
                        (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                         match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
                     SELECT $1, $2, 'neggo', opc.internal_ref, 'ingreso', 1.0, $3, 'confirmado', $4, $5, NOW()
                     FROM (SELECT 1) x
                     LEFT JOIN odoo_products_cache opc ON opc.odoo_id = $2 AND opc.company = 'neggo'
                     ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO NOTHING`,
                    [c.supplier_product_id, c.odoo_product_id, ACTIVO_AL_CREAR, metodo, c.user_id]
                );
                resultado.creados++;
                continue;
            }

            // Sugerido o rechazado antes del ingreso → confirmado. El acierto cuenta para el método
            // que lo había propuesto (sugerido) o para el del ingreso (rechazado).
            const p = previo[0];
            await db.query(
                `UPDATE product_mappings SET estado = 'confirmado', metodo = $2, confirmado_por = $3, confirmado_at = NOW()
                 WHERE id = $1`,
                [p.id, metodo, c.user_id]
            );
            await db.query(
                `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
                 VALUES ($1, $2, 'neggo', 'confirmado', $3, $4, $5)`,
                [c.supplier_product_id, c.odoo_product_id, p.estado === 'sugerido' ? p.metodo : metodo,
                 p.match_confidence, c.user_id]
            );
            resultado.confirmados++;
        }

        resultado.conflictos = (await listarConflictos(db)).length;
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
 * "Borrar vinculación" de un renglón del Ingreso: el par queda rechazado en la tabla maestra
 * para que el repaso no lo vuelva a crear. Si el par no existía, igual queda la decisión.
 */
async function rechazarVinculo({ supplierProductId, odooProductId, odooCompany = 'neggo', userId = null }) {
    const { rows } = await pool.query(
        `UPDATE product_mappings SET estado = 'rechazado', active = false, es_habitual = false
         WHERE supplier_product_id = $1 AND odoo_product_id = $2 AND odoo_company = $3
         RETURNING metodo, match_confidence`,
        [supplierProductId, odooProductId, odooCompany]
    );
    await pool.query(
        `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
         VALUES ($1, $2, $3, 'rechazado', $4, $5, $6)`,
        [supplierProductId, odooProductId, odooCompany, rows[0]?.metodo || 'ingreso', rows[0]?.match_confidence ?? null, userId]
    );
    return { rechazado: rows.length > 0 };
}

/**
 * Conflictos: una oferta web confirmada con dos o más productos distintos de Neggo
 * (ej. Impotekno W1702 → Pava Dinax y Jarra Winco). No se borra nada: es para revisar.
 */
async function listarConflictos(db = pool) {
    const { rows } = await db.query(
        `SELECT sp.id AS supplier_product_id, s.name AS proveedor, sp.sku, sp.name,
                array_agg(pm.odoo_product_id ORDER BY pm.odoo_product_id) AS odoo_ids
         FROM product_mappings pm
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
         JOIN suppliers s ON s.id = sp.supplier_id
         WHERE pm.odoo_company = 'neggo' AND pm.estado = 'confirmado'
         GROUP BY sp.id, s.name
         HAVING COUNT(DISTINCT pm.odoo_product_id) > 1
         ORDER BY s.name, sp.sku`
    );
    return rows;
}

module.exports = {
    primerPaso, corregirDatos, vincularDesdeIngresos, rechazarVinculo, listarConflictos, marcarHabituales,
    packFromName, costRatio, decidirPack, esRenglonManual, metodoDesdeIngreso
};
