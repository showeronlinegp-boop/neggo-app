const PythonScraper = require('./pythonScraper');

/**
 * CastScraper — Cast Mayorista (WooCommerce, catálogo público).
 * Delega en cast_scraper.py (Selenium + Chromium Alpine).
 * El script Python no necesita credenciales.
 */
class CastScraper extends PythonScraper {
    get pythonScript() {
        return 'cast_scraper.py';
    }
}

module.exports = CastScraper;
