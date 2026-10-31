const PythonScraper = require('./pythonScraper');

/**
 * JorgeScraper — Importadora Jorge (importadorajorge.com.ar).
 * Delega en jorge_scraper.py: precios, promos y stock de la lista de precios completa
 * (/js_lista_precios.html) y nombre/SKU/foto/categoría del listado de cada categoría.
 */
class JorgeScraper extends PythonScraper {
    get pythonScript() {
        return 'jorge_scraper.py';
    }
}

module.exports = JorgeScraper;
