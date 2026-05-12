// Utilidades de matching de texto compartidas entre servicios

/**
 * Normaliza un string: minusculas, sin acentos, sin caracteres especiales.
 */
function normalize(s) {
    if (!s) return '';
    return String(s)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // eliminar diacriticos
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Distancia de Levenshtein entre dos strings.
 */
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    // dp[i][j] = distancia entre a[0..i-1] y b[0..j-1]
    const dp = [];
    for (let i = 0; i <= m; i++) {
        dp[i] = new Array(n + 1).fill(0);
        dp[i][0] = i;
    }
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
}

/**
 * Similitud entre dos strings (0-1, basada en Levenshtein).
 */
function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const longer = a.length > b.length ? a : b;
    const dist   = levenshtein(a, b);
    return (longer.length - dist) / longer.length;
}

/**
 * Extrae el codigo base de un SKU del scraper quitando el prefijo y los guiones.
 * "imptk-INF-1093" -> "INF1093" | "elrey-360" -> "360"
 */
const SCRAPER_PREFIXES = ['imptk-', 'elrey-', 'mali-', 'cast-'];
function baseCode(sku) {
    if (!sku) return '';
    const lower = sku.toLowerCase();
    for (const prefix of SCRAPER_PREFIXES) {
        if (lower.startsWith(prefix)) {
            return sku.slice(prefix.length).replace(/-/g, '').toUpperCase();
        }
    }
    return sku.replace(/-/g, '').toUpperCase();
}

module.exports = { normalize, similarity, levenshtein, baseCode };
