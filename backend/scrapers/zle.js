const PythonScraper = require('./pythonScraper');

/**
 * ZleScraper — ZLE Store (zlestore.com, SPA con API RPC propia).
 * Delega en zle_scraper.py: lee el listado de /search y el detalle de cada producto
 * desde api.zlestore.com (JSON, sin navegador). Guarda una fila por variante (SKU de la variante)
 * con disponible = la web no lo muestra agotado.
 * Sin login la API no devuelve precios: credenciales de cliente en ZLE_EMAIL / ZLE_PASSWORD
 * (scrape_config.email/password solo como override puntual).
 */
class ZleScraper extends PythonScraper {
    get pythonScript() {
        return 'zle_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return {
            ZLE_EMAIL: config.email || process.env.ZLE_EMAIL || '',
            ZLE_PASSWORD: config.password || process.env.ZLE_PASSWORD || ''
        };
    }
}

module.exports = ZleScraper;
