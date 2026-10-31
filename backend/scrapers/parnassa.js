const PythonScraper = require('./pythonScraper');

/**
 * ParnassaScraper — Parnassa Importadora (parnassa.com.ar).
 * Delega en parnassa_scraper.py: categorías completas en una página + ficha de cada producto
 * para el código. raw_price = segundo escalón de precio por cantidad; el 10 % de descuento
 * se configura como descuento del proveedor.
 */
class ParnassaScraper extends PythonScraper {
    get pythonScript() {
        return 'parnassa_scraper.py';
    }
}

module.exports = ParnassaScraper;
