const BaseScraper = require('./baseScraper');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const scrapingLogs = require('../services/scrapingLogs');

/**
 * NeggoScraper — fuente interna (scraper_key = 'neggo_scraper').
 * En vez de scrapear una web, toma los productos que Neggo tiene cargados para el proveedor
 * (product.supplierinfo del partner scrape_config.odoo_partner_id) y los guarda como
 * supplier_products con source = 'neggo'.
 *
 * SKU: PRE + prefijo + NEG + código de Neggo (o nombre sin acentos si no tiene código).
 *   Ej: Neggo "ML400237" → PREMLNEGML400237 · Neggo sin código "Abrelatas" → PRECYNEGABRELATAS
 * Precio: raw_price = costo de Neggo (ya incluye el descuento del proveedor).
 * Disponible: el producto está activo en Neggo.
 */
class NeggoScraper extends BaseScraper {

    // Texto en mayúsculas sin acentos ni símbolos (mismo formato que los códigos ya cargados en Odoo)
    static normalizar(texto) {
        return (texto || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    /**
     * Código base del producto: el default_code de Neggo si es un código real,
     * si no el nombre (con atributos si es una variante).
     */
    static codigoBase(prod) {
        const code = NeggoScraper.normalizar(prod.default_code);
        // Un código de 2 letras ("CY") es solo el prefijo del proveedor, no identifica al producto
        if (code.length > 2) return code;
        return NeggoScraper.normalizar(prod.display_name || prod.name);
    }

    log(msg) {
        console.log(msg);
        if (this.runId && this.runId !== 'preview') scrapingLogs.appendLog(this.runId, msg);
    }

    /**
     * Lee de Odoo las variantes de Neggo asociadas al proveedor.
     * @returns {Array} productos en el formato que espera upsertProducts
     */
    async fetchProductosNeggo() {
        const partnerId = parseInt(this.supplier.scrape_config?.odoo_partner_id, 10);
        if (!partnerId) {
            throw new Error(`"${this.supplier.name}" no tiene scrape_config.odoo_partner_id: no se puede saber qué productos de Neggo le corresponden`);
        }

        const { neggo: neggoId } = await getCompanyIds();
        if (!neggoId) throw new Error('No se encontró la empresa Neggo en Odoo');
        const ctx = { allowed_company_ids: [neggoId], active_test: false };

        // Templates de Neggo que tienen a este proveedor cargado
        const infos = await callOdoo('product.supplierinfo', 'search_read',
            [[['partner_id', '=', partnerId]]],
            { fields: ['product_tmpl_id'], context: ctx });
        const tmplIds = [...new Set(infos.map(i => i.product_tmpl_id && i.product_tmpl_id[0]).filter(Boolean))];
        this.log(`📦 [Neggo] ${tmplIds.length} productos de Neggo asociados a "${this.supplier.name}"`);
        if (tmplIds.length === 0) return [];

        // Variantes (product.product) de esos templates, solo de Neggo o compartidas
        const variantes = [];
        const BATCH = 500;
        for (let i = 0; i < tmplIds.length; i += BATCH) {
            const lote = await callOdoo('product.product', 'search_read',
                [[
                    ['product_tmpl_id', 'in', tmplIds.slice(i, i + BATCH)],
                    '|', ['company_id', '=', neggoId], ['company_id', '=', false],
                ]],
                {
                    fields: ['id', 'product_tmpl_id', 'default_code', 'name', 'display_name',
                             'standard_price', 'active', 'barcode', 'categ_id', 'product_template_variant_value_ids'],
                    context: ctx,
                });
            variantes.push(...lote);
        }

        // Código base de cada variante
        const productos = variantes.map(v => {
            const esVariante = (v.product_template_variant_value_ids || []).length > 0;
            const base = NeggoScraper.codigoBase({
                default_code: v.default_code,
                name: v.name,
                display_name: esVariante ? v.display_name.replace(/^\[[^\]]*\]\s*/, '') : v.name,
            });
            return { v, base };
        });
        // Código único: el primero conserva la base (la que ya existe en Odoo);
        // los repetidos pasan a base+nombre y, si aún choca, base+ID de Neggo
        const usados = new Set();
        return productos.map(({ v, base }) => {
            let codigo = base;
            if (usados.has(codigo)) codigo = base + NeggoScraper.normalizar(v.name);
            if (usados.has(codigo)) codigo = `${base}${v.id}`;
            usados.add(codigo);
            const templateId = v.product_tmpl_id ? v.product_tmpl_id[0] : null;
            return {
                // upsertProducts le antepone PRE + prefijo → PRE{XX}NEG{codigo}
                sku: `NEG${codigo}`,
                name: v.name,
                raw_price: Number(v.standard_price) || null,
                offer_price: null,
                image_url: templateId ? `/api/products/odoo-image/neggo/${templateId}` : null,
                product_url: null,
                barcode: v.barcode || null,
                source_category: v.categ_id ? v.categ_id[1] : null,
                available: v.active === true,
                source: 'neggo',
                neggo_odoo_id: v.id,
            };
        });
    }

    async run(triggeredBy) {
        await this.createRun(triggeredBy);

        try {
            this.log(`📦 [Neggo] Leyendo productos de Neggo para "${this.supplier.name}"`);
            this.products = await this.fetchProductosNeggo();

            if (this.onProduct) {
                for (const p of this.products) this.onProduct(p);
            }

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

            // 0 productos = el partner no tiene nada asociado en Neggo o falló Odoo: no borrar nada
            const finalStatus = this.products.length === 0 ? 'failed'
                : this.errors.length > 0 ? 'partial' : 'completed';

            // Los que ya no están asociados al proveedor en Neggo se eliminan (solo con run completo)
            const unavailable = finalStatus === 'completed'
                ? await this.markUnavailableSince(runStartedAt)
                : 0;

            const stats = {
                found: this.products.length,
                newProducts: upsertStats.new,
                updated: upsertStats.updated,
                priceChanges: upsertStats.priceChanges,
                unavailable,
            };
            await this.updateRun(finalStatus, stats);
            // Sin cleanupDuplicates(): las variantes de Neggo comparten nombre y no son duplicados

            const activos = this.products.filter(p => p.available).length;
            this.log(`📊 [Neggo] ${stats.found} productos (${activos} activos), ${stats.newProducts} nuevos, ` +
                `${stats.updated} actualizados, ${stats.priceChanges} cambios de precio, ${unavailable} eliminados`);
            scrapingLogs.markDone(this.runId, finalStatus);

            return { runId: this.runId, status: finalStatus, ...stats, errors: this.errors };

        } catch (err) {
            console.error(`❌ [Neggo] Error en "${this.supplier.name}": ${err.message}`);
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

    // No usa navegador
    async getCategories() {
        throw new Error('NeggoScraper no usa getCategories()');
    }

    async scrapeCategory() {
        throw new Error('NeggoScraper no usa scrapeCategory()');
    }
}

module.exports = NeggoScraper;
