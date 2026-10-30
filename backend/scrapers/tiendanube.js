const PythonScraper = require('./pythonScraper');

/**
 * TiendanubeScraper — cualquier tienda Tiendanube (ej. El Rey del Sahumerio).
 * Delega en tiendanube_scraper.py: lee la grilla del catálogo por categorías con HTTP simple.
 * Catálogo: scrape_config.catalog_url o, si no está, la web del proveedor (website_url).
 */
class TiendanubeScraper extends PythonScraper {
    get pythonScript() {
        return 'tiendanube_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return { TN_CATALOG_URL: config.catalog_url || this.supplier.website_url || '' };
    }
}

module.exports = TiendanubeScraper;
