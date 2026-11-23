// Protecciones del Sync Preventas: deciden si una acción se puede escribir en Odoo.
// Funciones puras (sin DB ni Odoo) para poder testearlas aisladas:
//   node backend/services/preventasSyncGuards.test.js
//
//   motivoOmitir   → datos inválidos o viejos: la acción NO se aplica nunca (ni confirmando)
//   motivoRevision → la acción puede estar mal: se confirma de a un producto si el vínculo es
//                    dudoso; si es solo un cambio de costo grande, también se acepta en bloque a propósito
//   motivoOdoo     → Odoo cambió desde el último sync: no se pisa lo que está en Odoo

// Cambio de costo (%) a partir del cual se pide revisión manual
const UMBRAL_REVISION_PCT = 20;
// Vínculos por nombre parecido por debajo de este puntaje requieren revisión (regla de negocio)
const FUZZY_MIN_AUTOMATICO = 90;
// Diferencia en $ que se considera un cambio real (evita falsos positivos por redondeo)
const TOL_PESOS = 0.01;

const ESTADOS_PRECIO = ['precio_sube', 'precio_baja'];
// Estados que archivan el producto en Odoo; sin_foto: activo sin foto en ningún lado (nota 203)
const ESTADOS_ARCHIVAN = ['inactivar', 'sin_foto', 'solo_odoo', 'fuera_preventas'];
const ESTADOS_ODOO = ['activar', 'publicar', ...ESTADOS_ARCHIVAN, 'precio_sube', 'precio_baja'];

// Categoría del proveedor para las ofertas que no traen ninguna (ej. filas del Excel de Pan Lin):
// en Sync Preventas se les puede poner una regla como a cualquier otra categoría (nota 200)
const SIN_CATEGORIA = '(Sin categoría)';
// Expresión SQL de la categoría del proveedor para buscar su regla en Sync Preventas
const CATEGORIA_PROVEEDOR_SQL = `COALESCE(NULLIF(TRIM(sp.source_category), ''), '${SIN_CATEGORIA}')`;

// El proveedor tiene una foto de verdad (no el cartel "sin foto" de su web). Necesita sp.
// Si la "foto del proveedor" es la de Odoo Neggo y la caché dice que allá tampoco hay foto, no hay
// nada que copiar: no cuenta (nota 201). Si la caché no conoce el producto, se intenta igual.
const FOTO_PROVEEDOR_SQL = `(COALESCE(sp.image_url, '') <> '' AND sp.image_url !~* 'no-photo'
    AND NOT (sp.image_url ~ '^/api/products/odoo-image/neggo/[0-9]+$' AND COALESCE((
        SELECT bool_or(n.has_image) FROM odoo_products_cache n
        WHERE n.company = 'neggo' AND n.template_id = substring(sp.image_url from '([0-9]+)$')::int
    ), true) = false))`;

// Template de un producto de Neggo con foto vinculado (confirmado) a la oferta: si el proveedor no
// tiene foto, se usa esa (nota 203). Primero los activos. spId: la columna con el id de la oferta.
const neggoFotoSubq = (spId = 'pss.supplier_product_id') => `SELECT n.template_id
    FROM product_mappings pn
    JOIN odoo_products_cache n ON n.odoo_id = pn.odoo_product_id AND n.company = 'neggo'
    WHERE pn.supplier_product_id = ${spId}
      AND pn.odoo_company = 'neggo' AND pn.estado = 'confirmado'
      AND n.has_image = true AND n.template_id IS NOT NULL
    ORDER BY n.active DESC, pn.id
    LIMIT 1`;

// Ni el proveedor ni el producto de Neggo vinculado tienen foto (nota 203). Necesita sp.
const SIN_FOTO_DISPONIBLE_SQL = `(NOT ${FOTO_PROVEEDOR_SQL} AND NOT EXISTS (${neggoFotoSubq('sp.id')}))`;

// Acciones que dejan el producto publicado en la web de Precompras (nota 200):
// crear y publicar, activar y publicar, publicar; y completar categoría de lo ya publicado
const ESTADOS_PUBLICAN = ['solo_scraper', 'activar', 'publicar', 'categoria'];

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// Acciones que ponen un producto a la venta: sin precio del proveedor no se hacen
const ESTADOS_CON_PRECIO = ['solo_scraper', 'activar', ...ESTADOS_PRECIO];

/**
 * Crear, activar o actualizar precio sin costo/precio válido (NULL o ≤ 0) nunca se sincroniza.
 * Caso típico: ZLE sin cuenta de cliente devuelve todos los precios vacíos; activar esos
 * productos los pondría a la venta en Odoo con el precio viejo.
 */
function motivoSinPrecio(prod) {
    if (!ESTADOS_CON_PRECIO.includes(prod.estado)) return null;
    const costo = num(prod.costo);
    const precio = num(prod.precio_preventas);
    if (!(costo > 0) || !(precio > 0)) return 'Sin precio válido (costo o precio en 0 o vacío): no se sincroniza';
    return null;
}

/**
 * Categoría de Preventas con la que se publica: la de la regla del proveedor para esa categoría
 * suya; si no hay regla, la que el producto ya tiene en Odoo (crear siempre necesita la regla).
 * "All" es la categoría por defecto de Odoo: no cuenta. Devuelve el nombre, o null.
 */
function categoriaPublicacion(prod) {
    if (prod.odoo_categ_id_preventas) return prod.regla_categoria_preventas || prod.odoo_categoria || '(regla)';
    if (prod.estado === 'solo_scraper') return null;
    const enOdoo = String(prod.odoo_categoria || '').trim();
    if (!enOdoo || /^all(\s*\/|$)/i.test(enOdoo)) return null;
    return enOdoo;
}

/**
 * Crear, activar o publicar sin categoría de Preventas no se hace: el producto quedaría en la web
 * sin categoría. Se asigna en Proveedores → Categorías pendientes (nota 200).
 */
function motivoSinCategoria(prod) {
    if (!ESTADOS_PUBLICAN.includes(prod.estado)) return null;
    if (categoriaPublicacion(prod)) return null;
    return 'Falta la categoría de Preventas: asignala en Proveedores → Categorías pendientes';
}

/**
 * Clave para encontrar la categoría web con el mismo nombre que la de Preventas (nota 200):
 * último tramo, sin acentos ni "de". "Accesorios de Moda" → "accesorios moda" = "Accesorios Moda"
 */
function claveCategoria(nombre) {
    return String(nombre || '').split('/').pop()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
        .split(' ').filter(p => p && !['de', 'del', 'la', 'el', 'y'].includes(p)).join(' ');
}

/**
 * Crear sin foto no se hace: un producto sin foto en la web de Precompras se archiva (nota 203).
 * prod.sin_foto_disponible: ni el proveedor ni el producto de Neggo vinculado tienen foto.
 */
function motivoSinFoto(prod) {
    if (prod.estado !== 'solo_scraper' || prod.sin_foto_disponible !== true) return null;
    return 'Sin foto (ni del proveedor ni de Neggo): no se crea';
}

/** Lo que impide aplicar la fila aunque se confirme: sin precio, sin categoría o sin foto */
function motivoBloqueo(prod) {
    return motivoSinPrecio(prod) || motivoSinCategoria(prod) || motivoSinFoto(prod);
}

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

    const bloqueo = motivoBloqueo(prod);
    if (bloqueo) return bloqueo;

    if (prod.estado === 'solo_scraper' || ESTADOS_PRECIO.includes(prod.estado)) {
        const costo = num(prod.costo);
        const precio = num(prod.precio_preventas);
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
 * Revisión por el vínculo: puede ser OTRO producto (nombre parecido o código distinto).
 * Se confirma de a un producto, nunca en bloque. Motivo o null.
 */
function motivoRevisionVinculo(prod) {
    // Vínculo confirmado en la tabla maestra (product_mappings de Preventas): ya se revisó que
    // es el mismo producto, no se vuelve a pedir (nota 143)
    if (prod.vinculo_confirmado === true) return null;

    if (prod.match_type === 'fuzzy_name' && num(prod.match_score) < FUZZY_MIN_AUTOMATICO) {
        return `Vinculado por nombre parecido (${num(prod.match_score)}%): confirmá que sea el mismo producto`;
    }

    const codScraper = codigoEnNombre(prod.scraper_name);
    const codOdoo = codigoEnNombre(prod.odoo_nombre);
    if (codScraper && codOdoo && codScraper !== codOdoo) {
        return `El código del nombre no coincide (${codScraper} en el proveedor, ${codOdoo} en Odoo)`;
    }
    return null;
}

/**
 * Revisión por un cambio de costo grande (más del umbral). Es el mismo producto: se puede
 * aceptar en bloque si el usuario lo pide a propósito (nota 145). Motivo o null.
 */
function motivoRevisionCosto(prod) {
    if (!ESTADOS_PRECIO.includes(prod.estado)) return null;
    const costo = num(prod.costo);
    const costoOdoo = num(prod.odoo_standard_price);
    if (costo === null || !(costoOdoo > 0)) return null;
    const pct = ((costo - costoOdoo) / costoOdoo) * 100;
    if (Math.abs(pct) <= UMBRAL_REVISION_PCT) return null;
    return `Cambio de costo de ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% (más del ${UMBRAL_REVISION_PCT}%)`;
}

/**
 * Acciones que pueden estar mal y requieren confirmación. Motivo o null.
 * opciones.aceptarCambioCosto: el usuario aceptó los cambios de costo grandes (queda solo el vínculo)
 */
function motivoRevision(prod, opciones = {}) {
    return motivoRevisionVinculo(prod)
        || (opciones.aceptarCambioCosto === true ? null : motivoRevisionCosto(prod));
}

/** Qué revisión pide la fila: 'vinculo' | 'costo' | null */
function tipoRevision(prod) {
    if (motivoRevisionVinculo(prod)) return 'vinculo';
    if (motivoRevisionCosto(prod)) return 'costo';
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
    if (prod.estado === 'publicar') {
        if (odoo.active === false) return 'Está archivado en Odoo: sincronizá Odoo';
        if (odoo.is_published === true) return 'Ya está publicado en la web';
    }
    if (ESTADOS_ARCHIVAN.includes(prod.estado) && odoo.active === false) {
        return 'Ya está archivado en Odoo';
    }
    // La caché decía que no tenía foto, pero en Odoo ya tiene: no se archiva (nota 203)
    if (prod.estado === 'sin_foto' && odoo.tiene_foto === true) return 'Ya tiene foto en Odoo: no se archiva';
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
    codigoEnNombre, motivoSinPrecio, motivoSinCategoria, motivoSinFoto, motivoBloqueo, categoriaPublicacion, claveCategoria,
    motivoOmitir, motivoRevision, motivoRevisionVinculo, motivoRevisionCosto, tipoRevision, motivoOdoo,
    UMBRAL_REVISION_PCT, FUZZY_MIN_AUTOMATICO, ESTADOS_ODOO, ESTADOS_PUBLICAN, ESTADOS_ARCHIVAN,
    SIN_CATEGORIA, CATEGORIA_PROVEEDOR_SQL, FOTO_PROVEEDOR_SQL, SIN_FOTO_DISPONIBLE_SQL, neggoFotoSubq,
};
