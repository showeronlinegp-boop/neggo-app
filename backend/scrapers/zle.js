const PythonScraper = require('./pythonScraper');

/**
 * ZleScraper — ZLE Store (zlestore.com, SPA con API RPC propia).
 * Delega en zle_scraper.py: lee el listado de /search y el detalle de cada producto
 * desde api.zlestore.com (JSON, sin navegador). Guarda una fila por variante (SKU de la variante)
 * con disponible = tiene stock. Sin login la API no devuelve precios.
 */
class ZleScraper extends PythonScraper {
    get pythonScript() {
        return 'zle_scraper.py';
    }
}

module.exports = ZleScraper;
