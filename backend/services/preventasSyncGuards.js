// Protecciones del Sync Preventas: deciden si una acción se puede escribir en Odoo.
// Funciones puras (sin DB ni Odoo) para poder testearlas aisladas:
//   node backend/services/preventasSyncGuards.test.js
//
//   motivoOmitir   → datos inválidos o viejos: la acción NO se aplica nunca (ni confirmando)
//   motivoRevision → la acción puede estar mal: solo se aplica confirmándola de a un producto
//   motivoOdoo     → Odoo cambió desde el último sync: no se pisa lo que está en Odoo

// Cambio de costo (%) a partir del cual se pide revisión manual
const UMBRAL_REVISION_PCT = 20;
// Vínculos por nombre parecido por debajo de este puntaje requieren revisión (regla de negocio)
const FUZZY_MIN_AUTOMATICO = 90;
// Diferencia en $ que se considera un cambio real (evita falsos positivos por redondeo)
const TOL_PESOS = 0.01;

const ESTADOS_PRECIO = ['precio_sube', 'precio_baja'];
const ESTADOS_ODOO = ['activar', 'inactivar', 'solo_odoo', 'precio_sube', 'precio_baja'];

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Código del producto escrito en el nombre entre {} o (), normalizado a A-Z0-9.
 * "PEINE (MAB07) COLA" → "MAB07" · "VASO (FH-105)" → "FH105". Sin código → null.
 */
function codigoEnNombre(nombre) {
    if (!nombre) return null;
    const m = String(nombre).match(/[{(]([A-Za-z0-9][A-Za-z0-9._/ -]{2,30})[})]/);
    if (!m) return null;
    const code = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Un número solo (cantidades como "(144)") no identifica al producto
    return code.length >= 3 && /[A-Z]/.test(code) ? code : null;
}

/**
 * Datos que impiden aplicar la acción. Devuelve el motivo o null.
 * prod: fila de preventas_sync_state con datos del scraper, del cache de Odoo y
 *       costo_actual/precio_actual (recalculados con el precio scrapeado de ahora).
 */
function motivoOmitir(prod) {
    if (prod.proveedor_scrapeando) {
        return 'Se está scrapeando este proveedor: esperá a que termine y recalculá';
    }
    // El producto del scraper ya no existe (se borró después del último cálculo)
    if (prod.supplier_product_id && prod.sp_existe === false) {
        return 'El producto ya no está en el scraper: recalculá';
    }

    if (prod.estado === 'solo_scraper' || ESTADOS_PRECIO.includes(prod.estado)) {
        const costo = num(prod.costo);
        const precio = num(prod.precio_preventas);
        if (!(costo > 0) || !(precio > 0)) {
            return 'Sin precio válido (costo o precio en 0 o vacío)';
        }
        // El precio scrapeado cambió desde el último cálculo: lo calculado está viejo
        const costoActual = num(prod.costo_actual);
        const precioActual = num(prod.precio_actual);
        if (costoActual === null || precioActual === null
            || Math.abs(costoActual - costo) > TOL_PESOS
            || Math.abs(precioActual - precio) > TOL_PESOS) {
            return 'El precio del proveedor cambió desde el último cálculo: recalculá';
        }
    }

    if (prod.estado === 'solo_scraper') {
        if (!prod.scraper_sku) return 'El producto no tiene SKU';
        if (!prod.scraper_name || !String(prod.scraper_name).trim()) return 'El producto no tiene nombre';
    }
    return null;
}

/**
 * Acciones que pueden estar mal y requieren confirmación de a un producto. Motivo o null.
 */
function motivoRevision(prod) {
    if (prod.match_type === 'fuzzy_name' && num(prod.match_score) < FUZZY_MIN_AUTOMATICO) {
        return `Vinculado por nombre parecido (${num(prod.match_score)}%): confirmá que sea el mismo producto`;
    }

    const codScraper = codigoEnNombre(prod.scraper_name);
    const codOdoo = codigoEnNombre(prod.odoo_nombre);
    if (codScraper && codOdoo && codScraper !== codOdoo) {
        return `El código del nombre no coincide (${codScraper} en el proveedor, ${codOdoo} en Odoo)`;
    }

    if (ESTADOS_PRECIO.includes(prod.estado)) {
        const costo = num(prod.costo);
        const costoOdoo = num(prod.odoo_standard_price);
        if (costo !== null && costoOdoo > 0) {
            const pct = ((costo - costoOdoo) / costoOdoo) * 100;
            if (Math.abs(pct) > UMBRAL_REVISION_PCT) {
                return `Cambio de costo de ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% (más del ${UMBRAL_REVISION_PCT}%)`;
            }
        }
    }
    return null;
}

/**
 * Compara el producto leído de Odoo recién con lo que tenía el cache al calcular.
 * odoo: { standard_price, active } o null si el producto ya no existe en Odoo.
 */
function motivoOdoo(prod, odoo) {
    if (!ESTADOS_ODOO.includes(prod.estado)) return null;
    if (!odoo) return 'El producto ya no existe en Odoo: sincronizá Odoo';

    if (prod.estado === 'activar' && odoo.active === true) return 'Ya está activo en Odoo';
    if ((prod.estado === 'inactivar' || prod.estado === 'solo_odoo') && odoo.active === false) {
        return 'Ya está archivado en Odoo';
    }
    if (ESTADOS_PRECIO.includes(prod.estado)) {
        const enCache = num(prod.odoo_standard_price);
        const enOdoo = num(odoo.standard_price);
        if (enCache === null || enOdoo === null || Math.abs(enCache - enOdoo) > TOL_PESOS) {
            return 'El costo cambió en Odoo desde el último sync: sincronizá Odoo y revisalo';
        }
    }
    return null;
}

module.exports = {
    codigoEnNombre, motivoOmitir, motivoRevision, motivoOdoo,
    UMBRAL_REVISION_PCT, FUZZY_MIN_AUTOMATICO, ESTADOS_ODOO,
};
