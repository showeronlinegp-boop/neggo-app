// Comparar compras (nota 107, punto 6): pantalla de solo lectura sobre la tabla maestra.
//   - Comparar: productos de Neggo con ofertas web confirmadas, con su venta, el costo actual de
//     Odoo, el más económico y si conviene otro proveedor (el mismo cálculo que Reposición)
//   - Se vende y no tiene oferta: lo vendido en las últimas semanas sin ninguna oferta web
//     confirmada y disponible, con el motivo para saber por dónde resolverlo
// Precompras (origen "neggo") es base de costos y no cuenta como oferta. No escribe nada.

const pool = require('../config/database');
const { ofertasPorProducto } = require('./tablaMaestraService');

// Semanas de venta que se miran
const SEMANAS_VENTA = 6;
// Productos de Odoo que no son mercadería (anticipos y pedidos de preventa)
const NO_MERCADERIA = ['Down Payment (POS)', 'Pedido Preventa'];
// Parte de la venta que forma el "top" (la métrica del plan)
const PARTE_TOP = 0.80;

// Venta de las últimas semanas por producto de Neggo y si está en el top que hace el 80 % de la venta
const VENTAS_CTE = `
    ventas AS (
        SELECT psw.odoo_id, SUM(psw.amount_total) AS monto, SUM(psw.qty_vendida) AS unidades
        FROM product_sales_weekly psw
        JOIN odoo_products_cache opc ON opc.odoo_id = psw.odoo_id AND opc.company = 'neggo'
        WHERE psw.company = 'neggo'
          AND psw.week_start > (SELECT MAX(week_start) FROM product_sales_weekly) - ($1::int * 7)
          AND opc.name <> ALL($2::text[])
        GROUP BY psw.odoo_id
        HAVING SUM(psw.amount_total) > 0
    ),
    top AS (
        SELECT odoo_id, monto, unidades,
               (SUM(monto) OVER (ORDER BY monto DESC, odoo_id) - monto) < SUM(monto) OVER () * $3 AS en_top
        FROM ventas
    )`;

// Oferta web confirmada del producto (Precompras afuera); con "disponible" pide además precio y stock
const OFERTA_CONFIRMADA = (disponible) => `
    EXISTS (SELECT 1 FROM product_mappings pm
            JOIN v_ofertas_comparables v ON v.supplier_product_id = pm.supplier_product_id
            WHERE pm.odoo_product_id = opc.odoo_id AND pm.odoo_company = 'neggo'
              AND pm.estado = 'confirmado' AND v.source <> 'neggo'
              ${disponible ? 'AND v.available AND v.precio_comparable > 0' : ''})`;

/**
 * Por qué un producto que se vende no tiene oferta para comparar (el primero que aplica).
 * @param {{ con_no_disponible: boolean, sugeridos: number, vendor_name: string|null, proveedor_con_web: boolean }} p
 * @returns {'no_disponible'|'sugerido'|'no_encontrada'|'sin_proveedor'|'proveedor_sin_web'}
 */
function motivoSinOferta(p) {
    if (p.con_no_disponible) return 'no_disponible';
    if (Number(p.sugeridos) > 0) return 'sugerido';
    if (!p.vendor_name) return 'sin_proveedor';
    if (p.proveedor_con_web) return 'no_encontrada';
    return 'proveedor_sin_web';
}

/**
 * Productos de Neggo con alguna oferta web confirmada, de lo que más se vende a lo que menos.
 * Cada uno trae `ofertas` (resumirOfertas: costo actual, más económico, conviene y todas).
 */
async function listarComparar() {
    const { rows } = await pool.query(
        `WITH ${VENTAS_CTE}
         SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.vendor_name, opc.standard_price,
                opc.image_url, opc.active,
                COALESCE(t.monto, 0) AS venta, COALESCE(t.unidades, 0) AS unidades, COALESCE(t.en_top, false) AS en_top
         FROM odoo_products_cache opc
         LEFT JOIN top t ON t.odoo_id = opc.odoo_id
         WHERE opc.company = 'neggo' AND ${OFERTA_CONFIRMADA(false)}
         ORDER BY COALESCE(t.monto, 0) DESC, opc.name`,
        [SEMANAS_VENTA, NO_MERCADERIA, PARTE_TOP]
    );
    const ofertas = await ofertasPorProducto(rows);
    return rows.map(r => ({ ...r, ofertas: ofertas.get(r.odoo_id) || null }));
}

/**
 * Lo que se vendió en las últimas semanas y no tiene ninguna oferta web confirmada y disponible.
 */
async function listarSinOferta() {
    const { rows } = await pool.query(
        `WITH ${VENTAS_CTE},
         con_web AS (
             SELECT DISTINCT s.name FROM suppliers s
             JOIN supplier_products sp ON sp.supplier_id = s.id AND sp.source = 'web' AND sp.raw_price > 0
         )
         SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.vendor_name, opc.standard_price,
                opc.image_url, opc.active, t.monto AS venta, t.unidades, t.en_top,
                ${OFERTA_CONFIRMADA(false)} AS con_no_disponible,
                (SELECT COUNT(*) FROM product_mappings pm
                 JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web' AND sp.raw_price > 0
                 WHERE pm.odoo_product_id = opc.odoo_id AND pm.odoo_company = 'neggo' AND pm.estado = 'sugerido')::int AS sugeridos,
                (opc.vendor_name IN (SELECT name FROM con_web)) AS proveedor_con_web
         FROM top t
         JOIN odoo_products_cache opc ON opc.odoo_id = t.odoo_id AND opc.company = 'neggo'
         WHERE NOT ${OFERTA_CONFIRMADA(true)}
         ORDER BY t.monto DESC, opc.name`,
        [SEMANAS_VENTA, NO_MERCADERIA, PARTE_TOP]
    );
    return rows.map(r => ({ ...r, motivo: motivoSinOferta(r) }));
}

/**
 * Métrica del plan: del top que hace el 80 % de la venta, cuántos tienen oferta web disponible.
 */
async function metrica() {
    const { rows: [r] } = await pool.query(
        `WITH ${VENTAS_CTE}
         SELECT COUNT(*) FILTER (WHERE t.en_top)::int AS top,
                COUNT(*) FILTER (WHERE t.en_top AND ${OFERTA_CONFIRMADA(true)})::int AS top_con_oferta,
                COUNT(*)::int AS vendidos,
                COUNT(*) FILTER (WHERE ${OFERTA_CONFIRMADA(true)})::int AS vendidos_con_oferta
         FROM top t
         JOIN odoo_products_cache opc ON opc.odoo_id = t.odoo_id AND opc.company = 'neggo'`,
        [SEMANAS_VENTA, NO_MERCADERIA, PARTE_TOP]
    );
    return { ...r, semanas: SEMANAS_VENTA, parte_top: PARTE_TOP };
}

module.exports = { listarComparar, listarSinOferta, metrica, motivoSinOferta, SEMANAS_VENTA };
