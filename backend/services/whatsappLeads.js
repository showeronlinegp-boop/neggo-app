// CRM sobre WhatsApp, parte L1: cruce de los chats del WhatsApp del negocio con posibles clientes
// (crm_leads) y clientes de Odoo. Lógica pura, sin base ni Odoo. Tests en whatsappLeads.test.js.
// La lectura y el guardado están en whatsappLeadsService.js.
//
// Orden del cruce de un chat con número:
// 1. Ya tiene cliente de Odoo (por cotizaciones nombradas o asignado a mano): si además hay un posible
//    cliente con ese número, el posible cliente es ese cliente (solo con confianza alta).
// 2. Cliente de Odoo con el mismo teléfono → cliente.
// 3. Posible cliente con el mismo teléfono → posible cliente.
// 4. Ninguno y es un celular argentino → posible cliente nuevo (source = 'whatsapp').
// Los chats sin número (…@lid de antes del 14/11) solo se vinculan a mano.

const { phoneKey, cleanContactName } = require('./crmContacts');

const SOURCE_WHATSAPP = 'whatsapp';
// Lo asignado a mano o por el agente no se toca; cotización solo cuenta con confianza alta
const FUENTES_FIJAS = ['manual', 'agente'];

/** "+5492477…" o "5492477…@s.whatsapp.net" → "+5492477…" (solo dígitos), o null. */
function numeroDeJid(jid) {
    const d = String(jid || '').split(/[@:]/)[0].replace(/\D/g, '');
    return d.length >= 8 ? `+${d}` : null;
}

/**
 * Chats recientes → número de cada uno. Los …@s.whatsapp.net traen el número en el jid; los …@lid,
 * solo si WhatsApp mandó remoteJidAlt (desde el 14/11). Sin grupos ni estados.
 * @param {Array<{ chat: string, alt?: string|null }>} filas
 * @returns {Array<{ chat: string, numero: string }>}
 */
function mapeosDeChats(filas) {
    const out = new Map();
    for (const { chat, alt } of filas || []) {
        if (!chat || out.has(chat)) continue;
        if (chat.endsWith('@s.whatsapp.net')) {
            const numero = numeroDeJid(chat);
            if (numero) out.set(chat, numero);
        } else if (chat.endsWith('@lid') && alt && String(alt).endsWith('@s.whatsapp.net')) {
            const numero = numeroDeJid(alt);
            if (numero) out.set(chat, numero);
        }
    }
    return [...out].map(([chat, numero]) => ({ chat, numero }));
}

/**
 * Qué hacer con un chat que tiene número.
 * @param {{ fuente: string, confianza: string, partnerId: number|null, leadId: number|null, numero: string|null,
 *           desvinculadoLead?: number|null }} identidad
 * @param {{ partnerPorTelefono: (key: string) => ({ id: number }|null), leadPorTelefono: (key: string) => ({ id: number, odoo_partner_id?: number|null }|null) }} indices
 * @returns {{ accion: 'lead_es_cliente'|'cliente'|'lead'|'nuevo_lead', partnerId?: number, leadId?: number, phoneKey: string }|null}
 */
function decidirVinculo(identidad, { partnerPorTelefono, leadPorTelefono }) {
    const key = phoneKey(identidad.numero);
    if (!key) return null;
    const lead = leadPorTelefono(key);
    // Si una persona lo desvinculó de ese lead, no se vuelve a vincular solo
    const leadUsable = lead && lead.id !== identidad.desvinculadoLead ? lead : null;

    if (identidad.partnerId) {
        const confiable = FUENTES_FIJAS.includes(identidad.fuente) || identidad.confianza === 'alta';
        if (leadUsable && !leadUsable.odoo_partner_id && confiable) {
            return { accion: 'lead_es_cliente', leadId: leadUsable.id, partnerId: identidad.partnerId, phoneKey: key };
        }
        return null;
    }
    if (identidad.leadId) return null;
    const partner = partnerPorTelefono(key);
    if (partner) return { accion: 'cliente', partnerId: partner.id, phoneKey: key };
    // El posible cliente ya pasó a Odoo (asignado a mano con otro teléfono): el chat es de ese cliente
    if (leadUsable && leadUsable.odoo_partner_id) return { accion: 'cliente', partnerId: leadUsable.odoo_partner_id, phoneKey: key };
    if (leadUsable) return { accion: 'lead', leadId: leadUsable.id, phoneKey: key };
    if (lead) return null;
    return { accion: 'nuevo_lead', phoneKey: key };
}

/** Nombre de WhatsApp usable: null si viene vacío o es solo un número (el código del chat o un teléfono). */
function nombreDeChat(nombre) {
    const limpio = cleanContactName(nombre);
    return limpio && !/^[0-9 +]+$/.test(limpio) ? limpio : null;
}

// Nombres de relleno que no dicen quién es (el agente cargó prospectos como "(a completar)")
const RELLENOS = ['a completar', 'completar', 'sin nombre', 's n', 'sn', 'nn', 'desconocido', 'sin dato', 'sin datos'];

/** true si el nombre es un relleno como "(a completar)" o "Sin nombre". */
function esNombreDeRelleno(nombre) {
    const n = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();
    return RELLENOS.includes(n);
}

/** Primer nombre que sirva para mostrar (sin rellenos ni vacíos), o null: la pantalla muestra el número. */
function nombreParaMostrar(...candidatos) {
    for (const c of candidatos) {
        const limpio = c == null ? '' : String(c).trim();
        if (limpio && !esNombreDeRelleno(limpio)) return limpio;
    }
    return null;
}

/** Nombre para un posible cliente nuevo: el de la agenda o el que se puso en WhatsApp. */
function nombreLeadNuevo({ nombreAgenda, pushName }) {
    return nombreDeChat(nombreAgenda) || nombreDeChat(pushName) || null;
}

function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((p) => p.length >= 3);
}

/**
 * Chats sin dueño que pueden ser de un posible cliente, para vincular a mano. Primero los que
 * comparten una palabra del nombre (3 letras o más), después los más recientes.
 * @param {string} nombreLead
 * @param {Array<{ chat: string, nombre?: string|null, ultimo_mensaje_at?: string|Date|null }>} chats
 */
function ordenarCandidatos(nombreLead, chats, limite = 20) {
    const palabras = new Set(norm(nombreLead));
    const puntaje = (c) => norm(c.nombre).filter((p) => palabras.has(p)).length;
    const fecha = (c) => (c.ultimo_mensaje_at ? new Date(c.ultimo_mensaje_at).getTime() : 0);
    return [...(chats || [])]
        .map((c) => ({ ...c, coincide: puntaje(c) > 0 }))
        .sort((a, b) => puntaje(b) - puntaje(a) || fecha(b) - fecha(a) || String(a.chat).localeCompare(String(b.chat)))
        .slice(0, limite);
}

// Artículos y conectores que no identifican a un proveedor ("El Rey" → rey)
const PALABRAS_VACIAS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'al', 'y', 'e']);

function palabras(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Proveedores como listas de palabras para comparar con el nombre de un chat. Se descartan los
 * artículos y las palabras de menos de 3 letras; un proveedor que queda sin palabras no se usa.
 * @param {string[]} nombres
 * @returns {Array<{ nombre: string, palabras: string[] }>}
 */
function prepararProveedores(nombres) {
    const vistos = new Set();
    const out = [];
    for (const nombre of nombres || []) {
        const p = palabras(nombre).filter((w) => !PALABRAS_VACIAS.has(w) && w.length >= 3);
        const clave = p.join(' ');
        if (!p.length || vistos.has(clave)) continue;
        vistos.add(clave);
        out.push({ nombre, palabras: p });
    }
    return out;
}

/**
 * El proveedor cuyo nombre está completo dentro del nombre del chat ("ZLE Store" → ZLE), o null.
 * Gana el que tiene más palabras ("El Rey del Sahumerio" antes que "El Rey").
 */
function proveedorPorNombre(nombreChat, proveedores) {
    const delChat = new Set(palabras(nombreChat));
    if (!delChat.size) return null;
    let mejor = null;
    for (const p of proveedores || []) {
        if (p.palabras.every((w) => delChat.has(w)) && (!mejor || p.palabras.length > mejor.palabras.length)) mejor = p;
    }
    return mejor ? mejor.nombre : null;
}

/**
 * Prospecto creado solo a partir de un chat sin teléfono, cuando WhatsApp manda el número.
 * @returns {'es_cliente'|'es_otro_lead'|'completar_telefono'|null}
 */
function resolverLeadSinTelefono({ phoneKey, partner, otroLead }) {
    if (!phoneKey) return null;
    if (partner) return 'es_cliente';
    if (otroLead) return 'es_otro_lead';
    return 'completar_telefono';
}

module.exports = {
    SOURCE_WHATSAPP,
    FUENTES_FIJAS,
    numeroDeJid,
    mapeosDeChats,
    decidirVinculo,
    nombreLeadNuevo,
    nombreDeChat,
    esNombreDeRelleno,
    nombreParaMostrar,
    ordenarCandidatos,
    prepararProveedores,
    proveedorPorNombre,
    resolverLeadSinTelefono,
};
