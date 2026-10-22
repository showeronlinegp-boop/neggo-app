// Limpieza de contactos para cargar posibles clientes (D11): CSV de Google Contacts,
// teléfonos argentinos normalizados y cruce con los teléfonos de Odoo para no duplicar.
// Lógica pura, sin base ni Odoo. Tests en crmContacts.test.js.

// Estado que traen los nombres de la agenda ("Juan Estado: NRI NLD-21"), del más fuerte al más débil
const SOURCE_STATUS_ORDER = ['cliente', 'recuperar', 'churn', 'lead', 'nri'];

/** CSV con comillas, comas y saltos de línea dentro de los campos. */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quoted) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim()));
}

/**
 * Celular en formato local con el 15 después de la característica ("2477 15-123456"):
 * saca el 15. Prueba característica de 4, 3 y 2 dígitos. Si no hay 15, lo deja como estaba.
 */
function sinQuince(d) {
    for (const len of [4, 3, 2]) {
        if (d.slice(len, len + 2) === '15') return d.slice(0, len) + d.slice(len + 2);
    }
    return d;
}

/**
 * Teléfono argentino como característica + número (10 dígitos), sin 54, sin el 9 de celular
 * y sin el 0 inicial. Devuelve null si no es un número argentino completo.
 */
function phoneKey(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length >= 12 && d.startsWith('54')) {
        d = d.slice(2);
        if (d.length === 11 && d.startsWith('9')) d = d.slice(1);
    } else if (d.length === 11 && d.startsWith('0')) {
        d = d.slice(1);
    } else if (d.length === 13 && d.startsWith('0')) {
        d = sinQuince(d.slice(1));
    } else if (d.length === 12) {
        d = sinQuince(d);
    }
    return d.length === 10 && /^[1-3]/.test(d) ? d : null;
}

/** Formato para guardar y para el link de WhatsApp: +549 + característica + número. */
function phoneDisplay(key) {
    return key ? `+549${key}` : null;
}

/** Nombre sin el "Estado: …" que le agregaron en la agenda. Null si no queda un nombre. */
function cleanContactName(raw) {
    const name = String(raw || '')
        .replace(/\s*estado\s*:.*$/i, '')
        .replace(/#N\/A/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return name.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 ? name : null;
}

/**
 * Estado, lista y ciudad que vienen después de "Estado:" en el nombre.
 * "Estado: NRI NLD-21" → nri / NLD-21; "ESTADO: NRI LD-30 Colon" → nri / LD-30 / Colon.
 */
function parseContactStatus(raw) {
    const m = String(raw || '').match(/estado\s*:\s*(.*)$/i);
    if (!m) return { status: null, list: null, city: null };
    const rest = m[1].trim();
    const lower = rest.toLowerCase();
    let status = null;
    if (/^c\.?\s*recuperar/.test(lower)) status = 'recuperar';
    else if (/^churn/.test(lower)) status = 'churn';
    else if (/^clientes?\b/.test(lower)) status = 'cliente';
    else if (/^lead/.test(lower)) status = 'lead';
    else if (/^nr[io]\b/.test(lower)) status = 'nri';
    const list = (rest.match(/\b(N?LD-\d+|SLD)\b/i) || [])[1];
    const city = (rest.match(/\bLD-\d+\s+(.+)$/i) || [])[1];
    return { status, list: list ? list.toUpperCase() : null, city: city ? city.trim() : null };
}

function strongerStatus(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return SOURCE_STATUS_ORDER.indexOf(a) <= SOURCE_STATUS_ORDER.indexOf(b) ? a : b;
}

/**
 * Filas del CSV de Google Contacts → contactos limpios, uno por teléfono.
 * @returns {{ contacts: object[], discarded: { sinTelefono: number, telefonoInvalido: number, propios: number, repetidos: number } }}
 */
function cleanGoogleContacts(rows) {
    const [header = [], ...data] = rows;
    const col = (name) => header.indexOf(name);
    const get = (r, name) => (col(name) >= 0 ? String(r[col(name)] || '').trim() : '');
    const discarded = { sinTelefono: 0, telefonoInvalido: 0, propios: 0, repetidos: 0 };
    const byKey = new Map();

    for (const r of data) {
        const fullName = [get(r, 'First Name'), get(r, 'Middle Name'), get(r, 'Last Name')].filter(Boolean).join(' ');
        const org = get(r, 'Organization Name');
        if (/^neggo\b/i.test(org) || /^neggo\b/i.test(fullName)) { discarded.propios++; continue; }

        const phones = [get(r, 'Phone 1 - Value'), get(r, 'Phone 2 - Value')]
            .flatMap((p) => p.split(':::'))
            .map((p) => p.trim())
            .filter(Boolean);
        if (!phones.length) { discarded.sinTelefono++; continue; }
        const key = phones.map(phoneKey).find(Boolean);
        if (!key) { discarded.telefonoInvalido++; continue; }

        const { status, list, city: statusCity } = parseContactStatus(fullName);
        const labels = get(r, 'Labels');
        // "Ana Martino (Pergamino)": la ciudad entre paréntesis pasa al campo ciudad
        let name = cleanContactName(fullName) || cleanContactName(org);
        let city = statusCity;
        const paren = name && name.match(/^(.*\S)\s*\(([^()]+)\)$/);
        if (paren && cleanContactName(paren[1])) {
            name = paren[1];
            city = city || paren[2].trim();
        }
        const contact = {
            name,
            phone: phoneDisplay(key),
            phone_key: key,
            email: get(r, 'E-mail 1 - Value') || null,
            city: city || get(r, 'Address 1 - City') || (/\bPergamino\b/.test(labels) ? 'Pergamino' : null),
            source_status: status,
            source_list: list,
        };

        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, contact); continue; }
        discarded.repetidos++;
        // Mismo teléfono dos veces: se queda con el nombre más completo y el estado más fuerte
        if ((contact.name || '').length > (prev.name || '').length) prev.name = contact.name;
        prev.source_status = strongerStatus(prev.source_status, contact.source_status);
        prev.source_list = prev.source_list || contact.source_list;
        prev.city = prev.city || contact.city;
        prev.email = prev.email || contact.email;
    }
    return { contacts: [...byKey.values()], discarded };
}

/**
 * Índice de teléfonos de Odoo para cruzar. Los números completos van por clave de 10 dígitos;
 * los cortos (sin característica, 7 a 9 dígitos) se comparan contra el final del número.
 * @param {Array<{ id: number, name: string, phone: string }>} partners
 */
function buildPhoneIndex(partners) {
    const full = new Map();
    const short = [];
    for (const p of partners) {
        const key = phoneKey(p.phone);
        if (key) { if (!full.has(key)) full.set(key, p); continue; }
        const d = String(p.phone || '').replace(/\D/g, '');
        if (d.length >= 7 && d.length <= 9) short.push({ digits: d, partner: p });
    }
    return {
        find(key) {
            if (!key) return null;
            if (full.has(key)) return full.get(key);
            const hit = short.find((s) => key.endsWith(s.digits));
            return hit ? hit.partner : null;
        },
    };
}

/** Separa los contactos que ya están en Odoo (mismo teléfono) de los que son nuevos. */
function splitAgainstOdoo(contacts, phoneIndex) {
    const nuevos = [];
    const enOdoo = [];
    for (const c of contacts) {
        const partner = phoneIndex.find(c.phone_key);
        if (partner) enOdoo.push({ contact: c, partner });
        else nuevos.push(c);
    }
    return { nuevos, enOdoo };
}

module.exports = {
    SOURCE_STATUS_ORDER,
    parseCsv,
    phoneKey,
    phoneDisplay,
    cleanContactName,
    parseContactStatus,
    cleanGoogleContacts,
    buildPhoneIndex,
    splitAgainstOdoo,
};
