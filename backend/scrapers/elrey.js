const PythonScraper = require('./pythonScraper');

/**
 * ElReyScraper — El Rey (catálogo Smarty con token).
 * Delega en elrey_scraper.py: lee cada categoría principal entera en una sola página
 * (?limit=) con HTTP simple, sin navegador, y después el resto del catálogo.
 * El token sale de scrape_config.token o de ELREY_TOKEN; si no hay ninguno, el script usa el
 * token por defecto.
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
        return env;
    }
}

module.exports = ElReyScraper;
