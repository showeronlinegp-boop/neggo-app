// Precios frescos en Reposición (plan de reposición automática, punto 3).
// Qué proveedores tienen ofertas web confirmadas de los productos abiertos en la cola y hace
// cuánto se scrapearon. "Actualizar" encola esos scrapers (o reanuda el que quedó en pausa)
// para que la comparación de proveedores no se haga con precios viejos.
// No escribe precios: eso lo hace el scraper-worker al correr cada run.

const pool = require('../config/database');
const scraping = require('./scrapingService');
const { DIAS_PRECIO_VIEJO } = require('./tablaMaestraService');

const DIA_MS = 24 * 3600 * 1000;
const RUN_EN_CURSO = ['queued', 'running'];

/**
 * Arma el estado por proveedor a partir de las filas de la consulta.
 * @param {Array<{supplier_id, proveedor, last_scraped_at, scrape_enabled, productos, ultimo_run}>} filas
 * @param {Date} [ahora]
 */
function resumirFrescura(filas, ahora = new Date()) {
    const proveedores = (filas || []).map(f => {
        const ultimo = f.last_scraped_at ? new Date(f.last_scraped_at) : null;
        const dias = ultimo ? Math.floor((ahora.getTime() - ultimo.getTime()) / DIA_MS) : null;
        const enCurso = RUN_EN_CURSO.includes(f.ultimo_run);
        return {
            supplier_id: f.supplier_id,
            proveedor: f.proveedor,
            ultimo_scraping: ultimo ? ultimo.toISOString() : null,
            dias,
            // Mismo corte que resumirOfertas: "precio viejo" en las ofertas de cada producto
            viejo: !ultimo || ultimo.getTime() < ahora.getTime() - DIAS_PRECIO_VIEJO * DIA_MS,
            productos: Number(f.productos) || 0,
            en_curso: enCurso,
            pausado: f.ultimo_run === 'paused',
            se_puede_scrapear: !!f.scrape_enabled,
        };
    }).sort((a, b) => (b.viejo - a.viejo) || (b.productos - a.productos) || a.proveedor.localeCompare(b.proveedor, 'es'));

    const viejos = proveedores.filter(p => p.viejo && !p.en_curso);
    return {
        dias_precio_viejo: DIAS_PRECIO_VIEJO,
        proveedores,
        n_viejos: viejos.length,
        productos_con_precio_viejo: viejos.reduce((s, p) => s + p.productos, 0),
        n_en_curso: proveedores.filter(p => p.en_curso).length,
    };
}

/**
 * Proveedores con ofertas web confirmadas de los productos pendientes o encargados.
 */
async function frescuraCola(db = pool) {
    const { rows } = await db.query(
        `SELECT s.id AS supplier_id, s.name AS proveedor, s.last_scraped_at, s.scrape_enabled,
                COUNT(DISTINCT ri.odoo_id) AS productos,
                (SELECT r.status FROM scraping_runs r WHERE r.supplier_id = s.id
                 ORDER BY r.id DESC LIMIT 1) AS ultimo_run
         FROM reposicion_items ri
         JOIN product_mappings pm ON pm.odoo_product_id = ri.odoo_id
              AND pm.odoo_company = 'neggo' AND pm.estado = 'confirmado'
         JOIN supplier_products sp ON sp.id = pm.supplier_product_id AND sp.source <> 'neggo'
         JOIN suppliers s ON s.id = sp.supplier_id AND s.active
         WHERE ri.company = 'neggo' AND ri.estado IN ('pendiente', 'encargado')
         GROUP BY s.id, s.name, s.last_scraped_at, s.scrape_enabled`
    );
    return resumirFrescura(rows);
}

/**
 * Elige a quién scrapear: los pedidos (si vienen) o todos los viejos. Nunca los que ya
 * están corriendo ni los que tienen el scraping apagado.
 */
function elegirParaActualizar(proveedores, supplierIds = null) {
    const pedidos = Array.isArray(supplierIds) && supplierIds.length ? new Set(supplierIds.map(Number)) : null;
    return proveedores.filter(p =>
        (pedidos ? pedidos.has(p.supplier_id) : p.viejo) && !p.en_curso && p.se_puede_scrapear
    );
}

/**
 * Encola los scrapers. Si el último run quedó en pausa, lo reanuda en vez de empezar de cero.
 * @returns {{ encolados: object[], errores: object[] }}
 */
async function actualizar(userId, { supplierIds = null } = {}, db = pool) {
    const { proveedores } = await frescuraCola(db);
    const elegidos = elegirParaActualizar(proveedores, supplierIds);
    const encolados = [];
    const errores = [];
    for (const p of elegidos) {
        try {
            const r = p.pausado
                ? await scraping.resumeScraper(db, p.supplier_id, userId)
                : await scraping.enqueueRun(db, p.supplier_id, userId);
            encolados.push({ supplier_id: p.supplier_id, proveedor: p.proveedor, run_id: r.runId, reanuda: !!r.resumedFrom });
        } catch (err) {
            errores.push({ supplier_id: p.supplier_id, proveedor: p.proveedor, error: err.message });
        }
    }
    if (encolados.length) {
        console.log(`📦 Precios frescos: ${encolados.length} scraper(s) en cola (${encolados.map(e => e.proveedor).join(', ')})`);
    }
    return { encolados, errores };
}

module.exports = { resumirFrescura, elegirParaActualizar, frescuraCola, actualizar };
