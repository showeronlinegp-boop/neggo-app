// Validación de los encargues a cotizar (nota 248). Sin base: se prueba aislado.

const TIPOS = ['cliente', 'prospecto'];
const ESTADOS = ['pendiente', 'cotizado', 'avisado', 'no_se_consigue'];
// A qué estado se puede pasar desde cada uno
const PASOS = {
    pendiente: ['cotizado', 'no_se_consigue'],
    cotizado: ['avisado', 'pendiente', 'no_se_consigue'],
    avisado: ['pendiente', 'cotizado'],
    no_se_consigue: ['pendiente'],
};

function texto(v, max) {
    if (v === undefined || v === null) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
}

function numero(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
}

function contacto(tipo, id) {
    const n = Number(id);
    if (!TIPOS.includes(tipo) || !Number.isInteger(n) || n <= 0) return null;
    return { tipo, id: n };
}

/** Alta: { texto, cantidad?, nota?, contacto_nombre? } → { value, error } */
function validarAlta(body = {}) {
    const t = texto(body.texto, 500);
    if (!t) return { error: 'Escribí qué te pidieron' };
    const cantidad = numero(body.cantidad);
    if (Number.isNaN(cantidad) || (cantidad !== null && cantidad <= 0)) return { error: 'La cantidad tiene que ser un número mayor a cero' };
    return {
        value: {
            texto: t,
            cantidad,
            nota: texto(body.nota, 1000),
            contacto_nombre: texto(body.contacto_nombre, 200),
        },
    };
}

/** Edición: solo lo que viene. */
function validarEdicion(body = {}) {
    const value = {};
    if ('texto' in body) {
        const t = texto(body.texto, 500);
        if (!t) return { error: 'Escribí qué te pidieron' };
        value.texto = t;
    }
    if ('cantidad' in body) {
        const c = numero(body.cantidad);
        if (Number.isNaN(c) || (c !== null && c <= 0)) return { error: 'La cantidad tiene que ser un número mayor a cero' };
        value.cantidad = c;
    }
    if ('nota' in body) value.nota = texto(body.nota, 1000);
    if (!Object.keys(value).length) return { error: 'No hay nada para cambiar' };
    return { value };
}

/** Cambio de estado: { estado, precio?, proveedor? }. Cotizado pide el precio. */
function validarEstado(actual, body = {}) {
    const estado = body.estado;
    if (!ESTADOS.includes(estado)) return { error: 'Estado inválido' };
    if (!(PASOS[actual] || []).includes(estado)) return { error: 'Ese cambio no se puede hacer' };
    const value = { estado };
    if (estado === 'cotizado') {
        const precio = numero(body.precio);
        if (precio === null || Number.isNaN(precio) || precio < 0) return { error: 'Cargá el precio que te pasaron' };
        value.precio = precio;
        value.proveedor = texto(body.proveedor, 200);
    }
    return { value };
}

module.exports = { TIPOS, ESTADOS, PASOS, contacto, validarAlta, validarEdicion, validarEstado };
