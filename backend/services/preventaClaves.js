// Claves para cruzar un código de boleta con las referencias de Odoo Preventas.
// Se usa solo en Ingreso de mercadería. Sin base ni Odoo.

const { baseCode } = require('../utils/textMatch');

// Proveedores cuya boleta repite la sigla adentro del código:
// ZLE factura "ZLE-BCA-32-01" y en Preventas el producto es "PREZLBCA3201".
const SIGLA_EN_CODIGO = { ZL: 'ZLE' };

// Deja solo letras y números: la boleta trae guiones, espacios, # y /.
function normClave(valor) {
    return String(valor || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * @returns {{ conPrefijo: string[], sinPrefijo: string[] }} claves posibles del código.
 * conPrefijo es la coincidencia fuerte; sinPrefijo, el respaldo sin prefijo de proveedor.
 */
function clavesPreventa(codigo, supplierPrefix) {
    const base = normClave(baseCode(String(codigo || '')));
    if (base.length < 2) return { conPrefijo: [], sinPrefijo: [] };

    const prefijo = normClave(supplierPrefix);
    const conPrefijo = [`PRE${prefijo}${base}`];

    const sigla = SIGLA_EN_CODIGO[prefijo];
    if (sigla && base.startsWith(sigla) && base.length > sigla.length) {
        conPrefijo.push(`PRE${prefijo}${base.slice(sigla.length)}`);
    }

    return { conPrefijo, sinPrefijo: [`PRE${base}`] };
}

module.exports = { normClave, clavesPreventa };
