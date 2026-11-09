const fs = require('fs');
const BaseScraper = require('./baseScraper');
const scrapingLogs = require('../services/scrapingLogs');
const { leerLista } = require('../services/listaExcel');
const lista = require('../services/listaService');

// Proporción mínima de la lista anterior que tiene que aparecer para archivar lo que falta
const MIN_VISTOS_PARA_ARCHIVAR = 0.5;

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* sin sharp las fotos PNG se guardan como vienen */ }

/**
 * ListaScraper — fuente "Lista Excel" (scraper_key = 'lista_excel', nota 175).
 * No scrapea ninguna web: lee la lista vigente que se subió en Proveedores
 * (scrape_config.lista.archivo, dentro de storage/listas/<proveedor>/) y la guarda como
 * ofertas source = 'web', igual que un scraper. Así Sync Preventas, Vínculos y Reposición
 * la usan sin cambios.
 *
 * Diferencias con un scraper web:
 *  - cada fila se reconoce antes de guardar (código y, si no, nombre + precio): ver listaService
 *  - lo que no vino queda no disponible, no se borra (vínculos y decisiones del cruce siguen)
 *  - una fila sin foto conserva la foto que ya tenía
 */
class ListaScraper extends BaseScraper {

    get buscaPorNombre() {
        return false;
    }

    log(msg) {
        console.log(msg);
        if (this.runId && this.runId !== 'preview') scrapingLogs.appendLog(this.runId, msg);
    }

    async leerArchivo() {
        const ruta = lista.rutaListaVigente(this.supplier);
        if (!ruta) throw new Error(`"${this.supplier.name}" no tiene una lista cargada: subila desde Proveedores`);
        try {
            return await fs.promises.readFile(ruta);
        } catch (err) {
            throw new Error(`No se encontró el archivo de la lista (${this.supplier.scrape_config.lista.archivo}): ${err.message}`);
        }
    }

    async run(triggeredBy) {
        await this.createRun(triggeredBy);

        try {
            const info = this.supplier.scrape_config?.lista || {};
            this.log(`📦 [Lista] Leyendo la lista de "${this.supplier.name}"${info.nombre ? ` (${info.nombre})` : ''}`);
            const { filas, salteadas } = leerLista(await this.leerArchivo(), { conFotos: !this.dryRun });
            for (const s of salteadas) this.log(`⚠️ [Lista] Fila ${s.fila} salteada: ${s.motivo}`);

            const existentes = await lista.cargarExistentes(this.pool, this.supplier.id);
            const resueltas = lista.resolverFilas(filas, existentes, this.supplier.prefix);
            const resumen = lista.resumir(resueltas, existentes, salteadas);
            this.log(`📦 [Lista] ${resumen.filas} productos: ${resumen.nuevos} nuevos, ${resumen.suben} suben, ` +
                `${resumen.bajan} bajan, ${resumen.reaparecen} vuelven, ${resumen.se_archivan} no vinieron`);

            const fotos = this.dryRun ? new Map() : await lista.guardarFotos(resueltas, this.supplier, { sharp });
            const pre = `PRE${String(this.supplier.prefix || '').toUpperCase()}`;
            this.products = resueltas.map(r => ({
                // upsertProducts le antepone PRE + prefijo
                sku: r.sku.slice(pre.length),
                name: r.nombre,
                raw_price: r.precio,
                offer_price: null,
                image_url: this.dryRun ? (r.existente?.image_url || null) : (fotos.get(r.sku) || null),
                product_url: null,
                barcode: null,
                source_category: r.categoria,
                available: true,
                source: 'web',
                codigo_proveedor: r.codigo_proveedor || null,
            }));

            if (this.onProduct) for (const p of this.products) this.onProduct(p);

            if (this.dryRun) {
                return {
                    runId: null, status: 'preview', found: this.products.length,
                    newProducts: 0, updated: 0, priceChanges: 0,
                    products: this.products, errors: this.errors,
                };
            }

            const runStartedAt = new Date();
            this.runStartedAt = runStartedAt;
            const upsertStats = await this.upsertProducts(this.products);
            await this.guardarCodigosProveedor();

            const finalStatus = this.products.length === 0 ? 'failed'
                : this.errors.length > 0 ? 'partial' : 'completed';
            const unavailable = finalStatus === 'completed' ? await this.markUnavailableSince(runStartedAt) : 0;

            const stats = {
                found: this.products.length,
                newProducts: upsertStats.new,
                updated: upsertStats.updated,
                priceChanges: upsertStats.priceChanges,
                unavailable,
            };
            await this.updateRun(finalStatus, stats);
            // Sin cleanupDuplicates(): en las listas hay productos distintos con el mismo nombre

            this.log(`📊 [Lista] ${stats.found} productos, ${stats.newProducts} nuevos, ${stats.updated} actualizados, ` +
                `${stats.priceChanges} cambios de precio, ${unavailable} quedan no disponibles`);
            scrapingLogs.markDone(this.runId, finalStatus);
            return { runId: this.runId, status: finalStatus, ...stats, errors: this.errors };

        } catch (err) {
            console.error(`❌ [Lista] Error en "${this.supplier.name}": ${err.message}`);
            this.errors.push({ phase: 'run', error: err.message });
            if (this.runId && this.runId !== 'preview') {
                scrapingLogs.appendLog(this.runId, `❌ Error: ${err.message}`);
                scrapingLogs.markDone(this.runId, 'failed');
            }
            await this.updateRun('failed', {
                found: this.products.length, newProducts: 0, updated: 0, priceChanges: 0,
            }).catch(() => {});
            throw err;
        }
    }

    // El código del proveedor ("0030") queda en la oferta: el cruce de productos lo usa
    async guardarCodigosProveedor() {
        const pre = `PRE${String(this.supplier.prefix || '').toUpperCase()}`;
        const pares = this.products.filter(p => p.codigo_proveedor);
        if (pares.length === 0) return;
        await this.pool.query(
            `UPDATE supplier_products sp SET codigo_proveedor = v.codigo
             FROM UNNEST($2::text[], $3::text[]) AS v(sku, codigo)
             WHERE sp.supplier_id = $1 AND sp.sku = v.sku
               AND sp.codigo_proveedor IS DISTINCT FROM v.codigo`,
            [this.supplier.id, pares.map(p => pre + p.sku), pares.map(p => p.codigo_proveedor)]
        );
    }

    /**
     * Lo que no vino en esta lista queda no disponible (no se borra): Sync Preventas propone
     * archivarlo en Odoo y, si vuelve en otra lista, se reconoce y se reactiva.
     * Freno: si la lista trae menos de la mitad de lo que había, no se archiva nada.
     */
    async markUnavailableSince(runStartedAt) {
        if (this.dryRun) return 0;
        const { rows: [conteo] } = await this.pool.query(
            `SELECT COUNT(*) FILTER (WHERE last_scraped_at >= $2)::INTEGER AS vistos,
                    COUNT(*) FILTER (WHERE available OR last_scraped_at >= $2)::INTEGER AS total
             FROM supplier_products
             WHERE supplier_id = $1 AND source = 'web'`,
            [this.supplier.id, runStartedAt]
        );
        if (conteo.total > 0 && conteo.vistos < conteo.total * MIN_VISTOS_PARA_ARCHIVAR) {
            this.log(`⚠️ [Lista] La lista trae ${conteo.vistos} de ${conteo.total} productos ` +
                `(menos del ${MIN_VISTOS_PARA_ARCHIVAR * 100}%): no se archiva ninguno`);
            return 0;
        }
        const { rowCount } = await this.pool.query(
            `UPDATE supplier_products SET available = false, updated_at = NOW()
             WHERE supplier_id = $1 AND source = 'web' AND available AND last_scraped_at < $2`,
            [this.supplier.id, runStartedAt]
        );
        return rowCount;
    }
}

module.exports = ListaScraper;
