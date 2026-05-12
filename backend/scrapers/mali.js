const PythonScraper = require('./pythonScraper');

/**
 * MaliScraper — Mali Mayorista (OpenCart con login).
 * Delega en mali_scraper.py (Selenium + Chromium Alpine).
 * Credenciales tomadas de scrape_config del supplier.
 */
class MaliScraper extends PythonScraper {
    get pythonScript() {
        return 'mali_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        return {
            MALI_USERNAME: config.username || '',
            MALI_PASSWORD: config.password || ''
        };
    }
}

module.exports = MaliScraper;
