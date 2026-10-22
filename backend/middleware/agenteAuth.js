// Autenticación de la API del agente (Grok Bot): API key fija en AGENTE_API_KEY, sin JWT ni usuarios.
// Sin clave configurada (o con una corta) la API queda deshabilitada: nunca abierta.
const crypto = require('crypto');
const { fail } = require('../utils/response');

const MIN_KEY_LENGTH = 32;

function agenteAuth(req, res, next) {
    const expected = process.env.AGENTE_API_KEY || '';
    if (expected.length < MIN_KEY_LENGTH) {
        return fail(res, 'API del agente deshabilitada', 503);
    }
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/);
    if (!match) return fail(res, 'API key inválida', 401);

    const given = Buffer.from(match[1].trim());
    const wanted = Buffer.from(expected);
    // timingSafeEqual exige el mismo largo: se compara antes
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
        return fail(res, 'API key inválida', 401);
    }
    // Para el activity log: el actor es el agente, no un usuario de la app
    req.agente = true;
    return next();
}

module.exports = { agenteAuth, MIN_KEY_LENGTH };
