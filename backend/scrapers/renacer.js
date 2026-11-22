const PythonScraper = require('./pythonScraper');

/**
 * RenacerScraper — Distribuidora El Renacer (elrenacer.com.ar, tienda Kit Digital).
 * Delega en renacer_scraper.py: la home trae el catálogo entero embebido (una sola descarga).
 * Reemplaza la carga a mano de la lista en PDF/Excel: mismos códigos, así se conservan los vínculos.
 * Web: scrape_config.site_url o, si no está, la web del proveedor (website_url).
 */
class RenacerScraper extends PythonScraper {
    get pythonScript() {
        return 'renacer_scraper.py';
    }

    // El código de la web es único y es el SKU: no buscar por nombre. Renacer tiene productos
    // distintos con el mismo nombre (IGB157 / IGB158) y uno nuevo pisaría el precio de otro.
    get buscaPorNombre() {
        return false;
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        const url = config.site_url || this.supplier.website_url;
        return url ? { RN_SITE_URL: url } : {};
    }
}

module.exports = RenacerScraper;
