const PythonScraper = require('./pythonScraper');

/**
 * OdooShopScraper — tiendas hechas con el e-commerce de Odoo (ej. Nueva Roma).
 * Delega en odooshop_scraper.py: recorre /shop (y sus categorías) página por página.
 * Tienda: scrape_config.site_url o, si no está, el origen de la web del proveedor (website_url).
 */
class OdooShopScraper extends PythonScraper {
    get pythonScript() {
        return 'odooshop_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        const web = config.site_url || this.supplier.website_url || '';
        let origen = web;
        try { origen = new URL(web).origin; } catch (_) { /* queda como vino */ }
        return { ODOO_SHOP_URL: origen };
    }
}

module.exports = OdooShopScraper;
