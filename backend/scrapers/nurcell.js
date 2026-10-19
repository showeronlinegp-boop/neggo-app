const PythonScraper = require('./pythonScraper');

/**
 * NurcellScraper — Nurcell (catálogo PHP, misma plataforma que Impotekno).
 * En Odoo Precompras sus productos usan el prefijo BB (proveedor "Babu").
 * Delega en nurcell_scraper.py (urllib + BeautifulSoup, sin Chromium).
 * El script no necesita credenciales ni configuración extra.
 */
class NurcellScraper extends PythonScraper {
    get pythonScript() {
        return 'nurcell_scraper.py';
    }
}

module.exports = NurcellScraper;
