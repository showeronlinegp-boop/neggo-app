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

/**
 * Chat sin teléfono (…@lid): los dígitos antes de "@lid" son lo que se pone en la lupa de WhatsApp Web
 * para encontrarlo. Con número, o con un chat que no es @lid, devuelve null.
 */
export function codigoChat(chat, numero) {
    if (numero) return null;
    const m = /^(\d+)@lid$/.exec(String(chat || ''));
    return m ? m[1] : null;
}
