// Quién es cada chat del WhatsApp del negocio: lectura de la base y de Odoo, y guardado en
// whatsapp_chat_identidad. Regla dura: no escribe nada en Odoo ni en evolution_negocio; solo lee.
// Las reglas están en whatsappIdentidad.js (lógica pura).

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { callOdoo } = require('../config/odoo');
const { phoneKey, phoneDisplay, cleanContactName } = require('./crmContacts');
const reglas = require('./whatsappIdentidad');
const { textoDe } = require('./agenteConversaciones');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '063_whatsapp_identidad.sql'), 'utf8');
const LOTE_ODOO = 500;
// Lo que se asignó a mano (o el agente) no lo pisa la detección automática
const FUENTES_FIJAS = ['manual', 'agente'];

let schemaReady = null;
function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

async function enLotes(ids, fn) {
    const out = [];
    for (let i = 0; i < ids.length; i += LOTE_ODOO) out.push(...await fn(ids.slice(i, i + LOTE_ODOO)));
    return out;
}

/** Partners que no son clientes: los de los usuarios internos y los de las empresas. */
async function partnersInternos() {
    const [usuarios, empresas] = await Promise.all([
        callOdoo('res.users', 'search_read', [[['share', '=', false]]], { fields: ['partner_id'], context: { active_test: false } }),
        callOdoo('res.company', 'search_read', [[]], { fields: ['partner_id'] }),
    ]);
    return [...usuarios, ...empresas].map((r) => (Array.isArray(r.partner_id) ? r.partner_id[0] : null)).filter(Boolean);
}

async function leerPartners(ids) {
    const unicos = [...new Set(ids)].filter(Boolean);
    const filas = await enLotes(unicos, (lote) => callOdoo('res.partner', 'read', [lote], { fields: ['id', 'name', 'phone'], context: { active_test: false } }));
    return new Map(filas.map((p) => [p.id, { nombre: p.name, numero: phoneDisplay(phoneKey(p.phone)) }]));
}

/**
 * Cotizaciones nombradas en los chats privados desde `desde` (epoch en segundos).
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function referenciasEnBase(desde, db = pool) {
    const { rows } = await db.query(
        `SELECT m."key"->>'remoteJid' AS chat, m."message"
           FROM evolution_negocio."Message" m
          WHERE m."messageTimestamp" >= $1
            AND m."key"->>'remoteJid' NOT LIKE '%@g.us'
            AND m."message"::text ~* 'S[0-9]{5}'`,
        [desde],
    );
    const out = new Map();
    for (const r of rows) agregarReferencias(out, r.chat, textoDe(r.message));
    return out;
}

function agregarReferencias(mapa, chat, texto) {
    const refs = reglas.extraerReferencias(texto);
    if (!chat || !refs.length || chat.endsWith('@g.us')) return;
    if (!mapa.has(chat)) mapa.set(chat, new Set());
    for (const r of refs) mapa.get(chat).add(r);
}

/**
 * Identifica chats por las cotizaciones de Odoo nombradas en la charla y guarda el resultado.
 * Suma las referencias que ya se habían visto (se guardan en evidencia), así lo que se borra con la
 * depuración semanal no se pierde.
 * @param {{ refsPorChat: Map<string, Set<string>> }} input
 */
async function identificarPorCotizaciones({ refsPorChat }, db = pool) {
    await ensureSchema(db);
    const { rows: existentes } = await db.query('SELECT chat_jid, fuente, evidencia FROM whatsapp_chat_identidad');
    const fijos = new Set();
    // Las referencias guardadas suman: se reevalúan todos los chats con cotizaciones, nuevos o viejos
    const todas = new Map();
    for (const e of existentes) {
        if (FUENTES_FIJAS.includes(e.fuente)) fijos.add(e.chat_jid);
        const previas = Object.keys((e.evidencia && e.evidencia.referencias) || {});
        if (previas.length) todas.set(e.chat_jid, new Set(previas));
    }
    for (const [chat, refs] of refsPorChat) {
        if (!todas.has(chat)) todas.set(chat, new Set());
        for (const r of refs) todas.get(chat).add(r);
    }
    for (const chat of fijos) todas.delete(chat);

    const nombres = [...new Set([...todas.values()].flatMap((s) => [...s]))];
    if (!nombres.length) return { chats_con_cotizaciones: 0, identificados: 0, guardados: 0, por_confianza: {} };
    const ordenes = await enLotes(nombres, (lote) => callOdoo('sale.order', 'search_read', [[['name', 'in', lote]]], {
        fields: ['name', 'partner_id'],
        context: { active_test: false },
    }));
    const porNombre = new Map(ordenes
        .filter((o) => Array.isArray(o.partner_id))
        .map((o) => [o.name, { partnerId: o.partner_id[0], partnerNombre: o.partner_id[1] }]));
    const decididos = reglas.decidirPorCotizaciones(todas, porNombre, await partnersInternos());
    const partners = await leerPartners(decididos.map((d) => d.partnerId));

    const porConfianza = {};
    let guardados = 0;
    for (const d of decididos) {
        const p = partners.get(d.partnerId) || {};
        porConfianza[d.confianza] = (porConfianza[d.confianza] || 0) + 1;
        const { rowCount } = await db.query(
            `INSERT INTO whatsapp_chat_identidad (chat_jid, numero, nombre, odoo_partner_id, fuente, confianza, evidencia)
             VALUES ($1, $2, $3, $4, 'cotizacion', $5, $6)
             ON CONFLICT (chat_jid) DO UPDATE
                SET numero = COALESCE(EXCLUDED.numero, whatsapp_chat_identidad.numero),
                    nombre = EXCLUDED.nombre, odoo_partner_id = EXCLUDED.odoo_partner_id,
                    fuente = 'cotizacion', confianza = EXCLUDED.confianza,
                    evidencia = whatsapp_chat_identidad.evidencia || EXCLUDED.evidencia, updated_at = NOW()
              WHERE whatsapp_chat_identidad.fuente <> ALL($7::text[])`,
            [d.chat, p.numero || null, p.nombre || d.partnerNombre, d.partnerId, d.confianza, d.evidencia, FUENTES_FIJAS],
        );
        guardados += rowCount;
    }
    return { chats_con_cotizaciones: todas.size, identificados: decididos.length, guardados, por_confianza: porConfianza };
}

/** Número que WhatsApp sí relacionó con el lid ([{ chat, numero }]). El nombre sale de la agenda. */
async function identificarPorMapeo(mapeos, db = pool) {
    await ensureSchema(db);
    // El número propio del negocio (su chat consigo mismo) no es un cliente
    const { rows: propios } = await db.query('SELECT "ownerJid" FROM evolution_negocio."Instance"');
    const propiosSet = new Set(propios.map((r) => `+${String(r.ownerJid || '').split(/[@:]/)[0]}`));
    let guardados = 0;
    for (const { chat, numero } of mapeos) {
        if (propiosSet.has(numero)) continue;
        const { rows } = await db.query(
            `SELECT "pushName" FROM evolution_negocio."Contact" WHERE "remoteJid" = $1 LIMIT 1`,
            [`${numero.replace(/^\+/, '')}@s.whatsapp.net`],
        );
        const nombre = cleanContactName(rows[0] && rows[0].pushName) || null;
        const { rowCount } = await db.query(
            `INSERT INTO whatsapp_chat_identidad (chat_jid, numero, nombre, fuente, confianza, evidencia)
             VALUES ($1, $2, $3, 'whatsapp', 'alta', $4)
             ON CONFLICT (chat_jid) DO UPDATE
                SET numero = EXCLUDED.numero,
                    nombre = COALESCE(whatsapp_chat_identidad.nombre, EXCLUDED.nombre),
                    evidencia = whatsapp_chat_identidad.evidencia || EXCLUDED.evidencia, updated_at = NOW()`,
            [chat, numero, nombre, { numero_whatsapp: numero }],
        );
        guardados += rowCount;
    }
    return { guardados };
}

/** Recorrida diaria: las cotizaciones nombradas en los últimos `dias` días. */
async function identificarRecientes({ dias = 8 } = {}, db = pool) {
    const desde = Math.floor(Date.now() / 1000) - dias * 86400;
    return identificarPorCotizaciones({ refsPorChat: await referenciasEnBase(desde, db) }, db);
}

/**
 * Asignación a mano (app o agente): con cliente_id trae nombre y teléfono de Odoo. Pisa lo automático.
 * @param {{ chat: string, cliente_id?: number, numero?: string, nombre?: string, fuente: 'manual'|'agente' }} datos
 */
async function asignar({ chat, cliente_id: clienteId, numero, nombre, fuente }, db = pool) {
    await ensureSchema(db);
    let partner = null;
    if (clienteId) {
        partner = (await leerPartners([clienteId])).get(clienteId);
        if (!partner) return null;
    }
    const { rows } = await db.query(
        `INSERT INTO whatsapp_chat_identidad (chat_jid, numero, nombre, odoo_partner_id, fuente, confianza, evidencia)
         VALUES ($1, $2, $3, $4, $5, 'alta', $6)
         ON CONFLICT (chat_jid) DO UPDATE
            SET numero = COALESCE(EXCLUDED.numero, whatsapp_chat_identidad.numero),
                nombre = COALESCE(EXCLUDED.nombre, whatsapp_chat_identidad.nombre),
                odoo_partner_id = COALESCE(EXCLUDED.odoo_partner_id, whatsapp_chat_identidad.odoo_partner_id),
                fuente = EXCLUDED.fuente, confianza = 'alta',
                evidencia = whatsapp_chat_identidad.evidencia || EXCLUDED.evidencia, updated_at = NOW()
         RETURNING *`,
        [chat, numero || (partner && partner.numero) || null, nombre || (partner && partner.nombre) || null,
            clienteId || null, fuente, { asignado_por: fuente, asignado_at: new Date().toISOString() }],
    );
    return formatear(rows[0]);
}

function formatear(r) {
    return {
        chat: r.chat_jid,
        numero: r.numero,
        nombre: r.nombre,
        cliente_id: r.odoo_partner_id,
        fuente: r.fuente,
        confianza: r.confianza,
        actualizado_at: r.updated_at,
    };
}

/** Identidades de una lista de chats → Map chat → identidad. */
async function obtenerIdentidades(chats, db = pool) {
    if (!chats.length) return new Map();
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM whatsapp_chat_identidad WHERE chat_jid = ANY($1::text[])', [chats]);
    return new Map(rows.map((r) => [r.chat_jid, formatear(r)]));
}

/** Nombre de la agenda para chats con número (…@s.whatsapp.net) → Map chat → nombre. */
async function nombresDeAgenda(chats, db = pool) {
    const conNumero = chats.filter((c) => c.endsWith('@s.whatsapp.net'));
    if (!conNumero.length) return new Map();
    const { rows } = await db.query(
        'SELECT "remoteJid", "pushName" FROM evolution_negocio."Contact" WHERE "remoteJid" = ANY($1::text[])',
        [conNumero],
    );
    return new Map(rows.map((r) => [r.remoteJid, cleanContactName(r.pushName) || null]).filter(([, n]) => n));
}

module.exports = {
    ensureSchema,
    agregarReferencias,
    referenciasEnBase,
    identificarPorCotizaciones,
    identificarPorMapeo,
    identificarRecientes,
    asignar,
    obtenerIdentidades,
    nombresDeAgenda,
};
