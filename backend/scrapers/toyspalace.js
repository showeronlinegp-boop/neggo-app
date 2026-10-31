const PythonScraper = require('./pythonScraper');

/**
 * ToysPalaceScraper — Toys Palace (toyspalace.com.ar, WooCommerce).
 * Delega en toyspalace_scraper.py: el catálogo completo entra en una página (?product_count=)
 * y el precio que vale es el final (el tachado de "oferta" no es el real).
 */
class ToysPalaceScraper extends PythonScraper {
    get pythonScript() {
        return 'toyspalace_scraper.py';
    }
}

module.exports = ToysPalaceScraper;
