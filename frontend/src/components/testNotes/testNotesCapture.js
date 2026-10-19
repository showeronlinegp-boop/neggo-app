// Captura de contexto para las notas de prueba: errores de consola y llamadas a /api que fallaron.
// Se instala una sola vez en main.jsx, antes del render, para no perder los primeros errores.

const MAX = 15;
const consola = [];
const api = [];
let instalado = false;

function hora() {
    return new Date().toLocaleTimeString('es-AR', { hour12: false });
}

function empujar(buffer, item) {
    buffer.push(item);
    if (buffer.length > MAX) buffer.shift();
}

function texto(v) {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * @param {object} opts
 * @param {(url: string) => boolean} [opts.ignore] — URLs que no se registran (ej: la propia API de notas)
 */
export function installCapture({ ignore = () => false } = {}) {
    if (instalado || typeof window === 'undefined') return;
    instalado = true;

    const errorOriginal = console.error.bind(console);
    console.error = (...args) => {
        empujar(consola, { t: hora(), tipo: 'console.error', msg: args.map(texto).join(' ').slice(0, 500) });
        errorOriginal(...args);
    };

    window.addEventListener('error', e => {
        empujar(consola, { t: hora(), tipo: 'error', msg: `${e.message} (${e.filename || ''}:${e.lineno || ''})`.slice(0, 500) });
    });
    window.addEventListener('unhandledrejection', e => {
        empujar(consola, { t: hora(), tipo: 'promesa', msg: texto(e.reason).slice(0, 500) });
    });

    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = (init.method || input?.method || 'GET').toUpperCase();
        const registrar = url.includes('/api/') && !ignore(url);
        try {
            const res = await fetchOriginal(input, init);
            if (registrar && !res.ok) {
                let error = '';
                try { error = (await res.clone().json())?.error || ''; } catch { /* sin cuerpo JSON */ }
                empujar(api, { t: hora(), method, url: url.slice(0, 300), status: res.status, error: String(error).slice(0, 300) });
            }
            return res;
        } catch (err) {
            if (registrar) empujar(api, { t: hora(), method, url: url.slice(0, 300), status: 'sin respuesta', error: err.message });
            throw err;
        }
    };
}

/** Foto del contexto al momento de guardar una nota */
export function snapshotContext() {
    return {
        consola: [...consola],
        api: [...api],
        viewport: { w: window.innerWidth, h: window.innerHeight },
        userAgent: navigator.userAgent.slice(0, 200),
    };
}
