// Leyenda "no usar" (nota 118): un producto de Odoo cuyo nombre empieza con la leyenda queda
// fuera de toda la app. El sync no lo trae al cache y el scraper de origen "neggo" no lo lee,
// así que no se vuelve a vincular, activar ni sugerir. Se pone desde Vínculos → Conflictos
// o a mano en Odoo; sacándola del nombre, el próximo sync lo vuelve a traer.

const LEYENDA_NO_USAR = '[NO USAR]';

/**
 * ¿El nombre lleva la leyenda? (sin importar mayúsculas ni espacios al principio)
 * @param {string|null} nombre
 */
function esNoUsar(nombre) {
    return typeof nombre === 'string' && nombre.trim().toUpperCase().startsWith(LEYENDA_NO_USAR);
}

/**
 * Nombre con la leyenda adelante (si ya la tiene, queda igual).
 * @param {string|null} nombre
 */
function conLeyendaNoUsar(nombre) {
    const limpio = (nombre || '').trim();
    if (esNoUsar(limpio)) return limpio;
    return limpio ? `${LEYENDA_NO_USAR} ${limpio}` : LEYENDA_NO_USAR;
}

module.exports = { LEYENDA_NO_USAR, esNoUsar, conLeyendaNoUsar };
