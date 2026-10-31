// Condiciones de compra del proveedor (migración 054): validación y guardado.
// Se guardan juntas: si vienen, reemplazan las 6 columnas (vacío = NULL), así se pueden borrar.

const CAMPOS = ['odoo_vendor_name', 'pedido_minimo', 'flete_pct', 'demora_dias', 'acepta_auto', 'condiciones_nota'];

const vacio = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function numero(v) {
    if (vacio(v)) return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Normaliza y valida. Devuelve { valores } o { error } (el primero que encuentra).
 * @param {object} c — { odoo_vendor_name, pedido_minimo, flete_pct, demora_dias, acepta_auto, condiciones_nota }
 */
function normalizarCondiciones(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'Las condiciones tienen que ser un objeto' };

    const odoo = vacio(c.odoo_vendor_name) ? null : String(c.odoo_vendor_name).trim();
    if (odoo && odoo.length > 200) return { error: 'El nombre en Odoo puede tener hasta 200 caracteres' };

    const minimo = numero(c.pedido_minimo);
    if (Number.isNaN(minimo) || (minimo != null && minimo < 0)) return { error: 'El pedido mínimo tiene que ser un monto de 0 o más' };
    if (minimo != null && minimo >= 1e10) return { error: 'El pedido mínimo es demasiado grande' };

    const flete = numero(c.flete_pct);
    if (Number.isNaN(flete) || (flete != null && (flete < 0 || flete > 100))) return { error: 'El flete tiene que ser un porcentaje entre 0 y 100' };

    const demora = numero(c.demora_dias);
    if (Number.isNaN(demora) || (demora != null && (!Number.isInteger(demora) || demora < 0 || demora > 365))) {
        return { error: 'La demora tiene que ser una cantidad de días entera, entre 0 y 365' };
    }

    const nota = vacio(c.condiciones_nota) ? null : String(c.condiciones_nota).trim();
    if (nota && nota.length > 2000) return { error: 'Las notas pueden tener hasta 2000 caracteres' };

    return {
        valores: {
            odoo_vendor_name: odoo,
            pedido_minimo: minimo == null ? null : Math.round(minimo * 100) / 100,
            flete_pct: flete == null ? null : Math.round(flete * 100) / 100,
            demora_dias: demora,
            acepta_auto: c.acepta_auto === true,
            condiciones_nota: nota,
        },
    };
}

/**
 * Guarda las condiciones ya normalizadas.
 */
async function guardarCondiciones(db, supplierId, v) {
    await db.query(
        `UPDATE suppliers SET
            odoo_vendor_name = $2, pedido_minimo = $3, flete_pct = $4,
            demora_dias = $5, acepta_auto = $6, condiciones_nota = $7, updated_at = NOW()
         WHERE id = $1`,
        [supplierId, v.odoo_vendor_name, v.pedido_minimo, v.flete_pct, v.demora_dias, v.acepta_auto, v.condiciones_nota]
    );
}

module.exports = { CAMPOS, normalizarCondiciones, guardarCondiciones };
