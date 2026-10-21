// Textos y formatos compartidos por las pantallas del CRM de clientes.

// Estado del cliente medido contra su propio ritmo de compra (ver docs/plan-crm-clientes.md)
export const HEALTH_META = {
    activo:      { label: 'Activo',       tone: 'success', hint: 'Compra a su ritmo de siempre' },
    nuevo:       { label: 'Nuevo',        tone: 'primary', hint: 'Primera compra en los últimos 30 días' },
    desfasaje:   { label: 'En desfasaje', tone: 'warn',    hint: 'Pasó 1,5 veces su ritmo sin comprar' },
    enfriandose: { label: 'Enfriándose',  tone: 'danger',  hint: 'Pasó 2,5 veces su ritmo sin comprar' },
    perdido:     { label: 'Perdido',      tone: 'muted',   hint: 'Más de 120 días sin comprar' },
    sin_compras: { label: 'Sin compras',  tone: 'muted',   hint: 'Tiene cotizaciones pero nunca compró en el POS' },
};

export const HEALTH_ORDER = ['enfriandose', 'desfasaje', 'activo', 'nuevo', 'perdido', 'sin_compras'];

export const SORT_OPTIONS = [
    { value: 'prioridad',   label: 'Prioridad para llamar' },
    { value: 'facturacion', label: 'Más facturación' },
    { value: 'ultima',      label: 'Compra más reciente' },
    { value: 'nombre',      label: 'Nombre' },
];

export const COMPANY_LABEL = { neggo: 'Neggo', preventas: 'Preventas' };
export const QUOTATION_STATE = { draft: 'Borrador', sent: 'Enviada' };

export function fmtHace(dias) {
    if (dias == null) return 'Nunca';
    if (dias <= 0) return 'Hoy';
    if (dias === 1) return 'Ayer';
    return `Hace ${dias} días`;
}

export function fmtFecha(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fmtMes(yyyymm) {
    const [y, m] = String(yyyymm).split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' }).replace('.', '');
}

export function fmtIntervalo(dias, esDefault) {
    if (dias == null) return '—';
    const n = Math.round(Number(dias));
    return esDefault ? `${n} días (pocas compras)` : `Cada ${n} días`;
}

// Hace cuánto se actualizaron los datos, en palabras
export function fmtActualizado(iso) {
    if (!iso) return 'Todavía sin datos';
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'Actualizado recién';
    if (min < 60) return `Actualizado hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `Actualizado hace ${h} h`;
    return `Actualizado el ${new Date(iso).toLocaleDateString('es-AR')}`;
}

export function iniciales(nombre) {
    const partes = String(nombre || '').replace(/estado:.*$/i, '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    return (partes[0][0] + (partes[1]?.[0] || '')).toUpperCase();
}

// Link de WhatsApp a partir del teléfono de Odoo (asume Argentina si no trae código de país)
export function linkWhatsApp(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!digits.startsWith('54')) digits = `549${digits}`;
    return `https://wa.me/${digits}`;
}
