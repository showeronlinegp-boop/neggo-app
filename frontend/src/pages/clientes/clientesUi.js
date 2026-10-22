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
    { value: 'compras',     label: 'Más compras' },
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

// ── Fase 2: seguimiento ─────────────────────────────────────────

// Etapa del funnel (D9). Ganado lo marca una compra después de Caliente.
export const STAGE_META = {
    frio:       { label: 'Frío',       tone: 'muted',   hint: 'Todavía no hubo un contacto que funcione' },
    templado:   { label: 'Templado',   tone: 'warn',    hint: 'Respondió y hay interés' },
    caliente:   { label: 'Caliente',   tone: 'danger',  hint: 'Está por comprar' },
    ganado:     { label: 'Ganado',     tone: 'success', hint: 'Compró después de pasar a Caliente' },
    descartado: { label: 'Descartado', tone: 'muted',   hint: 'No va a comprar por ahora' },
};
export const STAGE_ORDER = ['frio', 'templado', 'caliente', 'ganado', 'descartado'];
export const MANUAL_STAGES = ['frio', 'templado', 'caliente', 'descartado'];

// Tipos de acción y de contacto registrado
export const ACTION_META = {
    llamar:   { label: 'Llamar',       verbo: 'Llamada' },
    whatsapp: { label: 'WhatsApp',     verbo: 'WhatsApp' },
    visitar:  { label: 'Visitar',      verbo: 'Visita' },
    lista:    { label: 'Mandar lista', verbo: 'Lista enviada' },
    otra:     { label: 'Otra',         verbo: 'Otro contacto' },
};
export const ACTION_ORDER = ['llamar', 'whatsapp', 'visitar', 'lista', 'otra'];

export const EVENT_META = {
    nota:   { label: 'Nota' },
    etapa:  { label: 'Cambio de etapa' },
    compra: { label: 'Compra' },
    ...Object.fromEntries(Object.entries(ACTION_META).map(([k, v]) => [k, { label: v.verbo }])),
};

// Estado que traían los contactos de la agenda ("Estado: NRI NLD-21")
export const SOURCE_STATUS_META = {
    cliente:    { label: 'Cliente',     tone: 'success' },
    recuperar:  { label: 'C. Recuperar', tone: 'warn' },
    churn:      { label: 'Churn',       tone: 'danger' },
    lead:       { label: 'Lead',        tone: 'primary' },
    nri:        { label: 'NRI',         tone: 'muted' },
    sin_estado: { label: 'Sin estado',  tone: 'muted' },
};
export const SOURCE_STATUS_ORDER = ['lead', 'cliente', 'recuperar', 'churn', 'nri', 'sin_estado'];

// Fecha de hoy en Argentina (YYYY-MM-DD) y corrimientos en días
export function hoyAr(dias = 0) {
    const ms = Date.now() - 3 * 3600000 + dias * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
}

// "Hoy", "Mañana", "Vencida hace 3 días", "En 5 días"
export function fmtProxima(iso) {
    if (!iso) return null;
    const dias = Math.round((Date.parse(iso) - Date.parse(hoyAr())) / 86400000);
    if (dias === 0) return 'Hoy';
    if (dias === 1) return 'Mañana';
    if (dias === -1) return 'Vencida ayer';
    if (dias < 0) return `Vencida hace ${-dias} días`;
    return `En ${dias} días`;
}

export function fmtFechaHora(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Importancia que marca el equipo (nota #71): 0 = sin marcar, 5 = la más alta
export const IMPORTANCIA_MAX = 5;
export const IMPORTANCIA_LABEL = ['Sin marcar', 'Muy baja', 'Baja', 'Media', 'Alta', 'Muy alta'];
export const IMPORTANCIA_FILTRO = [
    { value: '', label: 'Cualquier importancia' },
    ...[5, 4, 3, 2, 1].map((n) => ({
        value: String(n),
        label: n === IMPORTANCIA_MAX ? `${IMPORTANCIA_LABEL[n]} (${n})` : `${IMPORTANCIA_LABEL[n]} o más (${n}+)`,
    })),
];

// Nombre para mostrar de un posible cliente sin nombre en la agenda
export function nombreLead(l) {
    return l?.name || l?.phone || l?.email || 'Sin nombre';
}
