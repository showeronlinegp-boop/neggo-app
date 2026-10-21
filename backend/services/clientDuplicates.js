// CRM de clientes: unifica fichas duplicadas de Odoo en un solo cliente de la app (nota #72).
// No toca Odoo: solo decide qué partners se muestran juntos. Sin I/O, se testea aparte.
//
// Reglas, de la más segura a la menos:
//   1. Un contacto hijo (dirección, persona de una empresa) suma a su cliente principal.
//   2. Mismo DNI/CUIT (el CUIT trae el DNI en el medio).
//   3. Mismo nombre, de dos palabras o más, sin el "Estado: ..." que arrastran algunas fichas.
//   4. Mismo teléfono o email y el nombre arranca igual ("Nahue Sanz" / "Nahuel Sanz").
// Nunca se unen dos fichas que tienen DNI y es distinto.

function m2oId(value) {
    return Array.isArray(value) ? value[0] : value || null;
}

/** Nombre comparable: sin acentos, sin "Estado: ..." al final, minúsculas y espacios simples. */
function nameKey(name) {
    return String(name || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\s+estado:.*$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9ñ ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** DNI de un documento: el DNI tal cual o el que lleva adentro un CUIT de 11 dígitos. */
function docKey(vat) {
    const digits = String(vat || '').replace(/\D/g, '');
    if (digits.length === 11) return String(Number(digits.slice(2, 10)));
    if (digits.length === 7 || digits.length === 8) return String(Number(digits));
    return null;
}

/** Últimos 10 dígitos del teléfono (ignora +54 y el 9 de celular). */
function phoneKey(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 8 ? digits.slice(-10) : null;
}

function emailKey(email) {
    const value = String(email || '').trim().toLowerCase();
    return value.includes('@') ? value : null;
}

/** El primer nombre de uno empieza con el del otro (3 letras mínimo). */
function sameFirstName(a, b) {
    const x = nameKey(a).split(' ')[0] || '';
    const y = nameKey(b).split(' ')[0] || '';
    if (x.length < 3 || y.length < 3) return false;
    return x.startsWith(y) || y.startsWith(x);
}

/**
 * Agrupa los partners duplicados.
 * @param {Map<number, object>} partners id → { id, name, phone, email, vat, commercial_partner_id, ... }
 * @param {{ skipNames?: string[] }} [options] skipNames: nombres que nunca se unen (cuenta genérica, RMA).
 * @returns {{ repOf: Map<number, number>, groups: Map<number, number[]> }}
 *   repOf: cada partner → id del cliente que lo representa (la ficha más vieja del grupo).
 *   groups: representante → todos sus partners, solo los grupos de más de uno.
 */
function groupDuplicates(partners, { skipNames = [] } = {}) {
    const skip = new Set(skipNames.map(nameKey));
    const parent = new Map();
    const docs = new Map();
    const find = (id) => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root);
        parent.set(id, root);
        return root;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        const da = docs.get(ra);
        const db = docs.get(rb);
        // Dos DNI distintos: son personas distintas aunque compartan nombre o teléfono
        if (da.size && db.size && ![...da].some((d) => db.has(d))) return;
        const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
        parent.set(drop, keep);
        docs.set(keep, new Set([...da, ...db]));
        docs.delete(drop);
    };

    // 1. Contactos hijos → cliente principal
    const top = [];
    for (const p of partners.values()) {
        parent.set(p.id, p.id);
        const doc = docKey(p.vat);
        docs.set(p.id, new Set(doc ? [doc] : []));
    }
    for (const p of partners.values()) {
        const main = m2oId(p.commercial_partner_id);
        if (main && main !== p.id && partners.has(main)) {
            parent.set(p.id, main);
            const d = docs.get(p.id);
            docs.delete(p.id);
            for (const x of d) docs.get(main).add(x);
        } else if (!skip.has(nameKey(p.name))) {
            top.push(p);
        }
    }

    const byKey = (fn) => {
        const out = new Map();
        for (const p of top) {
            const key = fn(p);
            if (!key) continue;
            if (!out.has(key)) out.set(key, []);
            out.get(key).push(p);
        }
        return [...out.values()].filter((list) => list.length > 1);
    };
    const unionAll = (list, accept = () => true) => {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (accept(list[i], list[j])) union(list[i].id, list[j].id);
            }
        }
    };

    // 2. Mismo documento
    for (const list of byKey((p) => docKey(p.vat))) unionAll(list);
    // 3. Mismo nombre completo (un nombre solo, tipo "Yamil", es demasiado común)
    for (const list of byKey((p) => {
        const key = nameKey(p.name);
        return key.split(' ').length >= 2 ? key : null;
    })) unionAll(list);
    // 4. Mismo teléfono o email, con el primer nombre compatible
    for (const fn of [(p) => phoneKey(p.phone), (p) => emailKey(p.email)]) {
        for (const list of byKey(fn)) unionAll(list, (a, b) => sameFirstName(a.name, b.name));
    }

    const repOf = new Map();
    const groups = new Map();
    for (const id of partners.keys()) {
        const rep = find(id);
        repOf.set(id, rep);
        if (!groups.has(rep)) groups.set(rep, []);
        groups.get(rep).push(id);
    }
    for (const [rep, ids] of groups) {
        if (ids.length < 2) groups.delete(rep);
        else ids.sort((a, b) => a - b);
    }
    return { repOf, groups };
}

/**
 * Datos a mostrar de un grupo: nombre, teléfono y ciudad de la ficha con más tickets
 * (si no tiene teléfono o ciudad, de la siguiente que tenga), etiquetas de todas.
 * @param {number} rep id del representante
 * @param {object[]} members partners del grupo
 * @param {Map<number, number>} tickets tickets por partner
 */
function mergedPartner(rep, members, tickets = new Map()) {
    const ranked = [...members].sort((a, b) =>
        (tickets.get(b.id) || 0) - (tickets.get(a.id) || 0) || b.id - a.id);
    // Un contacto hijo no pone el nombre (suele ser "neggo" o una dirección), salvo que el
    // principal nunca haya comprado: ahí el principal suele ser la dirección ("calle 6 311")
    const named = ranked.filter((p) => (tickets.get(p.id) || 0) > 0
        && (!m2oId(p.commercial_partner_id) || m2oId(p.commercial_partner_id) === p.id));
    const pick = (field) => ranked.find((p) => p[field])?.[field] || null;
    return {
        id: rep,
        name: (named[0] || ranked[0]).name,
        phone: pick('phone'),
        city: pick('city'),
        tags: [...new Set(ranked.flatMap((p) => p.tags || []))],
        merged: [...members].sort((a, b) => a.id - b.id).map((p) => ({
            id: p.id,
            name: p.name,
            tickets: tickets.get(p.id) || 0,
        })),
    };
}

module.exports = { groupDuplicates, mergedPartner, nameKey, docKey, phoneKey };
