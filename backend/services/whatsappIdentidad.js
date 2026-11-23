// Quién es cada chat del WhatsApp del negocio: lógica pura, sin I/O. Tests en whatsappIdentidad.test.js.
// La lectura de la base y de Odoo está en whatsappIdentidadService.js.
//
// Regla por cotizaciones: en la charla se nombran cotizaciones de Odoo (S04466). Cada cotización
// apunta a un cliente; el chat es del cliente que tiene la mayoría de las cotizaciones distintas.
// - alta: 2 o más cotizaciones y al menos el 75 %
// - media: una sola cotización, o entre el 60 y el 75 %
// - si nadie llega al 60 % (un revendedor que pasa pedidos de varios, un proveedor) no se asigna
// - si el mismo cliente gana en varios chats, solo el más fuerte se queda con su confianza; los demás bajan a baja

const REF_RE = /\bS\d{5}\b/gi;
const NOMBRES_GENERICOS = ['public user', 'usuario publico', 'consumidor final', 'rma'];
const MIN_PROPORCION = 0.6;
const PROPORCION_ALTA = 0.75;
const ORDEN_CONFIANZA = { alta: 3, media: 2, baja: 1 };

function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Referencias de cotización de un texto, en mayúscula y sin repetir. */
function extraerReferencias(texto) {
    const out = new Set();
    for (const m of String(texto || '').match(REF_RE) || []) out.add(m.toUpperCase());
    return [...out];
}

function esGenerico(nombre) {
    return NOMBRES_GENERICOS.includes(norm(nombre));
}

/**
 * Decide el cliente de cada chat a partir de las cotizaciones nombradas.
 * @param {Map<string, Iterable<string>>} refsPorChat chat → referencias (S0xxxx) vistas en la charla
 * @param {Map<string, { partnerId: number, partnerNombre: string }>} ordenes referencia → cliente de Odoo
 * @param {Iterable<number>} excluidos partners que no son clientes (usuarios internos, empresas)
 * @returns {object[]} { chat, partnerId, partnerNombre, confianza, evidencia }
 */
function decidirPorCotizaciones(refsPorChat, ordenes, excluidos = []) {
    const fuera = new Set(excluidos);
    const decididos = [];
    for (const [chat, refs] of refsPorChat) {
        const porPartner = new Map();
        const referencias = {};
        for (const ref of new Set(refs)) {
            const o = ordenes.get(ref);
            if (!o || !o.partnerId || fuera.has(o.partnerId) || esGenerico(o.partnerNombre)) continue;
            referencias[ref] = o.partnerId;
            if (!porPartner.has(o.partnerId)) porPartner.set(o.partnerId, { partnerId: o.partnerId, partnerNombre: o.partnerNombre, refs: 0 });
            porPartner.get(o.partnerId).refs += 1;
        }
        const total = Object.keys(referencias).length;
        if (!total) continue;
        const ranking = [...porPartner.values()].sort((a, b) => b.refs - a.refs || a.partnerId - b.partnerId);
        const top = ranking[0];
        const proporcion = top.refs / total;
        // Empate entre los dos primeros: no se sabe de quién es
        if (proporcion < MIN_PROPORCION || (ranking[1] && ranking[1].refs === top.refs)) continue;
        decididos.push({
            chat,
            partnerId: top.partnerId,
            partnerNombre: top.partnerNombre,
            confianza: top.refs >= 2 && proporcion >= PROPORCION_ALTA ? 'alta' : 'media',
            evidencia: {
                cotizaciones: top.refs,
                cotizaciones_total: total,
                otros_clientes: ranking.slice(1).map((p) => ({ id: p.partnerId, nombre: p.partnerNombre, cotizaciones: p.refs })),
                referencias,
            },
        });
    }

    // Un cliente en varios chats: puede tener dos teléfonos, o alguien reenvió su cotización
    const porCliente = new Map();
    for (const d of decididos) {
        if (!porCliente.has(d.partnerId)) porCliente.set(d.partnerId, []);
        porCliente.get(d.partnerId).push(d);
    }
    for (const lista of porCliente.values()) {
        if (lista.length < 2) continue;
        lista.sort((a, b) => b.evidencia.cotizaciones - a.evidencia.cotizaciones
            || ORDEN_CONFIANZA[b.confianza] - ORDEN_CONFIANZA[a.confianza]
            || (a.chat < b.chat ? -1 : 1));
        for (const d of lista.slice(1)) {
            d.confianza = 'baja';
            d.evidencia.mismo_cliente_en_otro_chat = lista[0].chat;
        }
    }
    return decididos;
}

/** "lid numero" por renglón (el archivo que deja depurar.ps1) → [{ lid, numero }]. */
function parsearMapeoLid(texto) {
    const out = [];
    for (const linea of String(texto || '').split(/\r?\n/)) {
        const m = /^\s*(\d{6,20})\s+(\d{8,15})\s*$/.exec(linea);
        if (m) out.push({ chat: `${m[1]}@lid`, numero: `+${m[2]}` });
    }
    return out;
}

module.exports = {
    NOMBRES_GENERICOS,
    extraerReferencias,
    esGenerico,
    decidirPorCotizaciones,
    parsearMapeoLid,
};
