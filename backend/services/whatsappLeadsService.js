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
const etapas = require('./leadEtapas');
const { readOdooPhones } = require('./crmLeadService');
const { linkLead } = require('./crmFollowupService');
const { zonaDe } = require('./agenteLeads');
const { callOdoo } = require('../config/odoo');
const waConv = require('./agenteConversaciones');

// 066 (preguntas frecuentes) y 067 (ficha del prospecto) van juntas: la ficha cuenta como uso del prospecto
const SCHEMA = ['065_whatsapp_leads.sql', '066_crm_respuestas.sql', '067_crm_ficha_prospecto.sql']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', f), 'utf8')).join(';\n');
// Respuestas automáticas del WhatsApp del negocio (fuera de horario, aviso de horario): no cuentan
// como que le contestamos. Condición SQL sobre la fila m de evolution_negocio."Message".
const SQL_AUTOMATICO = `(COALESCE(m."message"->>'conversation', m."message"->'extendedTextMessage'->>'text', '') ~* '(mensaje autom[aá]tico|en este momento est[aá] [*]?(abierto|cerrado))')`;
// Lo que hace que un prospecto creado solo por el cruce ya no se pueda borrar: alguien lo usó
const USO_FICHA = `
                AND NOT EXISTS (SELECT 1 FROM crm_lead_perfil p WHERE p.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_lead_informado i WHERE i.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_lead_pedido_items it WHERE it.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_lead_cotizaciones c WHERE c.lead_id = l.id)`;
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
                to_timestamp(MAX(m."messageTimestamp") FILTER (WHERE NOT COALESCE((m."key"->>'fromMe')::boolean, false))) AS ultimo_de_ellos,
                to_timestamp(MAX(m."messageTimestamp") FILTER (WHERE COALESCE((m."key"->>'fromMe')::boolean, false) AND NOT ${SQL_AUTOMATICO})) AS ultimo_nuestro,
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

/** Número propio del negocio (+549…): su chat consigo mismo no es de nadie. */
async function numerosPropios(db) {
    const { rows } = await db.query('SELECT "ownerJid" FROM evolution_negocio."Instance"');
    return new Set(rows.map((r) => reglas.numeroDeJid(r.ownerJid)).filter(Boolean));
}

/**
 * Registra (o actualiza) cada chat privado: número si hay, nombre que puso en WhatsApp y fechas del
 * primer y último mensaje de cada lado. Nunca el texto. Sirve para la memoria reciente y para el
 * historial de los exports JSONL.
 * @param {Array<{ chat: string, numero?: string|null, nombre?: string|null, primero: Date, ultimo: Date,
 *                 ultimo_de_ellos?: Date|null, ultimo_nuestro?: Date|null }>} filas
 */
async function registrarChats(filas, db = pool) {
    await ensureSchema(db);
    const propios = await numerosPropios(db);
    let nuevos = 0;
    for (const c of filas) {
        if (!c.chat || !/@(lid|s\.whatsapp\.net)$/.test(c.chat)) continue;
        const numero = c.numero || null;
        if (numero && propios.has(numero)) continue;
        const { rows: [r] } = await db.query(
            `INSERT INTO whatsapp_chat_identidad
                (chat_jid, numero, nombre, fuente, confianza, evidencia,
                 primer_mensaje_at, ultimo_mensaje_at, ultimo_de_ellos_at, ultimo_nuestro_at)
             VALUES ($1, $2, $3, 'chat', 'baja', '{}'::jsonb, $4, $5, $6, $7)
             ON CONFLICT (chat_jid) DO UPDATE
                SET numero = COALESCE(whatsapp_chat_identidad.numero, EXCLUDED.numero),
                    nombre = COALESCE(whatsapp_chat_identidad.nombre, EXCLUDED.nombre),
                    primer_mensaje_at = LEAST(whatsapp_chat_identidad.primer_mensaje_at, EXCLUDED.primer_mensaje_at),
                    ultimo_mensaje_at = GREATEST(whatsapp_chat_identidad.ultimo_mensaje_at, EXCLUDED.ultimo_mensaje_at),
                    ultimo_de_ellos_at = GREATEST(whatsapp_chat_identidad.ultimo_de_ellos_at, EXCLUDED.ultimo_de_ellos_at),
                    ultimo_nuestro_at = GREATEST(whatsapp_chat_identidad.ultimo_nuestro_at, EXCLUDED.ultimo_nuestro_at)
             RETURNING (xmax = 0) AS creado`,
            [c.chat, numero, reglas.nombreDeChat(c.nombre), c.primero, c.ultimo,
                c.ultimo_de_ellos || null, c.ultimo_nuestro || null],
        );
        if (r.creado) nuevos += 1;
    }
    return { nuevos };
}

// Proveedores: los de la app y los que tienen órdenes de compra en Odoo (menos los internos)
let proveedoresCache = { at: 0, lista: null };
async function proveedores(db) {
    if (proveedoresCache.lista && Date.now() - proveedoresCache.at < TTL_TELEFONOS_MS) return proveedoresCache.lista;
    const { rows } = await db.query('SELECT name, odoo_vendor_name FROM suppliers');
    const nombres = rows.flatMap((r) => [r.name, r.odoo_vendor_name]).filter(Boolean);
    try {
        const grupos = await callOdoo('purchase.order', 'read_group', [[], ['partner_id'], ['partner_id']], { lazy: false });
        const internos = new Set(await partnersInternosIds());
        for (const g of grupos) {
            if (Array.isArray(g.partner_id) && !internos.has(g.partner_id[0])) nombres.push(g.partner_id[1]);
        }
    } catch (err) {
        console.error('⚠️ CRM WhatsApp: no se pudieron leer los proveedores de Odoo:', err.message);
    }
    proveedoresCache = { at: Date.now(), lista: reglas.prepararProveedores(nombres) };
    return proveedoresCache.lista;
}

async function partnersInternosIds() {
    const [usuarios, empresas] = await Promise.all([
        callOdoo('res.users', 'search_read', [[['share', '=', false]]], { fields: ['partner_id'], context: { active_test: false } }),
        callOdoo('res.company', 'search_read', [[]], { fields: ['partner_id'] }),
    ]);
    return [...usuarios, ...empresas].map((r) => (Array.isArray(r.partner_id) ? r.partner_id[0] : null)).filter(Boolean);
}

/**
 * El prospecto es un cliente de Odoo. Si lo creó el cruce y nadie lo usó, se borra (no hay nada que
 * pasar); si tiene historial, pasa al cliente con todo (linkLead).
 */
async function pasarACliente(leadId, partnerId, note, db) {
    if (await esLeadAutomaticoSinUso(leadId, db)) {
        await db.query('UPDATE whatsapp_chat_identidad SET lead_id = NULL WHERE lead_id = $1', [leadId]);
        await db.query('DELETE FROM crm_leads WHERE id = $1', [leadId]);
        return;
    }
    await linkLead(leadId, partnerId, { note });
}

/** Un prospecto que el cruce creó solo y que nadie tocó (sin historial, acciones ni etapa a mano). */
async function esLeadAutomaticoSinUso(leadId, db) {
    const { rows: [r] } = await db.query(
        `SELECT l.source = $2
                AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_actions a WHERE a.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_followups f WHERE f.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_lead_etapa_manual m WHERE m.lead_id = l.id)
                AND NOT EXISTS (SELECT 1 FROM crm_bot_lead_mensajes b WHERE b.lead_id = l.id)${USO_FICHA} AS libre
           FROM crm_leads l WHERE l.id = $1`,
        [leadId, reglas.SOURCE_WHATSAPP],
    );
    return Boolean(r && r.libre);
}

/**
 * Saca el chat del embudo como proveedor. Si su prospecto lo creó el cruce y nadie lo usó, lo borra;
 * si no, solo lo desvincula (queda en Prospectos sin chat).
 */
async function marcarComoProveedor(chat, { fuente, proveedor = null }, db) {
    const { rows: [w] } = await db.query(
        `UPDATE whatsapp_chat_identidad
            SET tipo = 'proveedor', tipo_fuente = $2, evidencia = evidencia || $3, updated_at = NOW()
          WHERE chat_jid = $1 RETURNING lead_id`,
        [chat, fuente, { proveedor: proveedor || null }],
    );
    if (!w || !w.lead_id) return;
    await db.query('UPDATE whatsapp_chat_identidad SET lead_id = NULL WHERE chat_jid = $1', [chat]);
    const { rows: [otro] } = await db.query('SELECT 1 FROM whatsapp_chat_identidad WHERE lead_id = $1 LIMIT 1', [w.lead_id]);
    if (!otro && await esLeadAutomaticoSinUso(w.lead_id, db)) await db.query('DELETE FROM crm_leads WHERE id = $1', [w.lead_id]);
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
    const numeroPorChat = new Map(mapeos.map((m) => [m.chat, m.numero]));

    // 2. Todos los chats privados recientes, con nombre y fechas de cada lado
    const reg = await registrarChats(chats.map((c) => ({
        chat: c.chat, numero: numeroPorChat.get(c.chat) || null, nombre: c.push_name,
        primero: c.primero, ultimo: c.ultimo, ultimo_de_ellos: c.ultimo_de_ellos, ultimo_nuestro: c.ultimo_nuestro,
    })), db);

    // 3. Clientes por cotizaciones nombradas en la charla, antes de dar de alta prospectos
    await identidad.identificarPorCotizaciones({ refsPorChat: await identidad.referenciasEnBase(desde, db) }, db);

    return { chats: chats.length, chats_nuevos: reg.nuevos, con_numero: mapeos.length, ...(await vincular(db)) };
}

/**
 * Cruce de lo que ya está registrado (sirve para la memoria reciente y para el historial importado):
 * proveedores por nombre, chats con número contra Odoo y prospectos, prospectos sin teléfono que ya
 * tienen número, prospectos que resultaron clientes y alta de prospectos nuevos.
 */
async function vincular(db = pool) {
    await ensureSchema(db);
    const out = { proveedores: 0, clientes: 0, leads: 0, leads_nuevos: 0, leads_sin_telefono: 0, leads_a_cliente: 0, telefonos_completados: 0 };

    // Nombres: el agendado en el teléfono del negocio (el que muestra WhatsApp Web) gana sobre el
    // que se puso cada uno; los prospectos que salieron solo del chat toman ese nombre
    await db.query(
        `UPDATE whatsapp_chat_identidad w SET nombre = c.name, updated_at = NOW()
           FROM evolution_negocio."Chat" c
          WHERE c."remoteJid" = w.chat_jid AND NULLIF(c.name, '') IS NOT NULL AND c.name !~ '^[0-9 +]+$'
            AND w.nombre IS DISTINCT FROM c.name AND w.fuente NOT IN ('manual', 'agente', 'cotizacion')`,
    );
    await db.query(
        `UPDATE crm_leads l SET name = w.nombre
           FROM whatsapp_chat_identidad w
          WHERE w.lead_id = l.id AND l.source = $1 AND l.name IS NULL AND w.nombre IS NOT NULL`,
        [reglas.SOURCE_WHATSAPP],
    );

    // a. Proveedores por el nombre del chat (o del prospecto); lo marcado a mano no se toca
    const lista = await proveedores(db);
    const { rows: sinTipo } = await db.query(
        `SELECT w.chat_jid, COALESCE(w.nombre, l.name) AS nombre, l.name AS nombre_lead
           FROM whatsapp_chat_identidad w LEFT JOIN crm_leads l ON l.id = w.lead_id
          WHERE w.tipo IS NULL AND w.odoo_partner_id IS NULL`,
    );
    for (const r of sinTipo) {
        const prov = reglas.proveedorPorNombre(r.nombre, lista) || reglas.proveedorPorNombre(r.nombre_lead, lista);
        if (!prov) continue;
        await marcarComoProveedor(r.chat_jid, { fuente: 'nombre', proveedor: prov }, db);
        out.proveedores += 1;
    }

    const odoo = await indiceTelefonosOdoo();
    const { rows: leadRows } = await db.query(
        'SELECT id, phone_key, odoo_partner_id FROM crm_leads WHERE phone_key IS NOT NULL');
    const leadsPorKey = new Map(leadRows.map((l) => [l.phone_key, l]));

    // b. Chats con número y sin prospecto
    const { rows: pendientes } = await db.query(
        `SELECT chat_jid, numero, fuente, confianza, odoo_partner_id, lead_id, nombre,
                (evidencia->>'desvinculado_lead')::int AS desvinculado_lead
           FROM whatsapp_chat_identidad
          WHERE numero IS NOT NULL AND lead_id IS NULL AND tipo IS DISTINCT FROM 'proveedor'`,
    );
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
            const nombre = reglas.nombreLeadNuevo({ nombreAgenda: await nombreDeAgenda(p.numero, db), pushName: p.nombre });
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

    // c. Prospectos sin teléfono (salieron de un chat @lid) cuyo chat ya trae el número
    const { rows: sinTel } = await db.query(
        `SELECT w.chat_jid, w.numero, w.lead_id FROM whatsapp_chat_identidad w
           JOIN crm_leads l ON l.id = w.lead_id
          WHERE w.numero IS NOT NULL AND l.phone_key IS NULL AND l.odoo_partner_id IS NULL`,
    );
    for (const r of sinTel) {
        const key = contacts.phoneKey(r.numero);
        const partner = key ? odoo.find(key) : null;
        const otro = key ? leadsPorKey.get(key) : null;
        const que = reglas.resolverLeadSinTelefono({ phoneKey: key, partner, otroLead: otro && otro.id !== r.lead_id ? otro : null });
        if (que === 'es_cliente') {
            await pasarACliente(r.lead_id, partner.id, 'WhatsApp mandó el número de su chat y es de este cliente de Odoo: pasa de posible cliente a cliente', db);
            await db.query('UPDATE whatsapp_chat_identidad SET odoo_partner_id = COALESCE(odoo_partner_id, $2) WHERE chat_jid = $1', [r.chat_jid, partner.id]);
            out.leads_a_cliente += 1;
        } else if (que === 'es_otro_lead') {
            await db.query('UPDATE whatsapp_chat_identidad SET lead_id = $2 WHERE chat_jid = $1', [r.chat_jid, otro.id]);
            if (await esLeadAutomaticoSinUso(r.lead_id, db)) await db.query('DELETE FROM crm_leads WHERE id = $1', [r.lead_id]);
            out.leads += 1;
        } else if (que === 'completar_telefono') {
            const zona = zonaDe(key);
            await db.query(
                `UPDATE crm_leads SET phone = $2, phone_key = $3, city = COALESCE(city, $4) WHERE id = $1 AND phone_key IS NULL`,
                [r.lead_id, contacts.phoneDisplay(key), key, zona ? zona.localidad : null],
            );
            leadsPorKey.set(key, { id: r.lead_id, phone_key: key, odoo_partner_id: null });
            out.telefonos_completados += 1;
        }
    }

    // d. Prospectos cuyo chat resultó ser de un cliente (cotizaciones nombradas, confianza alta o media)
    const { rows: aCliente } = await db.query(
        `SELECT w.lead_id, w.odoo_partner_id, w.fuente FROM whatsapp_chat_identidad w
           JOIN crm_leads l ON l.id = w.lead_id
          WHERE w.odoo_partner_id IS NOT NULL AND l.odoo_partner_id IS NULL
            AND (w.confianza IN ('alta', 'media') OR w.fuente = ANY($1::text[]))`,
        [reglas.FUENTES_FIJAS],
    );
    for (const r of aCliente) {
        await pasarACliente(r.lead_id, r.odoo_partner_id, `Su chat de WhatsApp es de este cliente (${r.fuente}): pasa de posible cliente a cliente`, db);
        out.leads_a_cliente += 1;
    }

    // e. Chats sin número y sin dueño: prospecto nuevo identificado por el chat (sin teléfono)
    const { rows: libres } = await db.query(
        `SELECT chat_jid, nombre FROM whatsapp_chat_identidad
          WHERE numero IS NULL AND lead_id IS NULL AND odoo_partner_id IS NULL
            AND tipo IS DISTINCT FROM 'proveedor' AND evidencia->>'desvinculado_lead' IS NULL`,
    );
    for (const r of libres) {
        const { rows: [lead] } = await db.query(
            `INSERT INTO crm_leads (name, source) VALUES ($1, $2) RETURNING id`,
            [r.nombre, reglas.SOURCE_WHATSAPP],
        );
        await db.query(
            `UPDATE whatsapp_chat_identidad SET lead_id = $2, evidencia = evidencia || $3, updated_at = NOW()
              WHERE chat_jid = $1 AND lead_id IS NULL`,
            [r.chat_jid, lead.id, { lead_por: 'chat_sin_numero' }],
        );
        out.leads_sin_telefono += 1;
    }

    // f. Prospectos sin teléfono que creó el cruce y quedaron sin chat (dos vueltas a la vez): se borran
    const { rowCount: huerfanos } = await db.query(
        `DELETE FROM crm_leads l
          WHERE l.source = $1 AND l.phone_key IS NULL AND l.email IS NULL AND l.odoo_partner_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM whatsapp_chat_identidad w WHERE w.lead_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.lead_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM crm_actions a WHERE a.lead_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM crm_followups f WHERE f.lead_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM crm_lead_etapa_manual m WHERE m.lead_id = l.id)${USO_FICHA}`,
        [reglas.SOURCE_WHATSAPP],
    );
    out.huerfanos_borrados = huerfanos;
    return out;
}

/**
 * Chats privados sin número (@lid), para que alguien los busque en WhatsApp Web y devuelva el número
 * con POST /agente/whatsapp/identidades. Primero los más recientes. solo_prospectos: sin los que ya
 * se sabe que son clientes de Odoo. Nunca los proveedores.
 */
async function chatsSinNumero({ page, limit, offset, solo_prospectos: soloProspectos = true }, db = pool) {
    await ensureSchema(db);
    const where = [`w.numero IS NULL`, `w.chat_jid LIKE '%@lid'`, `w.tipo IS DISTINCT FROM 'proveedor'`];
    if (soloProspectos) where.push('w.odoo_partner_id IS NULL');
    const sql = where.join(' AND ');
    const { rows: [{ total }] } = await db.query(`SELECT COUNT(*)::int AS total FROM whatsapp_chat_identidad w WHERE ${sql}`);
    const { rows } = await db.query(
        `SELECT w.chat_jid, w.nombre, w.lead_id, w.odoo_partner_id, w.primer_mensaje_at, w.ultimo_mensaje_at,
                w.ultimo_de_ellos_at, w.ultimo_nuestro_at
           FROM whatsapp_chat_identidad w WHERE ${sql}
          ORDER BY w.ultimo_mensaje_at DESC NULLS LAST, w.chat_jid
          LIMIT $1 OFFSET $2`,
        [limit, offset],
    );
    const hace7 = Date.now() - 7 * 86400000;
    const data = rows.map((r) => {
        const ellos = r.ultimo_de_ellos_at ? new Date(r.ultimo_de_ellos_at).getTime() : null;
        const nuestro = r.ultimo_nuestro_at ? new Date(r.ultimo_nuestro_at).getTime() : null;
        return {
            chat: r.chat_jid,
            // Esto va en la lupa de WhatsApp Web (el chat sin "@lid")
            buscar_en_whatsapp: waConv.buscarEnWhatsapp(r.chat_jid),
            nombre_whatsapp: r.nombre,
            prospecto_id: r.lead_id,
            cliente_id: r.odoo_partner_id,
            primer_mensaje_at: r.primer_mensaje_at,
            ultimo_mensaje_at: r.ultimo_mensaje_at,
            escribio_ultimo: ellos === null && nuestro === null ? null : ((ellos || 0) >= (nuestro || 0) ? 'contacto' : 'neggo'),
            solo_escribimos_nosotros: ellos === null && nuestro !== null,
            // Si el último mensaje es de los últimos 7 días, la charla está en GET whatsapp/conversaciones
            en_conversaciones: r.ultimo_mensaje_at ? new Date(r.ultimo_mensaje_at).getTime() >= hace7 : false,
        };
    });
    return { data, total, page, limit };
}

/**
 * El nombre que mandó una persona o el agente para un chat pasa al prospecto de ese chat, aunque ya
 * tuviera uno (el de WhatsApp suele ser un apodo). Solo prospectos que salieron del WhatsApp: los de
 * listas o cargados a mano conservan su nombre. Devuelve el id del prospecto renombrado o null.
 */
async function nombrarLeadDelChat(chat, nombre, db = pool) {
    const limpio = reglas.nombreDeChat(nombre);
    if (!limpio) return null;
    const { rows } = await db.query(
        `UPDATE crm_leads l SET name = $2
           FROM whatsapp_chat_identidad w
          WHERE w.chat_jid = $1 AND w.lead_id = l.id AND l.source = $3 AND l.name IS DISTINCT FROM $2
          RETURNING l.id`,
        [chat, limpio, reglas.SOURCE_WHATSAPP],
    );
    return rows[0] ? rows[0].id : null;
}

/** Marca a mano un chat como proveedor (true) o como que no lo es (false). */
async function marcarProveedorManual(chat, esProveedor, db = pool) {
    await ensureSchema(db);
    const jid = String(chat || '').trim();
    const { rows: [w] } = await db.query('SELECT chat_jid FROM whatsapp_chat_identidad WHERE chat_jid = $1', [jid]);
    if (!w) throw new WhatsappLeadError('No encontré ese chat', 404);
    if (esProveedor) {
        await marcarComoProveedor(jid, { fuente: 'manual' }, db);
    } else {
        await db.query(
            `UPDATE whatsapp_chat_identidad SET tipo = 'no_proveedor', tipo_fuente = 'manual', updated_at = NOW() WHERE chat_jid = $1`,
            [jid],
        );
    }
    return { chat: jid, proveedor: Boolean(esProveedor) };
}

/** Chats ocultos como proveedores, para revisarlos. */
async function chatsProveedores(db = pool) {
    await ensureSchema(db);
    const { rows } = await db.query(
        `SELECT chat_jid, numero, nombre, tipo_fuente, evidencia->>'proveedor' AS proveedor, ultimo_mensaje_at
           FROM whatsapp_chat_identidad WHERE tipo = 'proveedor'
          ORDER BY ultimo_mensaje_at DESC NULLS LAST`,
    );
    return rows.map((r) => ({
        chat: r.chat_jid, numero: r.numero, nombre: r.nombre, por: r.tipo_fuente, proveedor: r.proveedor,
        ultimo_mensaje_at: r.ultimo_mensaje_at,
    }));
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
        `SELECT w.chat_jid FROM whatsapp_chat_identidad w LEFT JOIN crm_leads l ON l.id = w.lead_id
          WHERE w.chat_jid = ANY($1::text[])
            AND (w.odoo_partner_id IS NOT NULL OR w.tipo = 'proveedor'
                 OR (w.lead_id IS NOT NULL AND NOT (l.source = 'whatsapp' AND l.phone_key IS NULL)))`,
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
    // Un prospecto que el cruce creó solo desde este chat (sin teléfono ni uso) se reemplaza por este
    const reemplaza = actual && actual.lead_id && actual.lead_id !== lead.id ? actual.lead_id : null;
    if (reemplaza) {
        const { rows: [prev] } = await db.query('SELECT phone_key, source FROM crm_leads WHERE id = $1', [reemplaza]);
        const automatico = prev && prev.source === reglas.SOURCE_WHATSAPP && !prev.phone_key && await esLeadAutomaticoSinUso(reemplaza, db);
        if (!automatico) throw new WhatsappLeadError('Ese chat ya está vinculado a otro posible cliente', 409);
    }
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
    if (reemplaza) await db.query('DELETE FROM crm_leads WHERE id = $1', [reemplaza]);
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

// ── Etapas de los posibles clientes con chat (L3 provisoria) ─────

/** Posibles clientes con chat de WhatsApp, cada uno con su etapa, agrupados como embudo. */
async function embudo(db = pool) {
    await ensureSchema(db);
    const { rows } = await db.query(
        `SELECT l.id, l.name, l.phone, l.city, l.source, l.source_status,
                MAX(w.ultimo_de_ellos_at) AS ultimo_de_ellos, MAX(w.ultimo_nuestro_at) AS ultimo_nuestro,
                MAX(w.ultimo_mensaje_at) AS ultimo_chat, MAX(w.nombre) AS nombre_chat, MAX(w.chat_jid) AS chat,
                f.stage AS crm_stage, s.resultado, COALESCE(s.no_contactar, false) AS no_contactar,
                (SELECT MAX(fecha) FROM crm_bot_lead_mensajes b WHERE b.lead_id = l.id AND b.tipo = 'recibido') AS recibido_grok,
                (SELECT MAX(fecha) FROM crm_bot_lead_mensajes b WHERE b.lead_id = l.id AND b.tipo = 'enviado' AND b.estado = 'enviado') AS enviado_grok,
                (SELECT MAX(e.created_at) FROM crm_events e WHERE e.lead_id = l.id AND e.kind = 'presentacion') AS presentacion,
                m.etapa AS manual, m.motivo AS manual_motivo
           FROM crm_leads l
           JOIN whatsapp_chat_identidad w ON w.lead_id = l.id
                AND w.tipo IS DISTINCT FROM 'proveedor' AND w.odoo_partner_id IS NULL
           LEFT JOIN crm_followups f ON f.lead_id = l.id
           LEFT JOIN crm_bot_lead_seguimiento s ON s.lead_id = l.id
           LEFT JOIN crm_lead_etapa_manual m ON m.lead_id = l.id
          WHERE l.odoo_partner_id IS NULL
          GROUP BY l.id, f.stage, s.resultado, s.no_contactar, m.etapa, m.motivo`,
    );
    const items = rows.map((r) => {
        const e = etapas.calcularEtapa({
            manual: r.manual,
            churn: r.source_status === 'churn',
            noContactar: r.no_contactar,
            descartadoCrm: r.crm_stage === 'descartado',
            resultadoGrok: r.resultado,
            ultimoDeEllos: r.ultimo_de_ellos,
            ultimoNuestro: r.ultimo_nuestro,
            ultimoRecibidoGrok: r.recibido_grok,
            ultimoEnviadoGrok: r.enviado_grok || r.presentacion,
        });
        return {
            id: r.id,
            name: r.name || r.nombre_chat,
            phone: r.phone,
            chat: r.chat,
            city: r.city,
            entro_por_whatsapp: r.source === reglas.SOURCE_WHATSAPP,
            ...e,
            ultimo_mensaje_at: e.ultimo_mensaje_at ? new Date(e.ultimo_mensaje_at).toISOString() : (r.ultimo_chat || null),
            motivo: r.manual ? r.manual_motivo : null,
        };
    });
    const grupos = etapas.agruparPorEtapa(items).map((g) => ({
        id: g.id, label: g.label, objetivo: g.objetivo, total: g.items.length, items: g.items,
    }));
    return { total: items.length, espera_respuesta: items.filter((i) => i.espera_respuesta).length, etapas: grupos };
}

/** Etapa de un posible cliente: la del embudo si tiene chat, o null. */
async function etapaDeLead(leadId, db = pool) {
    const { etapas: grupos } = await embudo(db);
    for (const g of grupos) {
        const it = g.items.find((i) => i.id === leadId);
        if (it) return { ...it, label: g.label, objetivo: g.objetivo };
    }
    return null;
}

/** Marca a mano la etapa (contactado, conversando, interesado o descartado) o la vuelve a automática (null). */
async function marcarEtapa(leadId, etapa, { motivo = null, userId = null } = {}, db = pool) {
    await ensureSchema(db);
    const id = parseInt(leadId, 10);
    const { rows: [lead] } = await db.query('SELECT id FROM crm_leads WHERE id = $1', [id]);
    if (!lead) throw new WhatsappLeadError('No encontré ese posible cliente', 404);
    if (etapa === null || etapa === 'automatica') {
        await db.query('DELETE FROM crm_lead_etapa_manual WHERE lead_id = $1', [id]);
        return etapaDeLead(id, db);
    }
    if (!etapas.MANUALES.includes(etapa)) throw new WhatsappLeadError('Esa etapa no se puede marcar a mano');
    const texto = String(motivo || '').trim().slice(0, 200) || null;
    if (etapa === 'descartado' && !texto) throw new WhatsappLeadError('Poné por qué lo descartás');
    await db.query(
        `INSERT INTO crm_lead_etapa_manual (lead_id, etapa, motivo, changed_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lead_id) DO UPDATE SET etapa = EXCLUDED.etapa, motivo = EXCLUDED.motivo,
                changed_by = EXCLUDED.changed_by, updated_at = NOW()`,
        [id, etapa, texto, userId],
    );
    return etapaDeLead(id, db);
}

module.exports = {
    SQL_AUTOMATICO,
    ensureSchema,
    registrarChats,
    chatsSinNumero,
    vincular,
    marcarProveedorManual,
    nombrarLeadDelChat,
    chatsProveedores,
    embudo,
    etapaDeLead,
    marcarEtapa,
    cruzar,
    chatsDeLead,
    candidatosParaLead,
    vincularChat,
    desvincularChat,
    WhatsappLeadError,
};
