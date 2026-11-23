// Idioma por defecto en las llamadas a Odoo (nota 217). Sin red.
// node backend/config/odoo.test.js

const assert = require('assert');
const { conIdioma, ODOO_LANG } = require('./odoo');

// Por defecto, español latinoamericano (el único idioma activo en Odoo)
assert.strictEqual(ODOO_LANG, process.env.ODOO_LANG || 'es_419');

// Sin kwargs: agrega el contexto con el idioma
assert.deepStrictEqual(conIdioma(undefined, 'es_419'), { context: { lang: 'es_419' } });

// Conserva el resto del contexto y de los kwargs
const original = { fields: ['name'], limit: 5, context: { allowed_company_ids: [1] } };
const conLang = conIdioma(original, 'es_419');
assert.deepStrictEqual(conLang, { fields: ['name'], limit: 5, context: { allowed_company_ids: [1], lang: 'es_419' } });
// No toca el objeto original (se reusa en varias llamadas)
assert.deepStrictEqual(original.context, { allowed_company_ids: [1] });

// Si la llamada pide otro idioma, se respeta
const enIngles = { context: { lang: 'en_US' } };
assert.strictEqual(conIdioma(enIngles, 'es_419'), enIngles);

// Sin idioma configurado, no cambia nada
const sinLang = { context: {} };
assert.strictEqual(conIdioma(sinLang, ''), sinLang);

console.log('✅ odoo.test.js: idioma por defecto OK');
