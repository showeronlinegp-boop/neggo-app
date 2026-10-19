// Lógica pura del "Marcar en pantalla": selector estable, descripción del elemento y posición.

// Marca de la UI propia de las notas (FABs, panel, pines, capa de marcado)
export const OWN_UI_ATTR = 'data-test-notes';

export function isOwnUi(el) {
    return !!el?.closest?.(`[${OWN_UI_ATTR}]`);
}

function cssEscape(s) {
    return window.CSS?.escape ? window.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

// Un id generado (números largos, hashes) no sirve para volver a encontrar el elemento
function idUsable(id) {
    return id && !/\d{4,}|:|^[0-9]/.test(id);
}

function esUnico(selector, doc = document) {
    try { return doc.querySelectorAll(selector).length === 1; } catch { return false; }
}

/**
 * Selector CSS para volver a encontrar el elemento. Prefiere anclas estables:
 * data-testid → #id → [aria-label] único → tag:nth-of-type(n) subiendo hasta un ancla o body.
 */
export function buildSelector(el, doc = document) {
    if (!el || el.nodeType !== 1) return null;
    const anclaDe = node => {
        const testId = node.getAttribute('data-testid');
        if (testId) {
            const s = `[data-testid="${cssEscape(testId)}"]`;
            if (esUnico(s, doc)) return s;
        }
        if (idUsable(node.id)) {
            const s = `#${cssEscape(node.id)}`;
            if (esUnico(s, doc)) return s;
        }
        const aria = node.getAttribute('aria-label');
        if (aria) {
            const s = `${node.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
            if (esUnico(s, doc)) return s;
        }
        return null;
    };

    const partes = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'BODY') {
        const ancla = anclaDe(node);
        if (ancla) {
            partes.unshift(ancla);
            return partes.join(' > ');
        }
        const tag = node.tagName.toLowerCase();
        const hermanos = node.parentElement
            ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
            : [];
        partes.unshift(hermanos.length > 1 ? `${tag}:nth-of-type(${hermanos.indexOf(node) + 1})` : tag);
        node = node.parentElement;
    }
    partes.unshift('body');
    return partes.join(' > ');
}

/** Texto corto que identifica al elemento para una persona */
export function describeElement(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const pista = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')
        || el.getAttribute('alt') || (el.innerText || el.textContent || '').trim();
    const limpio = pista.replace(/\s+/g, ' ').slice(0, 80);
    return limpio ? `${tag} "${limpio}"` : tag;
}

export function findBySelector(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch { return null; }
}

/** Contenedor que scrollea (el <main> del layout) o la página */
export function scrollRoot() {
    return document.querySelector('[data-app-main]') || document.scrollingElement || document.documentElement;
}

/** Posición guardada como respaldo si el elemento ya no existe: x en fracción del ancho, y en px del contenido */
export function relativePosition(clientX, clientY) {
    const root = scrollRoot();
    const rect = root.getBoundingClientRect();
    return {
        pos_x: Math.min(Math.max((clientX - rect.left) / (rect.width || 1), 0), 1),
        pos_y: clientY - rect.top + root.scrollTop,
    };
}

/** Coordenadas de pantalla (fixed) del pin de una nota, o null si no se ve */
export function pinPosition(nota) {
    const el = findBySelector(nota.selector);
    if (el) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) return { x: r.left + Math.min(r.width, 24) - 6, y: r.top - 6, exacto: true };
    }
    if (nota.pos_x == null || nota.pos_y == null) return null;
    const root = scrollRoot();
    const rect = root.getBoundingClientRect();
    return {
        x: rect.left + Number(nota.pos_x) * rect.width,
        y: rect.top + Number(nota.pos_y) - root.scrollTop,
        exacto: false,
    };
}
