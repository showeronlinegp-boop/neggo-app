const PythonScraper = require('./pythonScraper');

/**
 * CastScraper — Cast Mayorista (WooCommerce, catálogo público).
 * Delega en cast_scraper.py, que lee la Store API pública de WooCommerce (JSON, sin navegador).
 * El script Python no necesita credenciales.
 */
class CastScraper extends PythonScraper {
    get pythonScript() {
        return 'cast_scraper.py';
    }
}

module.exports = CastScraper;
