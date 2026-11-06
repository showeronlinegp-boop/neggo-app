// Vínculos en la tarjeta de Ingreso (nota 162). Muestra si el producto de Odoo ya está vinculado con
// una oferta del proveedor del ingreso y deja generar el vínculo desde ahí:
//   - Código exacto: se vincula solo, con opción de deshacer.
//   - Todo lo demás: lo elige una persona (sugerencia o búsqueda entre las ofertas del proveedor).
// Es de sentido único: esto no alimenta el cruce de facturas (matchItems) ni precarga la oferta del
// renglón. Solo Neggo y ofertas web. Nada de esto escribe en Odoo.

const pool = require('../config/database');
const { normalize, similarity } = require('./ingresoService');
const { recalcularHabituales } = require('./tablaMaestraService');

const METODO_CODIGO = 'ingreso_codigo';
const METODO_ELEGIDO = 'ingreso_elegido';
// Solo se deshace desde el ingreso lo que se generó desde el ingreso
const METODOS_DESHACER = new Set([METODO_CODIGO, METODO_ELEGIDO]);

const MAX_SUGERENCIAS = 5;
const MAX_RESULTADOS = 30;
const PARECIDO_MINIMO = 0.45;
const TOLERANCIA_PRECIO = 0.01;
// Mismo precio que la factura: pesa, pero no alcanza solo para aparecer
const BONUS_PRECIO = 0.2;

// Error con el estado HTTP que tiene que devolver la ruta
function errorCon(status, mensaje) {
    const err = new Error(mensaje);
    err.status = status;
    return err;
}

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
 * Qué tan probable es que la oferta sea el artículo del renglón.
 * @param {{ descripcion?: string, odoo_product_name?: string, precio_unitario?: number|string }} item
 * @param {{ name?: string, raw_price?: number|string }} oferta
 * @returns {{ parecido: number, mismo_precio: boolean, puntaje: number }}
 */
function puntuarOferta(item, oferta) {
    const nombre = normalize(oferta.name);
    const parecido = Math.max(
        similarity(normalize(item.descripcion), nombre),
        similarity(normalize(item.odoo_product_name), nombre)
    );
    const precio = parseFloat(item.precio_unitario);
    const lista = parseFloat(oferta.raw_price);
    const mismoPrecio = precio > 0 && lista > 0 && Math.abs(lista - precio) / precio <= TOLERANCIA_PRECIO;
    return {
        parecido: Math.round(parecido * 100) / 100,
        mismo_precio: mismoPrecio,
        puntaje: parecido + (mismoPrecio ? BONUS_PRECIO : 0),
    };
}

// Todas las palabras buscadas tienen que estar en el nombre o el SKU, en cualquier orden
function coincideBusqueda(oferta, q) {
    const texto = `${normalize(oferta.name)} ${normalize(oferta.sku)}`;
    return normalize(q).split(' ').filter(Boolean).every(palabra => texto.includes(palabra));
}

/**
 * Arma la lista de ofertas de un renglón. Las agotadas entran: el vínculo correcto puede ser una.
 * Sin búsqueda son sugerencias (parecidas y nunca rechazadas); con búsqueda, todo lo que coincida.
 */
function elegirOfertas(item, ofertas, q = '') {
    const buscando = normalize(q).length > 0;
    const puntuadas = ofertas
        .filter(o => (buscando ? coincideBusqueda(o, q) : !o.rechazada))
        .map(o => ({ ...o, ...puntuarOferta(item, o) }));
    const lista = buscando
        ? puntuadas
        : puntuadas.filter(o => o.parecido >= PARECIDO_MINIMO);
    return lista
        .sort((a, b) => b.puntaje - a.puntaje)
        .slice(0, buscando ? MAX_RESULTADOS : MAX_SUGERENCIAS);
}

// Oferta confirmada del proveedor del ingreso para cada renglón (primero la habitual)
async function vinculosDelIngreso(ingresoId, db = pool) {
    const { rows } = await db.query(
        `SELECT ii.id AS item_id, v.*
         FROM ingreso_items ii
         JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
         JOIN LATERAL (
             SELECT pm.metodo, pm.es_habitual, sp.id AS supplier_product_id, sp.sku, sp.name,
                    sp.raw_price, sp.available, sp.image_url
             FROM product_mappings pm
             JOIN supplier_products sp ON sp.id = pm.supplier_product_id
             WHERE pm.odoo_product_id = ii.odoo_product_id AND pm.odoo_company = 'neggo'
               AND pm.estado = 'confirmado' AND sp.supplier_id = im.supplier_id AND sp.source = 'web'
             ORDER BY pm.es_habitual DESC, sp.available DESC, pm.confirmado_at DESC NULLS LAST, pm.id
             LIMIT 1
         ) v ON true
         WHERE ii.ingreso_id = $1 AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'`,
        [ingresoId]
    );
    const mapa = new Map();
    for (const { item_id: itemId, ...vinculo } of rows) {
        mapa.set(itemId, { ...vinculo, puede_deshacer: METODOS_DESHACER.has(vinculo.metodo) });
    }
    return mapa;
}

// Confirma el par y anota la decisión. Devuelve false si ya estaba confirmado.
async function confirmarPar(db, { supplierProductId, odooProductId, metodo, userId }) {
    const { rows: previo } = await db.query(
        `SELECT estado, metodo, match_confidence FROM product_mappings
         WHERE supplier_product_id = $1 AND odoo_product_id = $2 AND odoo_company = 'neggo'`,
        [supplierProductId, odooProductId]
    );
    if (previo[0]?.estado === 'confirmado') return false;

    const { rowCount } = await db.query(
        `INSERT INTO product_mappings
            (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
             match_type, match_confidence, active, estado, metodo, confirmado_por, confirmado_at)
         SELECT $1::int, $2::int, 'neggo', opc.internal_ref, 'ingreso', 1.0, false, 'confirmado', $3::varchar, $4::int, NOW()
         FROM (SELECT 1) x
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = $2::int AND opc.company = 'neggo'
         ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO UPDATE
            SET estado = 'confirmado', metodo = EXCLUDED.metodo,
                confirmado_por = EXCLUDED.confirmado_por, confirmado_at = NOW()
            WHERE product_mappings.estado <> 'confirmado'`,
        [supplierProductId, odooProductId, metodo, userId]
    );
    if (rowCount === 0) return false;

    // El acierto de un sugerido cuenta para el método que lo había propuesto
    await db.query(
        `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
         VALUES ($1, $2, 'neggo', 'confirmado', $3, $4, $5)`,
        [supplierProductId, odooProductId,
         previo[0]?.estado === 'sugerido' ? previo[0].metodo : metodo,
         previo[0]?.match_confidence ?? 1.0, userId]
    );
    return true;
}

/**
 * Vincula solos los renglones de un ingreso sin confirmar cuya oferta salió por código exacto.
 * No vincula si el producto ya tiene vínculo con este proveedor, si el par se rechazó alguna vez
 * (por ejemplo con "Deshacer") o si la oferta ya es de otro producto: eso lo decide una persona.
 * @returns {Promise<{ creados: number }>}
 */
async function vincularExactos(ingresoId, userId) {
    return enTransaccion(async (db) => {
        const { rows } = await db.query(
            `SELECT DISTINCT ON (ii.odoo_product_id) ii.odoo_product_id, ii.supplier_product_id
             FROM ingreso_items ii
             JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id AND im.estado = 'pending'
             JOIN supplier_products sp ON sp.id = ii.supplier_product_id
              AND sp.source = 'web' AND sp.supplier_id = im.supplier_id
             WHERE ii.ingreso_id = $1 AND ii.estado_item = 'matched' AND ii.odoo_product_id IS NOT NULL
               AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'
               AND ii.supplier_match_level = 'exact_code'
               AND NOT EXISTS (
                   SELECT 1 FROM product_mappings pm
                   JOIN supplier_products sp2 ON sp2.id = pm.supplier_product_id
                   WHERE pm.odoo_product_id = ii.odoo_product_id AND pm.odoo_company = 'neggo'
                     AND pm.estado = 'confirmado' AND sp2.supplier_id = im.supplier_id AND sp2.source = 'web')
               AND NOT EXISTS (
                   SELECT 1 FROM product_mappings pm
                   WHERE pm.supplier_product_id = ii.supplier_product_id AND pm.odoo_company = 'neggo'
                     AND pm.estado = 'confirmado' AND pm.odoo_product_id <> ii.odoo_product_id)
               AND NOT EXISTS (
                   SELECT 1 FROM product_mappings pm
                   WHERE pm.supplier_product_id = ii.supplier_product_id AND pm.odoo_product_id = ii.odoo_product_id
                     AND pm.odoo_company = 'neggo' AND pm.estado = 'rechazado')
               AND NOT EXISTS (
                   SELECT 1 FROM match_decisiones md
                   WHERE md.supplier_product_id = ii.supplier_product_id AND md.odoo_product_id = ii.odoo_product_id
                     AND md.odoo_company = 'neggo' AND md.decision = 'rechazado')
             ORDER BY ii.odoo_product_id, ii.id`,
            [ingresoId]
        );

        let creados = 0;
        const ofertasUsadas = new Set();
        for (const r of rows) {
            // Dos productos con la misma oferta en este ingreso: el segundo queda para una persona
            if (ofertasUsadas.has(r.supplier_product_id)) continue;
            ofertasUsadas.add(r.supplier_product_id);
            const creado = await confirmarPar(db, {
                supplierProductId: r.supplier_product_id,
                odooProductId: r.odoo_product_id,
                metodo: METODO_CODIGO,
                userId,
            });
            if (creado) creados++;
        }
        if (creados > 0) await recalcularHabituales(db);
        return { creados };
    });
}

// Renglón vinculable con su proveedor; tira error con estado HTTP si no se puede
async function renglonVinculable(ingresoId, itemId, db = pool) {
    const { rows } = await db.query(
        `SELECT ii.id, ii.descripcion, ii.precio_unitario, ii.odoo_product_id, ii.odoo_product_name,
                ii.estado_item, COALESCE(ii.odoo_company, 'neggo') AS company, im.supplier_id
         FROM ingreso_items ii
         JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
         WHERE ii.id = $1 AND ii.ingreso_id = $2`,
        [itemId, ingresoId]
    );
    const item = rows[0];
    if (!item) throw errorCon(404, 'Renglón no encontrado');
    if (!item.odoo_product_id || item.estado_item !== 'matched' || item.company !== 'neggo') {
        throw errorCon(400, 'El renglón no tiene un producto de Neggo');
    }
    if (!item.supplier_id) throw errorCon(400, 'El ingreso no tiene proveedor');
    return item;
}

/**
 * Sugerencias (sin q) o búsqueda (con q) entre las ofertas del proveedor del ingreso.
 * @returns {Promise<{ catalogo: number, ofertas: object[] }>} catalogo = ofertas web del proveedor
 */
async function ofertasDeRenglon({ ingresoId, itemId, q = '' }) {
    const item = await renglonVinculable(ingresoId, itemId);
    const { rows } = await pool.query(
        `SELECT sp.id, sp.sku, sp.name, sp.raw_price, sp.available, sp.image_url,
                otro.vinculada_con,
                (EXISTS (SELECT 1 FROM product_mappings pm
                         WHERE pm.supplier_product_id = sp.id AND pm.odoo_product_id = $2
                           AND pm.odoo_company = 'neggo' AND pm.estado = 'rechazado')
                 OR EXISTS (SELECT 1 FROM match_decisiones md
                            WHERE md.supplier_product_id = sp.id AND md.odoo_product_id = $2
                              AND md.odoo_company = 'neggo' AND md.decision = 'rechazado')) AS rechazada
         FROM supplier_products sp
         LEFT JOIN LATERAL (
             SELECT opc.name AS vinculada_con
             FROM product_mappings pm
             LEFT JOIN odoo_products_cache opc ON opc.odoo_id = pm.odoo_product_id AND opc.company = 'neggo'
             WHERE pm.supplier_product_id = sp.id AND pm.odoo_company = 'neggo'
               AND pm.estado = 'confirmado' AND pm.odoo_product_id <> $2
             LIMIT 1
         ) otro ON true
         WHERE sp.supplier_id = $1 AND sp.source = 'web'`,
        [item.supplier_id, item.odoo_product_id]
    );
    return { catalogo: rows.length, ofertas: elegirOfertas(item, rows, q) };
}

/**
 * Una persona eligió la oferta: queda confirmada. Pisa un rechazo anterior porque lo decidió a la
 * vista, pero no agrega una segunda oferta del mismo proveedor. No toca el renglón del ingreso:
 * así no se vuelve a preguntar en la revisión al confirmar.
 */
async function vincularOferta({ ingresoId, itemId, supplierProductId, userId }) {
    return enTransaccion(async (db) => {
        const item = await renglonVinculable(ingresoId, itemId, db);
        const { rows: ofertas } = await db.query(
            `SELECT id FROM supplier_products WHERE id = $1 AND supplier_id = $2 AND source = 'web'`,
            [supplierProductId, item.supplier_id]
        );
        if (ofertas.length === 0) throw errorCon(400, 'La oferta no es del proveedor de este ingreso');

        const actual = (await vinculosDelIngreso(ingresoId, db)).get(item.id);
        if (actual && actual.supplier_product_id !== supplierProductId) {
            throw errorCon(409, 'El producto ya tiene un vínculo con este proveedor');
        }
        await confirmarPar(db, {
            supplierProductId, odooProductId: item.odoo_product_id, metodo: METODO_ELEGIDO, userId,
        });
        await recalcularHabituales(db);
        return { vinculado: true };
    });
}

/**
 * Deshace un vínculo generado desde el ingreso. El par queda rechazado para no volver a crearse
 * solo, y los renglones del ingreso sueltan la oferta para que confirmar tampoco lo cree.
 */
async function deshacerVinculo({ ingresoId, itemId, userId }) {
    return enTransaccion(async (db) => {
        const item = await renglonVinculable(ingresoId, itemId, db);
        const actual = (await vinculosDelIngreso(ingresoId, db)).get(item.id);
        if (!actual) throw errorCon(404, 'El producto no tiene vínculo con este proveedor');
        if (!actual.puede_deshacer) {
            throw errorCon(409, 'Ese vínculo no se generó desde un ingreso: cambialo en Vínculos');
        }
        const { rows } = await db.query(
            `UPDATE product_mappings SET estado = 'rechazado', active = false, es_habitual = false
             WHERE supplier_product_id = $1 AND odoo_product_id = $2 AND odoo_company = 'neggo'
             RETURNING metodo, match_confidence`,
            [actual.supplier_product_id, item.odoo_product_id]
        );
        await db.query(
            `INSERT INTO match_decisiones (supplier_product_id, odoo_product_id, odoo_company, decision, metodo, puntaje, user_id)
             VALUES ($1, $2, 'neggo', 'rechazado', $3, $4, $5)`,
            [actual.supplier_product_id, item.odoo_product_id, rows[0].metodo, rows[0].match_confidence, userId]
        );
        await db.query(
            `UPDATE ingreso_items
             SET supplier_product_id = NULL, supplier_match_level = 'none', supplier_confidence = 0,
                 vinculo_revisado_at = NULL, vinculo_revisado_por = NULL
             WHERE ingreso_id = $1 AND odoo_product_id = $2 AND supplier_product_id = $3`,
            [ingresoId, item.odoo_product_id, actual.supplier_product_id]
        );
        await recalcularHabituales(db);
        return { deshecho: true };
    });
}

module.exports = {
    puntuarOferta,
    elegirOfertas,
    vinculosDelIngreso,
    vincularExactos,
    ofertasDeRenglon,
    vincularOferta,
    deshacerVinculo,
};
