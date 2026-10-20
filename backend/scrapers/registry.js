const CastScraper = require('./cast');
const MaliScraper = require('./mali');
const ImpoteknóScraper = require('./impotekno');
const ElReyScraper = require('./elrey');
const NurcellScraper = require('./nurcell');
const ZleScraper = require('./zle');
const NeggoScraper = require('./neggoScraper');

/**
 * Mapa de scraper_key → clase scraper.
 * El scraper_key se almacena en la columna suppliers.scraper_key.
 */
const SCRAPER_REGISTRY = {
    'cast': CastScraper,
    'mali': MaliScraper,
    'impotekno': ImpoteknóScraper,
    'elrey': ElReyScraper,
    'nurcell': NurcellScraper,
    'zle': ZleScraper,
    // Fuente interna: productos de Neggo (no scrapea ninguna web)
    'neggo_scraper': NeggoScraper,
};

/**
 * Devuelve una instancia del scraper correspondiente al proveedor.
 *
 * @param {object} supplier — row de la tabla suppliers (debe tener scraper_key)
 * @param {object} pool     — instancia del pg pool
 * @returns {BaseScraper|null} — instancia del scraper, o null si no hay scraper para ese proveedor
 */
function getScraperForSupplier(supplier, pool) {
    if (!supplier || !supplier.scraper_key) {
        console.warn(`⚠️ [Registry] Proveedor sin scraper_key: "${supplier && supplier.name}"`);
        return null;
    }

    const ScraperClass = SCRAPER_REGISTRY[supplier.scraper_key];

    if (!ScraperClass) {
        console.warn(`⚠️ [Registry] No hay scraper registrado para la clave: "${supplier.scraper_key}"`);
        return null;
    }

    return new ScraperClass(supplier, pool);
}

/**
 * Lista las claves de scrapers disponibles.
 * @returns {string[]}
 */
function getAvailableKeys() {
    return Object.keys(SCRAPER_REGISTRY);
}

module.exports = { getScraperForSupplier, getAvailableKeys, SCRAPER_REGISTRY };
