const PythonScraper = require('./pythonScraper');

/**
 * FancyYouScraper — Fancy You (fancyyou.com.ar).
 * Delega en fancyyou_scraper.py: el catálogo completo sale de la API JSON pública de la tienda
 * (/api/shop/fancyyou/catalog) en una sola descarga.
 */
class FancyYouScraper extends PythonScraper {
    get pythonScript() {
        return 'fancyyou_scraper.py';
    }
}

module.exports = FancyYouScraper;
