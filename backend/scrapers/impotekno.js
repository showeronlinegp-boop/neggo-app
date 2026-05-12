const PythonScraper = require('./pythonScraper');

/**
 * ImpoteknóScraper — Impotekno (catálogo PHP, carga dinámica).
 * Delega en impotekno_scraper.py (Selenium + Chromium Alpine).
 * El script no necesita credenciales ni configuración extra.
 */
class ImpoteknóScraper extends PythonScraper {
    get pythonScript() {
        return 'impotekno_scraper.py';
    }
}

module.exports = ImpoteknóScraper;
