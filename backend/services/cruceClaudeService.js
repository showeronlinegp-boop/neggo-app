// Cruce de productos revisado por Claude (plan de reposición automática, punto 5).
// Lo corre una sesión de Claude Code (tareas del bot o a mano) con scripts/cruceClaude.js:
//   1. lote       → toma los productos que más se venden y tienen menos de 2 proveedores web
//                   confirmados, les busca candidatos (de su proveedor de Odoo y de los demás)
//                   y guarda la tanda con una letra por candidato.
//   2. registrar  → Claude contesta una línea por producto; lo elegido queda como SUGERIDO
//                   (metodo 'claude') para que una persona lo confirme en Vincular.
// Nada se confirma solo, no toca Odoo ni precios. Los productos revisados no vuelven a una
// tanda hasta dentro de DIAS_REPASO días.

const pool = require('../config/database');

const LOTE_DEFECTO = 40;
const LOTE_MAX = 80;
const DIAS_REPASO = 30;
// Candidatos por producto: del mismo proveedor de Odoo (ahí suele estar) y de otros proveedores
const CAND_MISMO = 8;
const CAND_OTROS = 6;
// Parecido mínimo para traer candidatos de otros proveedores
const MIN_PARECIDO_OTROS = 0.2;
// Venta que define el top y semanas que se miran (igual que la tabla maestra)
const PARTE_TOP = 0.80;
const SEMANAS_VENTA = 6;
// Lo que se guarda como match_confidence según lo que dice Claude
const CONFIANZA = { alta: 0.95, media: 0.75 };
const LETRAS = 'abcdefghijklmnopqrstuvwxyz';

const normName = col => `translate(LOWER(${col}), 'áéíóúüàèìòùñ', 'aeiouuaeioun')`;
const proveedorOdoo = alias => `COALESCE(NULLIF(${alias}.odoo_vendor_name, ''), ${alias}.name)`;

const num = v => (v == null ? null : Number(v));

function idLote(ahora = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `cruce-${ahora.getUTCFullYear()}${p(ahora.getUTCMonth() + 1)}${p(ahora.getUTCDate())}-` +
        `${p(ahora.getUTCHours())}${p(ahora.getUTCMinutes())}${p(ahora.getUTCSeconds())}`;
}

/**
 * Productos del top de venta con menos de 2 proveedores web confirmados y sin revisión reciente.
 * Incluye archivados en Odoo (archivado = agotado: son los que hay que reponer).
 */
async function productosParaRevisar(db, limite) {
    const { rows } = await db.query(
        `WITH ventas AS (
             SELECT odoo_id, SUM(amount_total) AS monto
             FROM product_sales_weekly
             WHERE company = 'neggo'
               AND week_start > (SELECT MAX(week_start) FROM product_sales_weekly WHERE company = 'neggo') - ($1::int * 7)
             GROUP BY odoo_id
             HAVING SUM(amount_total) > 0
         ), top AS (
             SELECT odoo_id, monto,
                    (SUM(monto) OVER (ORDER BY monto DESC, odoo_id) - monto) < SUM(monto) OVER () * $2 AS en_top
             FROM ventas
         ), confirmados AS (
             SELECT pm.odoo_product_id, array_agg(DISTINCT s.name ORDER BY s.name) AS proveedores
             FROM product_mappings pm
             JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source <> 'neggo'
             JOIN suppliers s ON s.id = sp.supplier_id
             WHERE pm.odoo_company = 'neggo' AND pm.estado = 'confirmado'
             GROUP BY pm.odoo_product_id
         )
         SELECT opc.odoo_id, opc.name, opc.internal_ref, opc.standard_price, opc.list_price,
                opc.categ_name, opc.vendor_name, opc.active, t.monto AS venta,
                COALESCE(c.proveedores, '{}') AS confirmados_con
         FROM top t
         JOIN odoo_products_cache opc ON opc.odoo_id = t.odoo_id AND opc.company = 'neggo'
         LEFT JOIN confirmados c ON c.odoo_product_id = opc.odoo_id
         WHERE t.en_top
           AND COALESCE(array_length(c.proveedores, 1), 0) < 2
           AND NOT EXISTS (SELECT 1 FROM cruce_revisiones cr
                           WHERE cr.odoo_product_id = opc.odoo_id AND cr.odoo_company = 'neggo'
                             AND cr.created_at > NOW() - ($3::int * INTERVAL '1 day'))
         ORDER BY t.monto DESC, opc.odoo_id
         LIMIT $4`,
        [SEMANAS_VENTA, PARTE_TOP, DIAS_REPASO, limite]
    );
    return rows;
}

/**
 * Candidatos web de cada producto: los más parecidos de su proveedor de Odoo y de los demás.
 * Saltea pares ya confirmados o rechazados y los proveedores con los que ya está confirmado.
 */
async function candidatos(db, odooIds) {
    const filtro = `
        v.source = 'web'
        AND NOT EXISTS (SELECT 1 FROM product_mappings pm
                        WHERE pm.supplier_product_id = v.supplier_product_id AND pm.odoo_product_id = opc.odoo_id
                          AND pm.odoo_company = 'neggo' AND pm.estado IN ('confirmado', 'rechazado'))
        AND NOT EXISTS (SELECT 1 FROM match_decisiones md
                        WHERE md.supplier_product_id = v.supplier_product_id AND md.odoo_product_id = opc.odoo_id
                          AND md.odoo_company = 'neggo' AND md.decision = 'rechazado')
        AND NOT EXISTS (SELECT 1 FROM product_mappings pm2
                        JOIN supplier_products sp2 ON sp2.id = pm2.supplier_product_id
                        WHERE pm2.odoo_product_id = opc.odoo_id AND pm2.odoo_company = 'neggo'
                          AND pm2.estado = 'confirmado' AND sp2.supplier_id = v.supplier_id)`;
    const columnas = `v.supplier_product_id, v.proveedor, v.sku, v.codigo_proveedor, v.name, v.source_category,
                      v.available, v.pack_cantidad, v.precio_comparable, v.last_scraped_at`;
    const { rows } = await db.query(
        `SELECT opc.odoo_id, c.*
         FROM odoo_products_cache opc
         CROSS JOIN LATERAL (
             (SELECT ${columnas}, true AS mismo_proveedor,
                     similarity(${normName('v.name')}, ${normName('opc.name')}) AS parecido
              FROM v_ofertas_comparables v
              WHERE v.proveedor_odoo = opc.vendor_name AND ${filtro}
              ORDER BY parecido DESC, v.available DESC, v.supplier_product_id
              LIMIT ${CAND_MISMO})
             UNION ALL
             (SELECT ${columnas}, false AS mismo_proveedor,
                     similarity(${normName('v.name')}, ${normName('opc.name')}) AS parecido
              FROM v_ofertas_comparables v
              WHERE v.proveedor_odoo IS DISTINCT FROM opc.vendor_name AND ${filtro}
                AND similarity(${normName('v.name')}, ${normName('opc.name')}) >= ${MIN_PARECIDO_OTROS}
              ORDER BY parecido DESC, v.available DESC, v.supplier_product_id
              LIMIT ${CAND_OTROS})
         ) c
         WHERE opc.company = 'neggo' AND opc.odoo_id = ANY($1::int[])`,
        [odooIds]
    );
    return rows;
}

/**
 * Arma la tanda: a cada candidato le pone una letra (el orden se mezcla para no sesgar por parecido).
 * Pura: recibe las filas y devuelve lo que se guarda.
 */
function armarProductos(productos, filasCandidatos, azar = Math.random) {
    const porProducto = new Map();
    for (const f of filasCandidatos) {
        if (!porProducto.has(f.odoo_id)) porProducto.set(f.odoo_id, []);
        porProducto.get(f.odoo_id).push(f);
    }
    return productos.map(p => {
        const lista = (porProducto.get(p.odoo_id) || [])
            .map(c => ({ c, k: azar() }))
            .sort((a, b) => a.k - b.k)
            .map(({ c }, i) => ({
                letra: LETRAS[i],
                supplier_product_id: c.supplier_product_id,
                proveedor: c.proveedor,
                mismo_proveedor: !!c.mismo_proveedor,
                // El código del proveedor dice más que el SKU interno (PRE + prefijo + código)
                sku: c.codigo_proveedor || c.sku || null,
                nombre: c.name,
                categoria: c.source_category || null,
                disponible: !!c.available,
                pack: c.pack_cantidad || 1,
                precio: num(c.precio_comparable),
                scrapeado_at: c.last_scraped_at ? new Date(c.last_scraped_at).toISOString() : null,
            }));
        return {
            odoo_id: p.odoo_id,
            nombre: p.name,
            ref: p.internal_ref || null,
            categoria: p.categ_name || null,
            proveedor_odoo: p.vendor_name || null,
            activo: p.active !== false,
            costo: num(p.standard_price),
            precio_venta: num(p.list_price),
            confirmados_con: p.confirmados_con || [],
            candidatos: lista,
        };
    });
}

/**
 * Texto que lee Claude. Muestra lo que sirve para decidir (nombre, código, categoría, precio,
 * pack) y no el puntaje de parecido.
 */
function formatearLote(lote) {
    const $ = n => (n == null ? '—' : `$${Math.round(n).toLocaleString('es-AR')}`);
    const lineas = [
        `# Tanda ${lote.id} — ${lote.productos.length} productos`,
        '# Contestá una línea por producto:  <odoo_id> <letra|-|?> <alta|media> <motivo>',
        '#   letra = es el mismo producto (mismo modelo, medida y presentación; un pack se acepta si el precio por unidad cierra)',
        '#   -     = ninguno es el mismo      ?     = no alcanza para decidir (falta color, medida o precio)',
        '#   La confianza va solo con letra. El motivo es corto y es lo que va a leer quien confirme.',
        '',
    ];
    for (const p of lote.productos) {
        const ya = p.confirmados_con.length ? ` | ya confirmado con: ${p.confirmados_con.join(', ')}` : '';
        lineas.push(`#${p.odoo_id}  ${p.nombre}${p.ref ? `  [ref ${p.ref}]` : ''}`);
        lineas.push(`   Odoo: ${p.proveedor_odoo || 'sin proveedor'} | ${p.categoria || 'sin categoría'} | costo ${$(p.costo)} | venta ${$(p.precio_venta)}${p.activo ? '' : ' | ARCHIVADO (agotado)'}${ya}`);
        if (!p.candidatos.length) lineas.push('   (sin candidatos)');
        for (const c of p.candidatos) {
            const extra = [
                c.mismo_proveedor ? 'su proveedor' : 'otro proveedor',
                c.categoria,
                c.precio != null ? `${$(c.precio)} c/u` : 'sin precio',
                c.pack > 1 ? `pack x${c.pack}` : null,
                c.disponible ? null : 'sin stock',
            ].filter(Boolean).join(' | ');
            lineas.push(`   ${c.letra}) ${c.nombre}${c.sku ? `  {${c.sku}}` : ''}  — ${c.proveedor} (${extra})`);
        }
        lineas.push('');
    }
    return lineas.join('\n');
}

/**
 * Lee las respuestas: "<odoo_id> <letra|-|?> [alta|media] [motivo...]". Líneas vacías o con # se ignoran.
 * @returns {{ decisiones: Array<{odoo_id, marca, confianza, motivo}>, errores: string[] }}
 */
function parsearDecisiones(texto) {
    const decisiones = [];
    const errores = [];
    String(texto || '').split(/\r?\n/).forEach((linea, i) => {
        const l = linea.trim();
        // "#123 ..." es una respuesta (se puede copiar el id como aparece); "# texto" es comentario
        if (!l || (l.startsWith('#') && !/^#\d/.test(l))) return;
        const m = l.match(/^#?(\d+)\s+([a-z]|-|\?)(?:\s+(alta|media))?(?:\s+(.*))?$/i);
        if (!m) { errores.push(`Línea ${i + 1}: no se entiende "${l}"`); return; }
        const marca = m[2].toLowerCase();
        const confianza = m[3] ? m[3].toLowerCase() : null;
        if (/[a-z]/.test(marca) && !confianza) { errores.push(`Línea ${i + 1}: falta la confianza (alta o media)`); return; }
        decisiones.push({ odoo_id: Number(m[1]), marca, confianza: /[a-z]/.test(marca) ? confianza : null, motivo: (m[4] || '').trim() || null });
    });
    return { decisiones, errores };
}

/**
 * Cruza las respuestas con la tanda: cada letra pasa a su oferta. Pura.
 * @returns {{ validas: Array, errores: string[], faltan: number[] }}
 */
function validarDecisiones(productos, decisiones) {
    const porId = new Map(productos.map(p => [p.odoo_id, p]));
    const vistos = new Set();
    const validas = [];
    const errores = [];
    for (const d of decisiones) {
        const p = porId.get(d.odoo_id);
        if (!p) { errores.push(`#${d.odoo_id} no está en esta tanda`); continue; }
        if (vistos.has(d.odoo_id)) { errores.push(`#${d.odoo_id} está dos veces`); continue; }
        vistos.add(d.odoo_id);
        if (d.marca === '-' || d.marca === '?') {
            validas.push({ odoo_id: d.odoo_id, ref: p.ref, resultado: d.marca === '-' ? 'ninguno' : 'duda',
                supplier_product_id: null, confianza: null, motivo: d.motivo, candidatos: p.candidatos.length });
            continue;
        }
        const c = p.candidatos.find(x => x.letra === d.marca);
        if (!c) { errores.push(`#${d.odoo_id}: la letra "${d.marca}" no existe`); continue; }
        validas.push({ odoo_id: d.odoo_id, ref: p.ref, resultado: 'elegido', supplier_product_id: c.supplier_product_id,
            confianza: d.confianza, motivo: d.motivo, candidatos: p.candidatos.length, proveedor: c.proveedor });
    }
    const faltan = productos.filter(p => !vistos.has(p.odoo_id)).map(p => p.odoo_id);
    return { validas, errores, faltan };
}

/**
 * Arma y guarda una tanda nueva.
 */
async function nuevoLote({ limite = LOTE_DEFECTO } = {}) {
    const n = Math.min(Math.max(parseInt(limite, 10) || LOTE_DEFECTO, 1), LOTE_MAX);
    const productos = await productosParaRevisar(pool, n);
    const filas = productos.length ? await candidatos(pool, productos.map(p => p.odoo_id)) : [];
    const lote = { id: idLote(), productos: armarProductos(productos, filas) };
    if (lote.productos.length) {
        await pool.query(`INSERT INTO cruce_lotes (id, productos) VALUES ($1, $2)`, [lote.id, JSON.stringify(lote.productos)]);
    }
    return lote;
}

/**
 * Registra las respuestas de una tanda. Sin aplicar, hace todo y lo deshace (prueba).
 */
async function registrar(loteId, texto, { aplicar = false } = {}) {
    const { rows: [lote] } = await pool.query(`SELECT id, productos, registrado_at FROM cruce_lotes WHERE id = $1`, [loteId]);
    if (!lote) throw new Error(`No existe la tanda ${loteId}`);
    if (lote.registrado_at) throw new Error(`La tanda ${loteId} ya se registró el ${lote.registrado_at.toISOString()}`);

    const { decisiones, errores: deLectura } = parsearDecisiones(texto);
    const { validas, errores, faltan } = validarDecisiones(lote.productos, decisiones);
    const todosLosErrores = [...deLectura, ...errores];
    // Sin ninguna respuesta no se cierra la tanda (entrada vacía o mal redirigida)
    if (!decisiones.length && !todosLosErrores.length) todosLosErrores.push('No llegó ninguna respuesta');
    if (todosLosErrores.length) return { aplicado: false, errores: todosLosErrores, faltan };

    const db = await pool.connect();
    const resumen = { aplicado: aplicar, elegidos: 0, ninguno: 0, duda: 0, sugeridos_nuevos: 0, sugeridos_mejorados: 0, faltan };
    try {
        await db.query('BEGIN');
        for (const v of validas) {
            resumen[v.resultado === 'elegido' ? 'elegidos' : v.resultado]++;
            await db.query(
                `INSERT INTO cruce_revisiones (lote, odoo_product_id, resultado, supplier_product_id, confianza, motivo, candidatos)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [loteId, v.odoo_id, v.resultado, v.supplier_product_id, v.confianza, v.motivo, v.candidatos]
            );
            if (v.resultado !== 'elegido') continue;
            // Un sugerido por nombre del mismo par pasa a ser de Claude; lo confirmado o rechazado no se toca
            const { rows: [r] } = await db.query(
                `INSERT INTO product_mappings
                    (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref,
                     match_type, match_confidence, active, estado, metodo)
                 VALUES ($1, $2, 'neggo', $3, 'claude', $4, false, 'sugerido', 'claude')
                 ON CONFLICT (supplier_product_id, odoo_product_id, odoo_company) DO UPDATE
                    SET metodo = 'claude', match_type = 'claude', match_confidence = EXCLUDED.match_confidence
                    WHERE product_mappings.estado = 'sugerido'
                 RETURNING (xmax = 0) AS nuevo`,
                [v.supplier_product_id, v.odoo_id, v.ref, CONFIANZA[v.confianza]]
            );
            if (r) resumen[r.nuevo ? 'sugeridos_nuevos' : 'sugeridos_mejorados']++;
        }
        await db.query(`UPDATE cruce_lotes SET registrado_at = NOW() WHERE id = $1`, [loteId]);
        await db.query(aplicar ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.release();
    }
    return resumen;
}

/**
 * Cobertura del top y acierto de Claude según lo que confirmaron o rechazaron las personas.
 */
async function cobertura() {
    const { rows: [c] } = await pool.query(
        `WITH ventas AS (
             SELECT odoo_id, SUM(amount_total) AS monto FROM product_sales_weekly
             WHERE company = 'neggo'
               AND week_start > (SELECT MAX(week_start) FROM product_sales_weekly WHERE company = 'neggo') - ($1::int * 7)
             GROUP BY odoo_id HAVING SUM(amount_total) > 0
         ), top AS (
             SELECT odoo_id FROM (
                 SELECT odoo_id, (SUM(monto) OVER (ORDER BY monto DESC, odoo_id) - monto) < SUM(monto) OVER () * $2 AS en_top
                 FROM ventas) x WHERE en_top
         ), prov AS (
             SELECT t.odoo_id,
                    COUNT(DISTINCT sp.supplier_id) FILTER (WHERE sp.available AND sp.raw_price > 0) AS con_precio,
                    COUNT(DISTINCT sp.supplier_id) FILTER (WHERE sp.available AND sp.raw_price > 0
                                                           AND sp.last_scraped_at > NOW() - INTERVAL '7 days') AS frescos
             FROM top t
             LEFT JOIN product_mappings pm ON pm.odoo_product_id = t.odoo_id AND pm.odoo_company = 'neggo' AND pm.estado = 'confirmado'
             LEFT JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source = 'web'
             GROUP BY t.odoo_id
         )
         SELECT COUNT(*)::int AS top,
                COUNT(*) FILTER (WHERE con_precio >= 1)::int AS con_1_proveedor,
                COUNT(*) FILTER (WHERE con_precio >= 2)::int AS con_2_proveedores,
                COUNT(*) FILTER (WHERE frescos >= 2)::int AS con_2_frescos
         FROM prov`,
        [SEMANAS_VENTA, PARTE_TOP]
    );
    const { rows: [a] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE decision = 'confirmado')::int AS confirmados,
                COUNT(*) FILTER (WHERE decision = 'rechazado')::int AS rechazados
         FROM match_decisiones WHERE metodo = 'claude' AND user_id IS NOT NULL`
    );
    const { rows: [p] } = await pool.query(
        `SELECT COUNT(*)::int AS pendientes FROM product_mappings
         WHERE metodo = 'claude' AND estado = 'sugerido' AND odoo_company = 'neggo'`
    );
    return { ...c, claude: { ...a, pendientes: p.pendientes } };
}

module.exports = {
    LOTE_DEFECTO, DIAS_REPASO,
    idLote, armarProductos, formatearLote, parsearDecisiones, validarDecisiones,
    nuevoLote, registrar, cobertura,
};
