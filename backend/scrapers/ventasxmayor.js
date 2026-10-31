const PythonScraper = require('./pythonScraper');

/**
 * VentasXMayorScraper — tiendas VentasXMayor (ej. Importadora Al Costo).
 * Delega en ventasxmayor_scraper.py: productos del sitemap y datos de cada ficha (JSON-LD).
 * Tienda: scrape_config.site_url o, si no está, la web del proveedor (website_url).
 */
class VentasXMayorScraper extends PythonScraper {
    get pythonScript() {
        return 'ventasxmayor_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        const web = config.site_url || this.supplier.website_url || '';
        // Solo el origen: el scraper arma /sitemap.xml y /producto/...
        let origen = web;
        try { origen = new URL(web).origin; } catch (_) { /* queda como vino */ }
        return { VXM_SITE_URL: origen };
    }
}

module.exports = VentasXMayorScraper;
