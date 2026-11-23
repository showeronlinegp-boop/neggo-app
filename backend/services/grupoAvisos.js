// Grupo de avisos de la comunidad (nota 228): lógica pura, sin base ni red.
// La lista de miembros sale de Evolution (findGroupInfos) y se compara con la foto anterior.

const { phoneKey } = require('./crmContacts');

/** Dígitos de un jid o teléfono ("5492477…@s.whatsapp.net" → "5492477…"). */
function digitos(v) {
    return String(v || '').split('@')[0].replace(/\D/g, '');
}

/**
 * Clave para cruzar teléfonos escritos distinto (549 2477 xx, 2477 15 xx, 02477 xx): la misma
 * de crm_leads.phone_key (característica + número). Los del exterior van con todos sus dígitos.
 */
function claveTelefono(v) {
    const d = digitos(v);
    if (d.length < 8) return null;
    return phoneKey(d) || `x${d}`;
}

/** Participantes de Evolution → [{ lid, numero, admin }] (sin repetidos, sin los que no tienen lid). */
function normalizarParticipantes(lista) {
    const out = new Map();
    for (const p of Array.isArray(lista) ? lista : []) {
        const id = String(p?.id || '');
        let lid = null;
        let numero = null;
        if (id.endsWith('@lid')) lid = digitos(id);
        else if (id.endsWith('@s.whatsapp.net')) numero = digitos(id);
        if (p?.phoneNumber) numero = digitos(p.phoneNumber) || numero;
        if (!lid && p?.lid) lid = digitos(p.lid);
        // Sin lid (cuentas viejas): el número hace de clave
        const clave = lid || (numero ? `pn${numero}` : null);
        if (!clave || out.has(clave)) continue;
        out.set(clave, { lid: clave, numero: numero || null, admin: p?.admin || null });
    }
    return [...out.values()];
}

/**
 * Compara la foto nueva con los que estaban activos.
 * @param {Array<{lid:string}>} activos — miembros activos guardados
 * @param {Array<{lid:string}>} actuales — la lista que devolvió WhatsApp ahora
 */
function diferencias(activos, actuales) {
    const antes = new Set(activos.map((m) => m.lid));
    const ahora = new Set(actuales.map((m) => m.lid));
    return {
        entraron: actuales.filter((m) => !antes.has(m.lid)),
        salieron: activos.filter((m) => !ahora.has(m.lid)),
        siguen: actuales.filter((m) => antes.has(m.lid)),
    };
}

/**
 * ¿La lista nueva es creíble? Una respuesta vacía o cortada marcaría a medio grupo como "se fue".
 * Se rechaza si viene vacía o si cayó más de un 30 % de golpe en un grupo de 20 o más.
 */
function fotoConfiable(totalAnterior, totalNuevo) {
    if (!totalNuevo) return { ok: false, motivo: 'WhatsApp devolvió el grupo sin miembros' };
    if (totalAnterior >= 20 && totalNuevo < totalAnterior * 0.7) {
        return { ok: false, motivo: `La lista bajó de ${totalAnterior} a ${totalNuevo} de una: parece incompleta` };
    }
    return { ok: true };
}

/** Índice de miembros guardados para buscar por lid o por teléfono. */
function indiceMiembros(filas) {
    const porLid = new Map();
    const porTel = new Map();
    for (const f of filas) {
        porLid.set(String(f.lid), f);
        const k = claveTelefono(f.numero);
        if (!k) continue;
        // Si el mismo teléfono figura dos veces, gana el que está activo
        const prev = porTel.get(k);
        if (!prev || (f.activo && !prev.activo)) porTel.set(k, f);
    }
    return { porLid, porTel, vacio: filas.length === 0 };
}

/**
 * Estado de un contacto en el grupo según sus chats (jids) y su número.
 * @returns {{estado:'miembro'|'salio'|'no_esta', desde:string|null, desde_foto_inicial:boolean, salio_at:string|null}|null}
 *   null si todavía no hay ninguna foto del grupo.
 */
function estadoDeContacto({ chats = [], numero = null } = {}, indice) {
    if (!indice || indice.vacio) return null;
    const encontrados = [];
    for (const j of chats) {
        const s = String(j || '');
        if (s.endsWith('@lid')) {
            const f = indice.porLid.get(digitos(s));
            if (f) encontrados.push(f);
        } else {
            const f = indice.porTel.get(claveTelefono(s));
            if (f) encontrados.push(f);
        }
    }
    const k = claveTelefono(numero);
    if (k && indice.porTel.has(k)) encontrados.push(indice.porTel.get(k));
    if (!encontrados.length) return { estado: 'no_esta', desde: null, desde_foto_inicial: false, salio_at: null };
    const f = encontrados.find((x) => x.activo) || encontrados.sort((a, b) => new Date(b.salio_at || 0) - new Date(a.salio_at || 0))[0];
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
        estado: f.activo ? 'miembro' : 'salio',
        desde: iso(f.visto_desde),
        desde_foto_inicial: !!f.desde_foto_inicial,
        salio_at: f.activo ? null : iso(f.salio_at),
    };
}

module.exports = {
    digitos,
    claveTelefono,
    normalizarParticipantes,
    diferencias,
    fotoConfiable,
    indiceMiembros,
    estadoDeContacto,
};
