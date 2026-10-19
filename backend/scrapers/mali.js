const PythonScraper = require('./pythonScraper');

/**
 * MaliScraper — Mali Mayorista (OpenCart con login).
 * Delega en mali_scraper.py (Selenium + Chromium Alpine).
 * Credenciales tomadas de las variables de entorno MALI_USERNAME / MALI_PASSWORD
 * (scrape_config.username/password solo como override puntual).
 */
class MaliScraper extends PythonScraper {
    get pythonScript() {
        return 'mali_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return {
            MALI_USERNAME: config.username || process.env.MALI_USERNAME || '',
            MALI_PASSWORD: config.password || process.env.MALI_PASSWORD || ''
        };
    }
}

module.exports = MaliScraper;
