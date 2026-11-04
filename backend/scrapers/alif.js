const PythonScraper = require('./pythonScraper');

/**
 * AlifScraper — Alif Cell (catálogo PHP, misma plataforma que Nurcell).
 * El sitio pide una clave de acceso. Sale de scrape_config.password o de ALIF_PASSWORD.
 * Delega en alif_scraper.py (urllib + BeautifulSoup, sin Chromium).
 */
class AlifScraper extends PythonScraper {
    get pythonScript() {
        return 'alif_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return {
            ALIF_PASSWORD: config.password || process.env.ALIF_PASSWORD || 'JJ',
        };
    }
}

module.exports = AlifScraper;
