const PythonScraper = require('./pythonScraper');

/**
 * BlumenScraper — Distribuidora Blumen (tienda Sigma "sigkart").
 * Delega en blumen_scraper.py: entra con la cuenta de cliente (BLUMEN_EMAIL / BLUMEN_PASSWORD;
 * scrape_config.email/password solo como override puntual) y lee los artículos en JSON.
 */
class BlumenScraper extends PythonScraper {
    get pythonScript() {
        return 'blumen_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return {
            BLUMEN_EMAIL: config.email || process.env.BLUMEN_EMAIL || '',
            BLUMEN_PASSWORD: config.password || process.env.BLUMEN_PASSWORD || ''
        };
    }
}

module.exports = BlumenScraper;
