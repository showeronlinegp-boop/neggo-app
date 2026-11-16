// Propuestas de publicaciones de WhatsApp armadas por Claude según la época del año (nota 204).
// Lo usa una sesión de Claude Code (skill publicaciones-temporada) con scripts/whatsappPropuesta.js:
//   1. datos      → fecha, ventas por rubro en la misma época del año pasado y productos publicables
//                   (con foto y precio, sin lo publicado hace poco) con sus ventas.
//   2. registrar  → Claude devuelve el listado (id + motivo) y queda como propuesta PENDIENTE.
// La pantalla /admin/whatsapp la carga en "Generar imágenes": ahí una persona la revisa, cambia lo
// que quiera y la programa como cualquier sorteo. Acá no se programa ni se manda nada.
// Solo Neggo: es la única empresa con ventas en product_sales_weekly.

const fs = require('fs');
const path = require('path');
const { formatMoneyAR } = require('./whatsappPrice');
const { findByIds, BASE_WHERE, NOT_RECENT, RECENT_DAYS } = require('./whatsappRandom');

const COMPANY = 'neggo';
const VENTANA_DIAS = 28;
const LIMITE_DEFECTO = 200;
const LIMITE_MAX = 600;
const MAX_ITEMS = 300;
const MAX_MOTIVO = 200;
const ZONA = 'America/Argentina/Buenos_Aires';

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '064_whatsapp_propuestas.sql'), 'utf8');
let schemaReady = null;

function ensureSchema(db) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

// Una variante por plantilla, publicable hoy y que no salió en los últimos días ($1 empresa, $2 días)
const PUBLICABLES = `
    SELECT DISTINCT ON (opc.template_id)
           opc.odoo_id, opc.template_id, opc.name, opc.list_price,
           COALESCE(NULLIF(TRIM(opc.categ_name), ''), '(sin categoría)') AS categ
    FROM odoo_products_cache opc
    WHERE ${BASE_WHERE}
      AND ${NOT_RECENT}
    ORDER BY opc.template_id, opc.odoo_id
`;

function fechaValida(texto) {
    if (texto == null) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(texto))) throw new Error('La fecha va como AAAA-MM-DD');
    return String(texto);
}

// Ventana: los próximos VENTANA_DIAS días, pero del año pasado
async function calcularVentana(db, fecha) {
    const { rows: [r] } = await db.query(`
        WITH f AS (SELECT COALESCE($1::date, (NOW() AT TIME ZONE '${ZONA}')::date) AS hoy)
        SELECT f.hoy::text AS hoy,
               (f.hoy - INTERVAL '1 year')::date::text AS desde,
               (f.hoy - INTERVAL '1 year' + $2::int * INTERVAL '1 day')::date::text AS hasta,
               (SELECT MIN(week_start)::text FROM product_sales_weekly WHERE company = $3) AS datos_desde,
               (SELECT MAX(week_start)::text FROM product_sales_weekly WHERE company = $3) AS datos_hasta,
               (SELECT COUNT(DISTINCT week_start)::int FROM product_sales_weekly WHERE company = $3
                 AND week_start BETWEEN (f.hoy - INTERVAL '1 year')::date
                                    AND (f.hoy - INTERVAL '1 year' + $2::int * INTERVAL '1 day')::date) AS semanas_ventana,
               (SELECT COUNT(DISTINCT week_start)::int FROM product_sales_weekly WHERE company = $3) AS semanas_total
        FROM f
    `, [fecha, VENTANA_DIAS, COMPANY]);
    return { ...r, semanas_resto: Math.max(r.semanas_total - r.semanas_ventana, 0) };
}

// Cuántas veces más se vendió en la ventana que en una semana normal del resto del año
function indice(enVentana, enResto, v) {
    const a = Number(enVentana) || 0;
    const b = Number(enResto) || 0;
    if (!v.semanas_ventana) return null;
    if (b <= 0 || !v.semanas_resto) return a > 0 ? Infinity : null;
    return (a / v.semanas_ventana) / (b / v.semanas_resto);
}

function fmtIndice(x) {
    if (x == null) return '-';
    if (x === Infinity) return 'solo en esa época';
    return `x${x.toFixed(1)}`;
}

const pct = (parte, total) => (total > 0 ? `${((100 * parte) / total).toFixed(1)}%` : '-');

async function datos(db, { fecha = null, limite = LIMITE_DEFECTO, rubro = null, buscar = null } = {}) {
    const f = fechaValida(fecha);
    const lim = Math.min(Math.max(parseInt(limite, 10) || LIMITE_DEFECTO, 1), LIMITE_MAX);
    const v = await calcularVentana(db, f);
    const base = [COMPANY, RECENT_DAYS, v.desde, v.hasta, v.hoy];

    const { rows: rubros } = await db.query(`
        WITH pub AS (${PUBLICABLES}),
        ventas AS (
            SELECT COALESCE(NULLIF(TRIM(opc.categ_name), ''), '(sin categoría)') AS categ,
                   SUM(psw.amount_total) FILTER (WHERE psw.week_start BETWEEN $3::date AND $4::date) AS v_ventana,
                   SUM(psw.amount_total) FILTER (WHERE psw.week_start NOT BETWEEN $3::date AND $4::date) AS v_resto,
                   SUM(psw.amount_total) FILTER (WHERE psw.week_start >= $5::date - 56) AS v_8sem
            FROM product_sales_weekly psw
            JOIN odoo_products_cache opc ON opc.odoo_id = psw.odoo_id AND opc.company = psw.company
            WHERE psw.company = $1
            GROUP BY 1
        ),
        disp AS (SELECT categ, COUNT(*)::int AS publicables FROM pub GROUP BY 1)
        SELECT COALESCE(d.categ, ve.categ) AS categ, COALESCE(d.publicables, 0) AS publicables,
               COALESCE(ve.v_ventana, 0)::float AS v_ventana, COALESCE(ve.v_resto, 0)::float AS v_resto,
               COALESCE(ve.v_8sem, 0)::float AS v_8sem
        FROM disp d FULL JOIN ventas ve ON ve.categ = d.categ
        ORDER BY 2 DESC, 1
    `, base);

    const params = [...base];
    const filtros = [];
    if (rubro) {
        params.push(String(rubro));
        filtros.push(`p.categ = $${params.length}`);
    }
    const terminos = String(buscar || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (terminos.length) {
        params.push(terminos.map((s) => `%${s}%`));
        filtros.push(`p.name ILIKE ANY($${params.length}::text[])`);
    }
    params.push(lim);
    const orden = filtros.length ? 'p.categ, p.name' : 'u_ventana DESC, u_8sem DESC, p.name';
    const { rows: productos } = await db.query(`
        WITH p AS (${PUBLICABLES}),
        ve AS (
            SELECT sib.template_id,
                   SUM(psw.qty_vendida) FILTER (WHERE psw.week_start BETWEEN $3::date AND $4::date) AS u_ventana,
                   SUM(psw.qty_vendida) FILTER (WHERE psw.week_start NOT BETWEEN $3::date AND $4::date) AS u_resto,
                   SUM(psw.qty_vendida) FILTER (WHERE psw.week_start >= $5::date - 56) AS u_8sem
            FROM product_sales_weekly psw
            JOIN odoo_products_cache sib ON sib.odoo_id = psw.odoo_id AND sib.company = psw.company
            WHERE psw.company = $1 AND sib.template_id IS NOT NULL
            GROUP BY 1
        )
        SELECT p.odoo_id, p.categ, p.name, p.list_price::float AS list_price,
               COALESCE(ve.u_ventana, 0)::float AS u_ventana, COALESCE(ve.u_resto, 0)::float AS u_resto,
               COALESCE(ve.u_8sem, 0)::float AS u_8sem,
               COUNT(*) OVER ()::int AS total
        FROM p LEFT JOIN ve ON ve.template_id = p.template_id
        ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
        ORDER BY ${orden}
        LIMIT $${params.length}
    `, params);

    return { ventana: v, rubros, productos, filtrado: filtros.length > 0 };
}

function formatearDatos({ ventana: v, rubros, productos, filtrado }) {
    const out = [];
    out.push(`📦 Hoy: ${v.hoy} · ventas de Neggo del ${v.datos_desde} al ${v.datos_hasta}`);
    out.push(`Misma época del año pasado: ${v.desde} al ${v.hasta} (${v.semanas_ventana} semanas con datos)`);
    if (!v.semanas_ventana) out.push('⚠️ No hay ventas de esa época del año pasado: guiate por el calendario y las últimas 8 semanas.');
    out.push(`Se excluye lo que está en cola o salió en los últimos ${RECENT_DAYS} días.`);

    if (!filtrado) {
        const tv = rubros.reduce((a, r) => a + r.v_ventana, 0);
        const tr = rubros.reduce((a, r) => a + r.v_resto, 0);
        const t8 = rubros.reduce((a, r) => a + r.v_8sem, 0);
        out.push('', 'RUBROS: publicables hoy | % de la venta en esa época del año pasado | % en el resto del año | % últimas 8 semanas');
        for (const r of rubros) {
            out.push(`${r.categ} | ${r.publicables} | ${pct(r.v_ventana, tv)} | ${pct(r.v_resto, tr)} | ${pct(r.v_8sem, t8)}`);
        }
    }

    const total = productos[0]?.total || 0;
    out.push('', `PRODUCTOS (${productos.length} de ${total}${filtrado ? '' : ', los que más se vendieron en esa época'}):`);
    out.push('odoo_id | rubro | nombre | precio | unidades esa época (vs. semana normal) | unidades últimas 8 semanas');
    for (const p of productos) {
        const precio = formatMoneyAR(Math.ceil(p.list_price - 1e-9)) || '-';
        const ind = fmtIndice(indice(p.u_ventana, p.u_resto, v));
        out.push(`${p.odoo_id} | ${p.categ} | ${String(p.name).slice(0, 70)} | ${precio} | ${Math.round(p.u_ventana)} (${ind}) | ${Math.round(p.u_8sem)}`);
    }
    if (!filtrado && total > productos.length) {
        out.push('', `Hay más: --rubro "<rubro>" lista un rubro entero, --buscar "pileta,navidad" busca por nombre.`);
    }
    return out.join('\n');
}

/**
 * Texto de Claude → { titulo, resumen, items: [{ odoo_id, motivo }], errores }
 *   # Título de la propuesta          (obligatorio, una vez)
 *   > resumen                         (opcional, una o más líneas)
 *   <odoo_id> <motivo corto>          (una por producto, en el orden en que conviene publicar)
 */
function interpretar(texto) {
    const errores = [];
    let titulo = null;
    const resumen = [];
    const items = [];
    const vistos = new Set();
    String(texto || '').split(/\r?\n/).forEach((cruda, i) => {
        const linea = cruda.trim();
        const n = i + 1;
        if (!linea) return;
        if (linea.startsWith('#')) {
            if (titulo) errores.push(`Línea ${n}: hay más de un título`);
            titulo = linea.replace(/^#+\s*/, '').slice(0, 200);
            return;
        }
        if (linea.startsWith('>')) {
            resumen.push(linea.replace(/^>\s?/, ''));
            return;
        }
        const m = linea.match(/^(\d{1,9})\s+(.+)$/);
        if (!m) { errores.push(`Línea ${n}: no la entiendo («${linea.slice(0, 60)}»)`); return; }
        const odooId = Number(m[1]);
        if (vistos.has(odooId)) { errores.push(`Línea ${n}: el ${odooId} está repetido`); return; }
        vistos.add(odooId);
        items.push({ odoo_id: odooId, motivo: m[2].trim().slice(0, MAX_MOTIVO) });
    });
    if (!titulo) errores.push('Falta el título (una línea que empiece con #)');
    if (!items.length) errores.push('No hay ningún producto');
    if (items.length > MAX_ITEMS) errores.push(`Son ${items.length} productos: el máximo es ${MAX_ITEMS}`);
    return { titulo, resumen: resumen.join('\n').trim() || null, items, errores };
}

// Valida contra la base (publicable hoy, no salió hace poco, una variante por plantilla) y guarda.
async function registrar(db, texto, { aplicar = false } = {}) {
    const r = interpretar(texto);
    if (r.items.length) {
        const ids = r.items.map((it) => it.odoo_id);
        const { rows } = await db.query(`
            SELECT opc.odoo_id, opc.template_id
            FROM odoo_products_cache opc
            WHERE ${BASE_WHERE} AND ${NOT_RECENT} AND opc.odoo_id = ANY($3::int[])
        `, [COMPANY, RECENT_DAYS, ids]);
        const plantilla = new Map(rows.map((x) => [x.odoo_id, x.template_id]));
        const plantillas = new Map();
        for (const it of r.items) {
            if (!plantilla.has(it.odoo_id)) {
                r.errores.push(`${it.odoo_id}: no se puede publicar (sin foto, sin precio, archivado o ya salió en los últimos ${RECENT_DAYS} días)`);
                continue;
            }
            const tpl = plantilla.get(it.odoo_id);
            if (plantillas.has(tpl)) r.errores.push(`${it.odoo_id}: es otra variante del ${plantillas.get(tpl)}, dejá uno solo`);
            else plantillas.set(tpl, it.odoo_id);
        }
    }
    if (r.errores.length || !aplicar) return { ...r, id: null };

    await ensureSchema(db);
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE whatsapp_propuestas SET estado = 'reemplazada', updated_at = NOW()
            WHERE company = $1 AND estado = 'pendiente'
        `, [COMPANY]);
        const { rows: [row] } = await client.query(`
            INSERT INTO whatsapp_propuestas (company, titulo, resumen, items)
            VALUES ($1, $2, $3, $4::jsonb) RETURNING id
        `, [COMPANY, r.titulo, r.resumen, JSON.stringify(r.items)]);
        await client.query('COMMIT');
        return { ...r, id: row.id };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Productos ya revalidados → grupos por categoría (como el sorteo), en el orden de la propuesta
function agrupar(items, productos) {
    const porId = new Map(productos.map((p) => [p.odoo_id, p]));
    const grupos = [];
    const indicePorCateg = new Map();
    let omitidos = 0;
    for (const it of items) {
        const p = porId.get(Number(it.odoo_id));
        if (!p) { omitidos += 1; continue; }
        const categ = p.categ_name || '(sin categoría)';
        if (!indicePorCateg.has(categ)) {
            indicePorCateg.set(categ, grupos.length);
            grupos.push({ category: categ, products: [] });
        }
        grupos[indicePorCateg.get(categ)].products.push({ ...p, motivo: it.motivo || null });
    }
    return { grupos, omitidos };
}

async function ultimaPendiente(db) {
    await ensureSchema(db);
    const { rows: [prop] } = await db.query(`
        SELECT id, titulo, resumen, items, created_at
        FROM whatsapp_propuestas
        WHERE company = $1 AND estado = 'pendiente'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `, [COMPANY]);
    if (!prop) return null;
    const items = Array.isArray(prop.items) ? prop.items : [];
    // Se revalida al cargar: lo que salió o entró en cola después de que Claude armó la
    // propuesta (por ejemplo, con otro sorteo) queda afuera para no repetirlo
    const ids = items.map((it) => Number(it.odoo_id)).filter(Number.isInteger);
    const { rows: libres } = ids.length ? await db.query(`
        SELECT opc.odoo_id FROM odoo_products_cache opc
        WHERE ${BASE_WHERE} AND ${NOT_RECENT} AND opc.odoo_id = ANY($3::int[])
    `, [COMPANY, RECENT_DAYS, ids]) : { rows: [] };
    const publicables = new Set(libres.map((x) => x.odoo_id));
    const productos = (await findByIds(db, COMPANY, ids)).filter((p) => publicables.has(p.odoo_id));
    const { grupos, omitidos } = agrupar(items, productos);
    return {
        id: prop.id,
        titulo: prop.titulo,
        resumen: prop.resumen,
        created_at: prop.created_at,
        grupos,
        total: grupos.reduce((a, g) => a + g.products.length, 0),
        omitidos,
    };
}

async function marcar(db, id, estado) {
    if (!['usada', 'descartada'].includes(estado)) throw new Error('El estado tiene que ser usada o descartada');
    await ensureSchema(db);
    const { rowCount } = await db.query(`
        UPDATE whatsapp_propuestas SET estado = $2, updated_at = NOW()
        WHERE id = $1 AND company = $3 AND estado = 'pendiente'
    `, [Number(id), estado, COMPANY]);
    if (!rowCount) throw new Error('La propuesta ya no está pendiente');
    return { id: Number(id), estado };
}

module.exports = {
    datos, formatearDatos, interpretar, registrar, agrupar, ultimaPendiente, marcar, indice, ensureSchema,
    COMPANY, VENTANA_DIAS, MAX_ITEMS,
};
