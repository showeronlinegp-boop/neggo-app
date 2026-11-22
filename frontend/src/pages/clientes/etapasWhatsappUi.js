// Helpers de la vista de prospectos con chat de WhatsApp (embudo y ficha)

// Color de cada etapa del embudo de prospectos con chat (ver backend/services/leadEtapas.js)
export const ETAPA_TONO = {
    sin_contactar: 'muted',
    contactado: 'primary',
    conversando: 'primary',
    interesado: 'accent',
    sin_respuesta: 'warn',
    descartado: 'muted',
    no_contactar: 'danger',
};

/** "hace 2 h", "hace 3 d" */
export function haceCuanto(iso) {
    if (!iso) return '';
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} d`;
}
