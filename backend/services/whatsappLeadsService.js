// CRM sobre WhatsApp, parte L1: cruza los chats del WhatsApp del negocio con posibles clientes y
// clientes de Odoo, y da de alta como posible cliente a quien escribe (o le escribimos) y no está en
// ningún lado. Reglas en whatsappLeads.js (lógica pura).
//
// Regla dura: solo LEE evolution_negocio y Odoo; nunca manda nada por el WhatsApp del negocio ni lo
// modifica. Guarda solo quién es cada chat (whatsapp_chat_identidad), no el texto: la depuración
// semanal de 7 días sigue igual.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const contacts = require('./crmContacts');
const identidad = require('./whatsappIdentidadService');
const reglas = require('./whatsappLeads');
const { readOdooPhones } = require('./crmLeadService');
const { linkLead } = require('./crmFollowupService');
const { zonaDe } = require('./agenteLeads');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '065_whatsapp_leads.sql'), 'utf8');
// Los teléfonos de Odoo se releen como mucho una vez por hora
const TTL_TELEFONOS_MS = 60 * 60 * 1000;
// Cuántos días de mensajes se miran en cada vuelta (la depuración deja 7)
const DIAS_RECIENTES = 8;

let schemaReady = null;
function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = identidad.ensureSchema(db)
            .then(() => db.query(SCHEMA))
            .catch((err) => {
                schemaReady = null;
                throw err;
            });
    }
    return schemaReady;
}

let telefonosCache = { at: 0, index: null };
async function indiceTelefonosOdoo() {
    if (!telefonosCache.index || Date.now() - telefonosCache.at > TTL_TELEFONOS_MS) {
        telefonosCache = { at: Date.now(), index: contacts.buildPhoneIndex(await readOdooPhones()) };
    }
    return telefonosCache.index;
}

/** Chats privados con mensajes desde `desde` (epoch en segundos): número alternativo, fechas y nombre. */
async function chatsRecientes(desde, db = pool) {
    const { rows } = await db.query(
        `SELECT m."key"->>'remoteJid' AS chat,
                MAX(m."key"->>'remoteJidAlt') AS alt,
                to_timestamp(MIN(m."messageTimestamp")) AS primero,
                to_timestamp(MAX(m."messageTimestamp")) AS ultimo,
                (ARRAY_AGG(NULLIF(m."pushName", '') ORDER BY m."messageTimestamp" DESC)
                    FILTER (WHERE NOT COALESCE((m."key"->>'fromMe')::boolean, false) AND NULLIF(m."pushName", '') IS NOT NULL))[1] AS push_name
           FROM evolution_negocio."Message" m
          WHERE m."messageTimestamp" >= $1
            AND m."key"->>'remoteJid' NOT LIKE '%@g.us'
            AND m."key"->>'remoteJid' NOT LIKE '%@broadcast'
            AND m."key"->>'remoteJid' NOT LIKE '%@newsletter'
          GROUP BY 1`,
        [desde],
    );
    return rows;
}

async function nombreDeAgenda(numero, db) {
    const { rows } = await db.query(
        'SELECT "pushName" FROM evolution_negocio."Contact" WHERE "remoteJid" = $1 LIMIT 1',
        [`${String(numero).replace(/^\+/, '')}@s.whatsapp.net`],
    );
    return rows[0] ? rows[0].pushName : null;
}

/** Alta del posible cliente nuevo. Si justo existe (otra vuelta en paralelo), devuelve ese. */
async function crearLeadWhatsapp({ key, nombre }, db) {
    const zona = zonaDe(key);
    const { rows: [row] } = await db.query(
        `INSERT INTO crm_leads (name, phone, phone_key, city, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (phone_key) DO UPDATE SET phone_key = EXCLUDED.phone_key
         RETURNING id, (xmax = 0) AS creado`,
        [nombre, contacts.phoneDisplay(key), key, zona ? zona.localidad : null, reglas.SOURCE_WHATSAPP],
    );
    return row;
}

/**
 * Una vuelta completa del cruce. Devuelve los contadores para el log.
 * @param {{ dias?: number }} opciones
 */
async function cruzar({ dias = DIAS_RECIENTES } = {}, db = pool) {
    await ensureSchema(db);
    const desde = Math.floor(Date.now() / 1000) - dias * 86400;
    const chats = await chatsRecientes(desde, db);

    // 1. Número de cada chat (lo que WhatsApp relacionó queda guardado aunque se borren los mensajes)
    const mapeos = reglas.mapeosDeChats(chats);
    await identidad.identificarPorMapeo(mapeos, db);

    // 2. Fechas de primer y último mensaje de los chats que ya tienen identidad
    for (const c of chats) {
        await db.query(
            `UPDATE whatsapp_chat_identidad
                SET primer_mensaje_at = LEAST(COALESCE(primer_mensaje_at, $2), $2),
                    ultimo_mensaje_at = GREATEST(COALESCE(ultimo_mensaje_at, $3), $3)
              WHERE chat_jid = $1`,
            [c.chat, c.primero, c.ultimo],
        );
    }

    // 3. Cruce de los que tienen número y todavía no tienen dueño (o tienen cliente y puede haber un lead)
    const { rows: pendientes } = await db.query(
        `SELECT chat_jid, numero, fuente, confianza, odoo_partner_id, lead_id, nombre,
                (evidencia->>'desvinculado_lead')::int AS desvinculado_lead
           FROM whatsapp_chat_identidad
          WHERE numero IS NOT NULL AND lead_id IS NULL`,
    );
    const out = { chats: chats.length, con_numero: mapeos.length, clientes: 0, leads: 0, leads_nuevos: 0, leads_a_cliente: 0 };
    if (!pendientes.length) return out;

    const odoo = await indiceTelefonosOdoo();
    const { rows: leadRows } = await db.query(
        'SELECT id, phone_key, odoo_partner_id FROM crm_leads WHERE phone_key IS NOT NULL');
    const leadsPorKey = new Map(leadRows.map((l) => [l.phone_key, l]));
    const pushPorChat = new Map(chats.map((c) => [c.chat, c.push_name]));

    for (const p of pendientes) {
        const decision = reglas.decidirVinculo({
            fuente: p.fuente,
            confianza: p.confianza,
            partnerId: p.odoo_partner_id,
            leadId: p.lead_id,
            numero: p.numero,
            desvinculadoLead: p.desvinculado_lead,
        }, {
            partnerPorTelefono: (k) => odoo.find(k),
            leadPorTelefono: (k) => leadsPorKey.get(k) || null,
        });
        if (!decision) continue;

        if (decision.accion === 'cliente') {
            await db.query(
                `UPDATE whatsapp_chat_identidad
                    SET odoo_partner_id = $2, evidencia = evidencia || $3, updated_at = NOW()
                  WHERE chat_jid = $1 AND odoo_partner_id IS NULL`,
                [p.chat_jid, decision.partnerId, { cliente_por: 'telefono' }],
            );
            out.clientes += 1;
        } else if (decision.accion === 'lead') {
            await db.query(
                `UPDATE whatsapp_chat_identidad
                    SET lead_id = $2, evidencia = evidencia || $3, updated_at = NOW()
                  WHERE chat_jid = $1 AND lead_id IS NULL`,
                [p.chat_jid, decision.leadId, { lead_por: 'telefono' }],
            );
            out.leads += 1;
        } else if (decision.accion === 'nuevo_lead') {
            const nombre = reglas.nombreLeadNuevo({
                nombreAgenda: await nombreDeAgenda(p.numero, db),
                pushName: pushPorChat.get(p.chat_jid) || p.nombre,
            });
            const lead = await crearLeadWhatsapp({ key: decision.phoneKey, nombre }, db);
            leadsPorKey.set(decision.phoneKey, { id: lead.id, phone_key: decision.phoneKey, odoo_partner_id: null });
            await db.query(
                `UPDATE whatsapp_chat_identidad
                    SET lead_id = $2, evidencia = evidencia || $3, updated_at = NOW()
                  WHERE chat_jid = $1 AND lead_id IS NULL`,
                [p.chat_jid, lead.id, { lead_por: lead.creado ? 'alta_whatsapp' : 'telefono' }],
            );
            if (lead.creado) out.leads_nuevos += 1;
            else out.leads += 1;
        } else if (decision.accion === 'lead_es_cliente') {
            // Las cotizaciones nombradas en el chat dicen que este posible cliente ya es cliente
            await linkLead(decision.leadId, decision.partnerId, {
                note: `El chat de WhatsApp de este número nombra cotizaciones de este cliente (${p.fuente}): pasa de posible cliente a cliente`,
            });
            leadsPorKey.set(decision.phoneKey, { id: decision.leadId, phone_key: decision.phoneKey, odoo_partner_id: decision.partnerId });
            await db.query(
                `UPDATE whatsapp_chat_identidad SET lead_id = $2, evidencia = evidencia || $3, updated_at = NOW() WHERE chat_jid = $1`,
                [p.chat_jid, decision.leadId, { lead_por: 'cotizacion' }],
            );
            out.leads_a_cliente += 1;
        }
    }
    return out;
}

function formatearChat(r) {
    return {
        chat: r.chat_jid,
        numero: r.numero,
        nombre: r.nombre,
        sin_numero: !r.numero,
        vinculado_por: (r.evidencia && r.evidencia.lead_por) || (r.fuente === 'manual' ? 'manual' : r.fuente),
        primer_mensaje_at: r.primer_mensaje_at,
        ultimo_mensaje_at: r.ultimo_mensaje_at,
    };
}

/** Chats vinculados a un posible cliente. */
async function chatsDeLead(leadId, db = pool) {
    await ensureSchema(db);
    const { rows } = await db.query(
        `SELECT * FROM whatsapp_chat_identidad WHERE lead_id = $1 ORDER BY ultimo_mensaje_at DESC NULLS LAST`,
        [leadId],
    );
    return rows.map(formatearChat);
}

/**
 * Chats sin dueño de los últimos días (sin cliente ni posible cliente), para vincular a mano.
 * Los ordena según el nombre del posible cliente.
 */
async function candidatosParaLead(leadId, db = pool) {
    await ensureSchema(db);
    const { rows: [lead] } = await db.query('SELECT id, name FROM crm_leads WHERE id = $1', [leadId]);
    if (!lead) return null;
    const desde = Math.floor(Date.now() / 1000) - DIAS_RECIENTES * 86400;
    const chats = await chatsRecientes(desde, db);
    const { rows: conDueno } = await db.query(
        `SELECT chat_jid FROM whatsapp_chat_identidad
          WHERE chat_jid = ANY($1::text[]) AND (lead_id IS NOT NULL OR odoo_partner_id IS NOT NULL)`,
        [chats.map((c) => c.chat)],
    );
    const ocupados = new Set(conDueno.map((r) => r.chat_jid));
    const libres = chats
        .filter((c) => !ocupados.has(c.chat))
        .map((c) => ({
            chat: c.chat,
            nombre: contacts.cleanContactName(c.push_name),
            numero: reglas.mapeosDeChats([c])[0]?.numero || null,
            ultimo_mensaje_at: c.ultimo,
        }));
    return reglas.ordenarCandidatos(lead.name, libres);
}

class WhatsappLeadError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** Vínculo a mano: este chat es de este posible cliente. Pisa lo automático. */
async function vincularChat(leadId, chat, userId = null, db = pool) {
    await ensureSchema(db);
    const jid = String(chat || '').trim();
    if (!/^[\d]+@(lid|s\.whatsapp\.net)$/.test(jid)) throw new WhatsappLeadError('Elegí un chat privado de WhatsApp');
    const { rows: [lead] } = await db.query('SELECT id, name, odoo_partner_id FROM crm_leads WHERE id = $1', [leadId]);
    if (!lead) throw new WhatsappLeadError('No encontré ese posible cliente', 404);
    if (lead.odoo_partner_id) throw new WhatsappLeadError('Ya pasó a cliente de Odoo', 409);
    const { rows: [actual] } = await db.query('SELECT lead_id, odoo_partner_id FROM whatsapp_chat_identidad WHERE chat_jid = $1', [jid]);
    if (actual && actual.odoo_partner_id) throw new WhatsappLeadError('Ese chat ya es de un cliente de Odoo', 409);
    if (actual && actual.lead_id && actual.lead_id !== lead.id) throw new WhatsappLeadError('Ese chat ya está vinculado a otro posible cliente', 409);
    const numero = reglas.numeroDeJid(jid.endsWith('@s.whatsapp.net') ? jid : null);
    const { rows: [row] } = await db.query(
        `INSERT INTO whatsapp_chat_identidad (chat_jid, numero, nombre, lead_id, fuente, confianza, evidencia)
         VALUES ($1, $2, $3, $4, 'manual', 'alta', $5)
         ON CONFLICT (chat_jid) DO UPDATE
            SET lead_id = EXCLUDED.lead_id, fuente = 'manual', confianza = 'alta',
                numero = COALESCE(whatsapp_chat_identidad.numero, EXCLUDED.numero),
                evidencia = (whatsapp_chat_identidad.evidencia - 'desvinculado_lead') || EXCLUDED.evidencia, updated_at = NOW()
         RETURNING *`,
        [jid, numero, lead.name, lead.id, { lead_por: 'manual', asignado_por_usuario: userId, asignado_at: new Date().toISOString() }],
    );
    return formatearChat(row);
}

/** Saca el vínculo y recuerda que no hay que volver a ponerlo solo. */
async function desvincularChat(leadId, chat, db = pool) {
    await ensureSchema(db);
    const { rowCount } = await db.query(
        `UPDATE whatsapp_chat_identidad
            SET lead_id = NULL, evidencia = evidencia || jsonb_build_object('desvinculado_lead', $2::int), updated_at = NOW()
          WHERE chat_jid = $1 AND lead_id = $2`,
        [String(chat || ''), parseInt(leadId, 10)],
    );
    if (!rowCount) throw new WhatsappLeadError('Ese chat no está vinculado a este posible cliente', 404);
    return { desvinculado: true };
}

module.exports = {
    ensureSchema,
    cruzar,
    chatsDeLead,
    candidatosParaLead,
    vincularChat,
    desvincularChat,
    WhatsappLeadError,
};
