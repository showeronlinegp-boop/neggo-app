const PythonScraper = require('./pythonScraper');

/**
 * ElReyScraper — El Rey (catálogo Smarty con token).
 * Delega en elrey_scraper.py (Selenium + Chromium Alpine).
 * El token sale de scrape_config.token o de ELREY_TOKEN; si no hay ninguno, el script usa el
 * token por defecto. Las categorías salen de scrape_config.category_ids (array de IDs de Smarty).
 */
class ElReyScraper extends PythonScraper {
    get pythonScript() {
        return 'elrey_scraper.py';
    }

    get pythonEnv() {
        const config = this.supplier.scrape_config || {};
        const env = {};
        const token = config.token || process.env.ELREY_TOKEN;
        if (token) env.ELREY_TOKEN = token;
        if (Array.isArray(config.category_ids) && config.category_ids.length > 0) {
            env.ELREY_CATEGORY_IDS = JSON.stringify(config.category_ids);
        }
        return env;
    }
}

module.exports = ElReyScraper;
