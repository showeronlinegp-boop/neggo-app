// CRM sobre WhatsApp: ficha comercial del prospecto (067) y pantalla Contactos.
// - Charla de los últimos 7 días (se lee de evolution_negocio; el texto NO se guarda).
// - Resumen para vender y datos del prospecto (Claude cada noche con scripts/resumenProspectos.js,
//   o una persona a mano).
// - Objetivos de nutrición: Presentar (el mensaje de presentación), Conocer (dónde está, rubro e
//   interés) e Informar (preguntas frecuentes "Contárselo a todos"). Reglas en leadObjetivos.js.
// - Lo que pidió (anotado a mano) → cotización en borrador en Odoo (Neggo). Es lo único que escribe
//   en Odoo, y solo cuando una persona toca el botón.

const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const reglas = require('./leadObjetivos');
const etapas = require('./leadEtapas');
const waLeads = require('./whatsappLeadsService');
const { esNombreDeRelleno } = require('./whatsappLeads');
const respuestasService = require('./crmRespuestasService');
const { agruparConversaciones, textoDe } = require('./agenteConversaciones');
const contacts = require('./crmContacts');
const { createCustomer } = require('./odooService');

// La depuración deja 7 días; se lee un día más por las dudas
const DIAS_CHARLA = 8;
const TIPOS_IGNORADOS = ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];

class FichaError extends Error {
    constructor(message, status = 400, errors = null) {
        super(message);
        this.status = status;
        this.errors = errors;
    }
}

function ensureSchema(db = pool) {
    return waLeads.ensureSchema(db).then(() => respuestasService.ensureSchema(db));
}

function idValido(v) {
    const id = Number(v);
    if (!Number.isInteger(id) || id < 1) throw new FichaError('Id inválido', 422);
    return id;
}

async function leerLead(leadId, db) {
    const { rows: [lead] } = await db.query(
        'SELECT id, name, phone, phone_key, city, rubro, source, odoo_partner_id FROM crm_leads WHERE id = $1', [leadId]);
    if (!lead) throw new FichaError('No encontré ese posible cliente', 404);
    return lead;
}

async function chatsDelLead(leadId, db) {
    const { rows } = await db.query(
        `SELECT chat_jid FROM whatsapp_chat_identidad WHERE lead_id = $1 AND tipo IS DISTINCT FROM 'proveedor'`, [leadId]);
    return rows.map((r) => r.chat_jid);
}

/**
 * Mensajes de esos chats desde `desdeSeg` (epoch en segundos), en orden. Sin el esquema del WhatsApp
 * del negocio (contenedor apagado) devuelve [] en lugar de fallar.
 */
async function mensajesDeChats(chats, desdeSeg, db = pool) {
    if (!chats.length) return [];
    let rows;
    try {
        ({ rows } = await db.query(
            `SELECT m."key", m."pushName", m."participant", m."messageType", m."message", m."contextInfo",
                    m."messageTimestamp", c."name" AS chat_nombre
               FROM evolution_negocio."Message" m
               LEFT JOIN evolution_negocio."Chat" c
                 ON c."remoteJid" = m."key"->>'remoteJid' AND c."instanceId" = m."instanceId"
              WHERE m."key"->>'remoteJid' = ANY($1::text[]) AND m."messageTimestamp" >= $2
                AND m."messageType" <> ALL($3::text[])
              ORDER BY m."messageTimestamp", m."id"`,
            [chats, desdeSeg, TIPOS_IGNORADOS],
        ));
    } catch (err) {
        if (err.code === '3F000' || err.code === '42P01') return [];
        throw err;
    }
    const out = [];
    for (const c of agruparConversaciones(rows)) {
        for (const m of c.mensajes) out.push({ ...m, chat: c.chat });
    }
    return out.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}

async function leerPerfil(leadId, db) {
    const { rows: [p] } = await db.query('SELECT * FROM crm_lead_perfil WHERE lead_id = $1', [leadId]);
    return p || null;
}

function formatearPerfil(p) {
    if (!p) return null;
    return {
        ciudad: p.ciudad, tiene_local: p.tiene_local, rubro: p.rubro, intereses: p.intereses,
        proveedor_actual: p.proveedor_actual, trabas: p.trabas, volumen: p.volumen, compromisos: p.compromisos,
        resumen: p.resumen, resumen_at: p.resumen_at, resumen_hasta: p.resumen_hasta, resumen_por: p.resumen_por,
        actualizado_at: p.updated_at,
    };
}

async function respuestasParaInformar(db) {
    return (await respuestasService.listarUsables(db)).filter((r) => r.informar_a_todos);
}

/** Informados guardados de un prospecto → Map respuesta_id → { fuente, fecha }. */
async function leerInformados(leadId, db) {
    const { rows } = await db.query('SELECT respuesta_id, fuente, informado_at FROM crm_lead_informado WHERE lead_id = $1', [leadId]);
    return new Map(rows.map((r) => [r.respuesta_id, { fuente: r.fuente, fecha: r.informado_at }]));
}

/**
 * Busca en lo que le mandamos (chat de la semana y mensajes de Grok) las respuestas que ya se le
 * contaron y las guarda: así quedan aunque la depuración borre el chat.
 */
async function detectarInformados(leadId, respuestas, mensajes, informados, db) {
    const pendientes = respuestas.filter((r) => !informados.has(r.id));
    if (!pendientes.length) return informados;
    const { rows: bot } = await db.query(
        `SELECT mensaje, fecha FROM crm_bot_lead_mensajes
          WHERE lead_id = $1 AND tipo = 'enviado' AND estado = 'enviado' ORDER BY fecha DESC LIMIT 50`, [leadId]);
    const enviados = [
        ...mensajes.filter((m) => m.de === 'neggo' && m.texto).map((m) => ({ texto: m.texto, fuente: 'chat', fecha: m.fecha })),
        ...bot.map((b) => ({ texto: b.mensaje, fuente: 'bot', fecha: b.fecha })),
    ];
    const nuevos = reglas.informadosEnMensajes(pendientes, enviados);
    for (const [respuestaId, inf] of nuevos) {
        await db.query(
            `INSERT INTO crm_lead_informado (lead_id, respuesta_id, fuente, informado_at)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [leadId, respuestaId, inf.fuente, inf.fecha ? new Date(inf.fecha) : new Date()],
        );
        informados.set(respuestaId, inf);
    }
    return informados;
}

/**
 * Fuente de una presentación anotada en crm_events: la mandó Grok, se vio en el chat, se mandó
 * desde la app o una persona tildó que ya la tiene (nota 233).
 */
function fuenteDePresentacion(meta) {
    const origen = meta && meta.origen;
    if (origen === 'agente') return 'bot';
    if (origen === 'chat' || origen === 'manual') return origen;
    return 'app';
}

/** Primera presentación anotada de cada prospecto → Map lead_id → { fecha, fuente }. */
async function leerPresentaciones(ids, db) {
    const { rows } = await db.query(
        `SELECT DISTINCT ON (lead_id) lead_id, created_at, meta FROM crm_events
          WHERE lead_id = ANY($1::int[]) AND kind = 'presentacion'
          ORDER BY lead_id, created_at`, [ids]);
    return new Map(rows.map((r) => [r.lead_id, { fecha: r.created_at, fuente: fuenteDePresentacion(r.meta) }]));
}

/**
 * La presentación del prospecto. Si no está anotada pero aparece en el chat del negocio (se la
 * mandaron por WhatsApp sin la app), se anota: así queda aunque la depuración borre el chat y Grok
 * no se la vuelve a mandar.
 */
async function detectarPresentacion(leadId, mensajes, db) {
    const anotada = (await leerPresentaciones([leadId], db)).get(leadId);
    if (anotada) return anotada;
    const m = reglas.presentacionEnMensajes(mensajes.filter((x) => x.de === 'neggo' && x.texto));
    if (!m) return null;
    const fecha = m.fecha ? new Date(m.fecha) : new Date();
    await db.query(
        `INSERT INTO crm_events (lead_id, kind, meta, created_at) VALUES ($1, 'presentacion', $2, $3)`,
        [leadId, JSON.stringify({ via: 'whatsapp', origen: 'chat' }), fecha]);
    return { fecha, fuente: 'chat' };
}

async function leerItems(leadId, db) {
    const { rows } = await db.query(
        `SELECT i.*, c.odoo_order_name
           FROM crm_lead_pedido_items i LEFT JOIN crm_lead_cotizaciones c ON c.id = i.cotizacion_id
          WHERE i.lead_id = $1 ORDER BY i.cotizacion_id NULLS FIRST, i.id`, [leadId]);
    return rows.map(formatearItem);
}

function formatearItem(r) {
    return {
        id: r.id, texto: r.texto, cantidad: r.cantidad === null ? null : Number(r.cantidad),
        product_id: r.product_id, product_name: r.product_name, chat: r.chat_jid, mensaje_id: r.mensaje_id,
        cotizacion: r.cotizacion_id ? { id: r.cotizacion_id, nombre: r.odoo_order_name || null } : null,
        creado_at: r.created_at,
    };
}

async function leerCotizaciones(leadId, db) {
    const { rows } = await db.query('SELECT * FROM crm_lead_cotizaciones WHERE lead_id = $1 ORDER BY id DESC', [leadId]);
    return rows.map((r) => ({
        id: r.id, odoo_order_id: r.odoo_order_id, nombre: r.odoo_order_name, cliente_id: r.odoo_partner_id,
        contacto_creado: r.partner_creado, lineas: r.lineas, creado_at: r.created_at,
    }));
}

/** Ficha comercial completa de un prospecto. */
async function ficha(leadIdRaw, db = pool) {
    const leadId = idValido(leadIdRaw);
    await ensureSchema(db);
    const lead = await leerLead(leadId, db);
    const chats = await chatsDelLead(leadId, db);
    const desde = Math.floor(Date.now() / 1000) - DIAS_CHARLA * 86400;
    const [mensajes, perfil, respuestas, items, cotizaciones] = await Promise.all([
        mensajesDeChats(chats, desde, db), leerPerfil(leadId, db), respuestasParaInformar(db),
        leerItems(leadId, db), leerCotizaciones(leadId, db),
    ]);
    const informados = await detectarInformados(leadId, respuestas, mensajes, await leerInformados(leadId, db), db);
    const presentacion = await detectarPresentacion(leadId, mensajes, db);
    return {
        lead: {
            id: lead.id, nombre: lead.name, telefono: lead.phone, ciudad: lead.city, rubro: lead.rubro, cliente_id: lead.odoo_partner_id,
            // Para saludar en la presentación: un relleno como "(a completar)" no va
            nombre_saludo: esNombreDeRelleno(lead.name) ? null : lead.name,
        },
        chats,
        perfil: formatearPerfil(perfil),
        objetivos: reglas.objetivos({ perfil, lead, respuestas, informados, presentacion }),
        charla: { dias: reglas.DIAS_ACTIVO, mensajes },
        items,
        cotizaciones,
    };
}

/** Guarda a mano datos del prospecto o el resumen (solo los campos que vienen). */
async function guardarPerfil(leadIdRaw, body, userId, db = pool, { por = 'manual', hasta = null } = {}) {
    const leadId = idValido(leadIdRaw);
    const { value, errors } = reglas.validarPerfil(body);
    if (errors.length) throw new FichaError(errors[0].error, 422, errors);
    await ensureSchema(db);
    await leerLead(leadId, db);
    const campos = Object.keys(value);
    const cols = [...campos];
    const vals = campos.map((c) => value[c]);
    if (value.resumen !== undefined) {
        cols.push('resumen_por', 'resumen_at');
        vals.push(por, new Date());
        if (hasta) { cols.push('resumen_hasta'); vals.push(hasta); }
    }
    cols.push('updated_by');
    vals.push(userId || null);
    const ph = cols.map((_, i) => `$${i + 2}`);
    const set = cols.map((c) => (c === 'resumen_hasta'
        ? 'resumen_hasta = GREATEST(crm_lead_perfil.resumen_hasta, EXCLUDED.resumen_hasta)'
        : `${c} = EXCLUDED.${c}`));
    const { rows: [p] } = await db.query(
        `INSERT INTO crm_lead_perfil (lead_id, ${cols.join(', ')}) VALUES ($1, ${ph.join(', ')})
         ON CONFLICT (lead_id) DO UPDATE SET ${set.join(', ')}, updated_at = NOW()
         RETURNING *`,
        [leadId, ...vals],
    );
    return formatearPerfil(p);
}

const { nombreParaMostrar } = require('./whatsappLeads');

/**
 * Cambia a mano el nombre del prospecto (nota 230). Vacío = sin nombre propio: vuelve a mostrarse
 * el de WhatsApp. Devuelve el nombre guardado, el que se muestra y el de WhatsApp.
 */
async function renombrar(leadIdRaw, nombre, db = pool) {
    const leadId = idValido(leadIdRaw);
    const limpio = String(nombre ?? '').replace(/\s+/g, ' ').trim();
    if (limpio.length > 200) throw new FichaError('El nombre puede tener hasta 200 letras', 422);
    await ensureSchema(db);
    const { rows: [l] } = await db.query(
        'UPDATE crm_leads SET name = $2 WHERE id = $1 RETURNING id, name', [leadId, limpio || null]);
    if (!l) throw new FichaError('No encontré ese posible cliente', 404);
    baseCache = { at: 0, datos: null };
    const { rows: [w] } = await db.query(
        `SELECT MAX(nombre) AS nombre FROM whatsapp_chat_identidad
          WHERE lead_id = $1 AND tipo IS DISTINCT FROM 'proveedor'`, [leadId]);
    const deWhatsapp = nombreParaMostrar(w && w.nombre);
    return { id: l.id, name: l.name, nombre: nombreParaMostrar(l.name, deWhatsapp), nombre_whatsapp: deWhatsapp };
}

/** Tilda (o destilda) a mano un objetivo Informar. */
async function marcarInformado(leadIdRaw, respuestaIdRaw, hecho, userId, db = pool) {
    const leadId = idValido(leadIdRaw);
    const respuestaId = idValido(respuestaIdRaw);
    await ensureSchema(db);
    await leerLead(leadId, db);
    if (hecho === false) {
        await db.query('DELETE FROM crm_lead_informado WHERE lead_id = $1 AND respuesta_id = $2', [leadId, respuestaId]);
        return { respuesta_id: respuestaId, hecho: false };
    }
    const { rowCount } = await db.query('SELECT 1 FROM crm_respuestas WHERE id = $1', [respuestaId]);
    if (!rowCount) throw new FichaError('No existe esa pregunta frecuente', 404);
    await db.query(
        `INSERT INTO crm_lead_informado (lead_id, respuesta_id, fuente, created_by) VALUES ($1, $2, 'manual', $3)
         ON CONFLICT (lead_id, respuesta_id) DO UPDATE SET fuente = 'manual', informado_at = NOW(), created_by = EXCLUDED.created_by`,
        [leadId, respuestaId, userId || null],
    );
    return { respuesta_id: respuestaId, hecho: true };
}

/**
 * Tilde a mano de «Mandarle la presentación» (nota 233): ya la tiene aunque no se la mandamos
 * desde la app. Se anota en crm_events con origen 'manual', así Grok tampoco se la manda.
 * Destildar solo borra las marcas a mano: las que mandó Grok, desde la app o por el chat quedan.
 */
async function marcarPresentacion(leadIdRaw, hecho, userId, db = pool) {
    const leadId = idValido(leadIdRaw);
    await ensureSchema(db);
    await leerLead(leadId, db);
    if (hecho === false) {
        await db.query(
            `DELETE FROM crm_events WHERE lead_id = $1 AND kind = 'presentacion' AND meta->>'origen' = 'manual'`, [leadId]);
    } else if (!(await leerPresentaciones([leadId], db)).has(leadId)) {
        await db.query(
            `INSERT INTO crm_events (lead_id, kind, meta, user_id) VALUES ($1, 'presentacion', $2, $3)`,
            [leadId, JSON.stringify({ via: 'manual', origen: 'manual' }), userId || null]);
    }
    const presentacion = (await leerPresentaciones([leadId], db)).get(leadId) || null;
    return { hecho: Boolean(presentacion), presentacion };
}

// ── Lo que pidió ──────────────────────────────────────────────────────────────────────────

async function productoNeggo(productId, db) {
    const { rows: [p] } = await db.query(
        `SELECT odoo_id, name, internal_ref, list_price FROM odoo_products_cache
          WHERE company = 'neggo' AND odoo_id = $1`, [productId]);
    if (!p) throw new FichaError('No encontré ese producto de Neggo', 404);
    return p;
}

async function crearItem(leadIdRaw, body, userId, db = pool) {
    const leadId = idValido(leadIdRaw);
    const datos = { ...(body || {}) };
    // "12 vasos térmicos" escrito a mano: la cantidad sale del texto
    if (datos.cantidad === undefined && typeof datos.texto === 'string') {
        const s = reglas.separarCantidad(datos.texto);
        datos.texto = s.texto;
        if (s.cantidad !== null) datos.cantidad = s.cantidad;
    }
    const { value, errors } = reglas.validarItem(datos);
    if (errors.length) throw new FichaError(errors[0].error, 422, errors);
    await ensureSchema(db);
    await leerLead(leadId, db);
    const prod = value.product_id ? await productoNeggo(value.product_id, db) : null;
    const { rows: [r] } = await db.query(
        `INSERT INTO crm_lead_pedido_items (lead_id, texto, cantidad, product_id, product_name, chat_jid, mensaje_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [leadId, value.texto, value.cantidad ?? null, prod ? prod.odoo_id : null, prod ? prod.name : null,
            value.chat || null, value.mensaje_id || null, userId || null],
    );
    return formatearItem(r);
}

async function leerItemPendiente(leadId, itemId, db) {
    const { rows: [it] } = await db.query('SELECT * FROM crm_lead_pedido_items WHERE id = $1 AND lead_id = $2', [itemId, leadId]);
    if (!it) throw new FichaError('No encontré ese pedido', 404);
    if (it.cotizacion_id) throw new FichaError('Ya está en una cotización: cambialo en Odoo', 409);
    return it;
}

async function editarItem(leadIdRaw, itemIdRaw, body, db = pool) {
    const leadId = idValido(leadIdRaw);
    const itemId = idValido(itemIdRaw);
    const { value, errors } = reglas.validarItem(body, { parcial: true });
    if (errors.length) throw new FichaError(errors[0].error, 422, errors);
    await ensureSchema(db);
    await leerItemPendiente(leadId, itemId, db);
    let prod;
    if (value.product_id !== undefined) prod = value.product_id ? await productoNeggo(value.product_id, db) : null;
    const { rows: [r] } = await db.query(
        `UPDATE crm_lead_pedido_items
            SET texto = COALESCE($3, texto),
                cantidad = CASE WHEN $4::boolean THEN $5 ELSE cantidad END,
                product_id = CASE WHEN $6::boolean THEN $7 ELSE product_id END,
                product_name = CASE WHEN $6::boolean THEN $8 ELSE product_name END,
                updated_at = NOW()
          WHERE id = $1 AND lead_id = $2 RETURNING *`,
        [itemId, leadId, value.texto ?? null, value.cantidad !== undefined, value.cantidad ?? null,
            prod !== undefined, prod ? prod.odoo_id : null, prod ? prod.name : null],
    );
    return formatearItem(r);
}

async function borrarItem(leadIdRaw, itemIdRaw, db = pool) {
    const leadId = idValido(leadIdRaw);
    const itemId = idValido(itemIdRaw);
    await ensureSchema(db);
    await leerItemPendiente(leadId, itemId, db);
    await db.query('DELETE FROM crm_lead_pedido_items WHERE id = $1', [itemId]);
    return { id: itemId };
}

/** Productos activos de Neggo para elegir el de un pedido: todas las palabras en el nombre, o el código. */
async function buscarProductos(q, db = pool) {
    const texto = String(q || '').trim().slice(0, 100);
    if (texto.length < 2) return [];
    const palabras = texto.split(/\s+/).filter(Boolean).slice(0, 6);
    const params = [];
    const conds = palabras.map((w) => { params.push(`%${w}%`); return `translate(lower(name), 'áéíóúüñ', 'aeiouun') ILIKE translate(lower($${params.length}), 'áéíóúüñ', 'aeiouun')`; });
    params.push(texto);
    const { rows } = await db.query(
        `SELECT odoo_id, name, internal_ref, list_price, image_url
           FROM odoo_products_cache
          WHERE company = 'neggo' AND active AND NOT locally_archived
            AND ((${conds.join(' AND ')}) OR internal_ref ILIKE $${params.length})
          ORDER BY (internal_ref ILIKE $${params.length}) DESC, length(name), name
          LIMIT 12`,
        params,
    );
    return rows.map((r) => ({
        id: r.odoo_id, nombre: r.name, codigo: r.internal_ref, precio_lista: r.list_price === null ? null : Number(r.list_price), imagen: r.image_url,
    }));
}

// ── Cotización en Odoo ─────────────────────────────────────────────────────────────────────

/** Contactos de Odoo que pueden ser esta persona (mismo teléfono o nombre parecido), para no duplicar. */
async function contactosParecidos(leadIdRaw, db = pool) {
    const leadId = idValido(leadIdRaw);
    await ensureSchema(db);
    const lead = await leerLead(leadId, db);
    const dominios = [];
    const ultimos = String(lead.phone_key || lead.phone || '').replace(/\D/g, '').slice(-8);
    if (ultimos.length >= 6) dominios.push([['phone', 'ilike', ultimos.slice(-6)]]);
    const palabras = String(lead.name || '').split(/\s+/).filter((w) => w.length >= 3).slice(0, 2);
    if (palabras.length) dominios.push(palabras.map((w) => ['name', 'ilike', w]));
    const vistos = new Map();
    for (const dom of dominios) {
        const rows = await callOdoo('res.partner', 'search_read', [[...dom, ['active', '=', true]]], {
            fields: ['id', 'name', 'phone', 'city', 'customer_rank'], limit: 8, order: 'customer_rank desc, id desc',
        });
        for (const r of rows) {
            const mismoTel = ultimos.length >= 6 && contacts.phoneKey(r.phone || '') === lead.phone_key && Boolean(lead.phone_key);
            if (!vistos.has(r.id)) vistos.set(r.id, { id: r.id, nombre: r.name, telefono: r.phone || null, ciudad: r.city || null, mismo_telefono: mismoTel });
        }
    }
    return [...vistos.values()].sort((a, b) => Number(b.mismo_telefono) - Number(a.mismo_telefono)).slice(0, 10);
}

/**
 * Crea la cotización en borrador en Odoo (Neggo) con lo que pidió y tiene producto elegido.
 * cliente_id = un contacto de Odoo que ya existe; crear_contacto = true lo da de alta con el nombre
 * y el teléfono del prospecto. El precio lo pone Odoo (lista del contacto), como en una cotización a mano.
 */
async function cotizar(leadIdRaw, body, userId, db = pool) {
    const leadId = idValido(leadIdRaw);
    const { cliente_id: clienteId, crear_contacto: crearContacto } = body || {};
    if (!crearContacto && !(Number.isInteger(clienteId) && clienteId > 0)) {
        throw new FichaError('Elegí el contacto de Odoo o pedí crear uno nuevo', 422);
    }
    await ensureSchema(db);
    const lead = await leerLead(leadId, db);
    const { rows: items } = await db.query(
        `SELECT * FROM crm_lead_pedido_items
          WHERE lead_id = $1 AND cotizacion_id IS NULL AND product_id IS NOT NULL ORDER BY id`, [leadId]);
    if (!items.length) throw new FichaError('No hay pedidos con el producto elegido para cotizar', 409);

    let partnerId = clienteId;
    let creado = false;
    if (crearContacto) {
        if (!lead.name) throw new FichaError('El prospecto no tiene nombre: cargalo antes de crearlo en Odoo', 409);
        const p = await createCustomer({ name: lead.name, phone: lead.phone || null }, 'neggo');
        partnerId = p.id;
        creado = true;
    } else {
        const existe = await callOdoo('res.partner', 'search_count', [[['id', '=', partnerId]]]);
        if (!existe) throw new FichaError('No existe ese contacto en Odoo', 404);
    }

    const { neggo: companyId } = await getCompanyIds();
    if (!companyId) throw new Error('No encuentro la empresa Neggo en Odoo');
    const ctx = { context: { allowed_company_ids: [companyId] } };
    const orderId = await callOdoo('sale.order', 'create', [{
        partner_id: partnerId,
        company_id: companyId,
        origin: 'CRM WhatsApp',
        order_line: items.map((it) => [0, 0, { product_id: it.product_id, product_uom_qty: Number(it.cantidad) || 1 }]),
    }], ctx);
    if (!orderId) throw new Error('Odoo no devolvió la cotización');
    const [orden] = await callOdoo('sale.order', 'read', [[orderId], ['name']], ctx);
    const nombre = orden ? orden.name : null;
    console.log(`✅ CRM WhatsApp: cotización ${nombre} (${orderId}) del prospecto ${leadId} para el contacto ${partnerId}${creado ? ' (nuevo)' : ''}, ${items.length} línea(s)`);

    const { rows: [c] } = await db.query(
        `INSERT INTO crm_lead_cotizaciones (lead_id, odoo_order_id, odoo_order_name, odoo_partner_id, partner_creado, lineas, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [leadId, orderId, nombre, partnerId, creado, items.length, userId || null],
    );
    await db.query('UPDATE crm_lead_pedido_items SET cotizacion_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])', [c.id, items.map((i) => i.id)]);
    return { id: c.id, odoo_order_id: orderId, nombre, cliente_id: partnerId, contacto_creado: creado, lineas: items.length };
}

// ── Pantalla Contactos ─────────────────────────────────────────────────────────────────────

const ETAPA_POR_ID = new Map(etapas.ETAPAS.map((e) => [e.id, e]));

async function clientesConChat(db) {
    const { rows } = await db.query(
        `SELECT w.odoo_partner_id AS id,
                COALESCE(MAX(cm.partner_name), MAX(w.nombre)) AS nombre, MAX(w.numero) AS numero, MAX(w.chat_jid) AS chat,
                MAX(w.ultimo_mensaje_at) AS ultimo, MAX(w.ultimo_de_ellos_at) AS de_ellos, MAX(w.ultimo_nuestro_at) AS nuestro,
                MAX(cm.health) AS health
           FROM whatsapp_chat_identidad w
           LEFT JOIN client_metrics_cache cm ON cm.odoo_partner_id = w.odoo_partner_id AND cm.company = 'neggo'
          WHERE w.odoo_partner_id IS NOT NULL AND w.tipo IS DISTINCT FROM 'proveedor'
          GROUP BY w.odoo_partner_id`,
    );
    return rows.map((r) => ({
        tipo: 'cliente', id: r.id, nombre: r.nombre, numero: r.numero, chat: r.chat,
        ultimo_mensaje_at: r.ultimo, health: r.health || null,
        espera_respuesta: Boolean(r.de_ellos && (!r.nuestro || r.de_ellos > r.nuestro)),
        escribio_ultimo: r.ultimo ? (r.de_ellos && (!r.nuestro || r.de_ellos >= r.nuestro) ? 'contacto' : 'neggo') : null,
    }));
}

/** Qué objetivo le falta a cada prospecto (para la lista): Map lead_id → { hechos, total, siguiente }. */
async function objetivosEnLote(leads, db) {
    const ids = leads.map((l) => l.id);
    if (!ids.length) return new Map();
    const [respuestas, { rows: perfiles }, { rows: infs }, { rows: datos }, presentaciones] = await Promise.all([
        respuestasParaInformar(db),
        db.query('SELECT * FROM crm_lead_perfil WHERE lead_id = ANY($1::int[])', [ids]),
        db.query('SELECT lead_id, respuesta_id, fuente, informado_at FROM crm_lead_informado WHERE lead_id = ANY($1::int[])', [ids]),
        db.query('SELECT id, city, rubro FROM crm_leads WHERE id = ANY($1::int[])', [ids]),
        leerPresentaciones(ids, db),
    ]);
    const perfil = new Map(perfiles.map((p) => [p.lead_id, p]));
    const lead = new Map(datos.map((d) => [d.id, d]));
    const inf = new Map();
    for (const r of infs) {
        if (!inf.has(r.lead_id)) inf.set(r.lead_id, new Map());
        inf.get(r.lead_id).set(r.respuesta_id, { fuente: r.fuente, fecha: r.informado_at });
    }
    const out = new Map();
    for (const id of ids) {
        const o = reglas.objetivos({
            perfil: perfil.get(id), lead: lead.get(id), respuestas, informados: inf.get(id) || new Map(),
            presentacion: presentaciones.get(id) || null,
        });
        out.set(id, { hechos: o.hechos, total: o.total, siguiente: o.siguiente, listo_para_precios: o.listo_para_precios, tiene_resumen: Boolean(perfil.get(id)?.resumen) });
    }
    return out;
}

/** Prospectos con chat (con su etapa) y clientes de Odoo con chat, cada uno con su grupo de charla. */
async function todosLosContactos(db, ahora = new Date()) {
    const { etapas: grupos } = await waLeads.embudo(db);
    const prospectos = grupos.flatMap((g) => g.items.map((it) => ({
        tipo: 'prospecto', id: it.id, nombre: it.name, nombre_whatsapp: it.nombre_whatsapp || null, numero: it.phone, chat: it.chat,
        ultimo_mensaje_at: it.ultimo_mensaje_at, espera_respuesta: it.espera_respuesta,
        etapa: { id: it.etapa, label: g.label, objetivo: g.objetivo },
    })));
    const clientes = await clientesConChat(db);
    return [...prospectos, ...clientes].map((c) => ({ ...c, grupo: reglas.grupoDeCharla(c.ultimo_mensaje_at, ahora) }));
}

/**
 * Contactos en 4 grupos según el último mensaje: activos (≤ 7 días), abiertos (≤ 15), dormidos y
 * sin chat (solo el número: la lista sale de Prospectos sin chat).
 * @param {{ tipo?: 'todos'|'prospecto'|'cliente', grupo?: string, q?: string, solo_esperan?: boolean, limit?: number, offset?: number }} f
 */
async function contactos(f = {}, db = pool) {
    await ensureSchema(db);
    const tipo = ['prospecto', 'cliente'].includes(f.tipo) ? f.tipo : 'todos';
    const grupo = reglas.GRUPOS.includes(f.grupo) ? f.grupo : 'activos';
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
    const ahora = new Date();

    const todos = await todosLosContactos(db, ahora);

    const { rows: [sin] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM crm_leads l
          WHERE l.odoo_partner_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM whatsapp_chat_identidad w WHERE w.lead_id = l.id)`);
    const conteo = {};
    for (const g of reglas.GRUPOS) conteo[g] = { todos: 0, prospecto: 0, cliente: 0, esperan: { todos: 0, prospecto: 0, cliente: 0 } };
    for (const c of todos) {
        const k = conteo[c.grupo];
        k.todos += 1; k[c.tipo] += 1;
        if (c.espera_respuesta) { k.esperan.todos += 1; k.esperan[c.tipo] += 1; }
    }
    conteo.sinchat.prospecto = sin.n;
    conteo.sinchat.todos = sin.n;

    const q = reglas.normalizar(f.q || '');
    let lista = todos.filter((c) => c.grupo === grupo && (tipo === 'todos' || c.tipo === tipo)
        && (!f.solo_esperan || c.espera_respuesta)
        && (!q || reglas.normalizar(`${c.nombre || ''} ${c.numero || ''} ${c.chat || ''}`).includes(q)));
    lista.sort((a, b) => Number(b.espera_respuesta) - Number(a.espera_respuesta)
        || new Date(b.ultimo_mensaje_at || 0) - new Date(a.ultimo_mensaje_at || 0) || a.id - b.id);
    const total = lista.length;
    lista = lista.slice(offset, offset + limit);
    const obj = await objetivosEnLote(lista.filter((c) => c.tipo === 'prospecto'), db);
    return {
        grupo, tipo, conteo, total, limit, offset,
        items: lista.map((c) => ({
            ...c,
            ultimo_mensaje_at: c.ultimo_mensaje_at ? new Date(c.ultimo_mensaje_at).toISOString() : null,
            objetivos: c.tipo === 'prospecto' ? obj.get(c.id) || null : null,
            etapa: c.etapa ? { ...c.etapa, objetivo: c.etapa.objetivo || ETAPA_POR_ID.get(c.etapa.id)?.objetivo || null } : null,
        })),
    };
}

// ── Pantalla Chats (estilo WhatsApp) ───────────────────────────────────────────────────────

const TIPO_PREVIEW = { foto: '📷 Foto', audio: '🎤 Audio', video: '🎥 Video', documento: '📄 Documento', sticker: 'Sticker', ubicacion: '📍 Ubicación', contacto: '👤 Contacto', album: '📷 Fotos', encuesta: 'Encuesta' };
const FILTROS_CHATS = ['todos', 'esperan', 'prospecto', 'cliente', 'dormidos'];
const TIPOS_CONV = {
    imageMessage: 'foto', audioMessage: 'audio', videoMessage: 'video', ptvMessage: 'video', documentMessage: 'documento',
    documentWithCaptionMessage: 'documento', stickerMessage: 'sticker', locationMessage: 'ubicacion', liveLocationMessage: 'ubicacion',
    contactMessage: 'contacto', contactsArrayMessage: 'contacto', albumMessage: 'album', pollCreationMessage: 'encuesta', pollCreationMessageV3: 'encuesta',
};

function claveDe(w) {
    if (w.odoo_partner_id) return `cliente:${w.odoo_partner_id}`;
    if (w.lead_id) return `prospecto:${w.lead_id}`;
    return null;
}

/** Lo que pasó en la semana en cada chat, leído en vivo del WhatsApp del negocio. Map chat → datos. */
async function actividadSemana(jids, db) {
    const out = new Map();
    if (!jids.length) return out;
    const desde = Math.floor(Date.now() / 1000) - DIAS_CHARLA * 86400;
    let filas;
    let ultimos;
    try {
        ({ rows: filas } = await db.query(
            `SELECT m."key"->>'remoteJid' AS jid, m."messageTimestamp" AS ts,
                    COALESCE((m."key"->>'fromMe')::boolean, false) AS yo, ${waLeads.SQL_AUTOMATICO} AS automatico
               FROM evolution_negocio."Message" m
              WHERE m."key"->>'remoteJid' = ANY($1::text[]) AND m."messageTimestamp" >= $2
                AND m."messageType" <> ALL($3::text[])
                AND NOT (m."messageType" = 'conversation' AND COALESCE(m."message"->>'conversation', '') = '')`,
            [jids, desde, TIPOS_IGNORADOS]));
        ({ rows: ultimos } = await db.query(
            `SELECT DISTINCT ON (m."key"->>'remoteJid') m."key"->>'remoteJid' AS jid, m."messageType", m."message",
                    COALESCE((m."key"->>'fromMe')::boolean, false) AS yo
               FROM evolution_negocio."Message" m
              WHERE m."key"->>'remoteJid' = ANY($1::text[]) AND m."messageTimestamp" >= $2
                AND m."messageType" <> ALL($3::text[])
                AND NOT (m."messageType" = 'conversation' AND COALESCE(m."message"->>'conversation', '') = '')
                AND NOT (COALESCE((m."key"->>'fromMe')::boolean, false) AND ${waLeads.SQL_AUTOMATICO})
              ORDER BY m."key"->>'remoteJid', m."messageTimestamp" DESC, m."id" DESC`,
            [jids, desde, TIPOS_IGNORADOS]));
    } catch (err) {
        if (err.code === '3F000' || err.code === '42P01') return out;
        throw err;
    }
    for (const f of filas) {
        const ts = Number(f.ts);
        const a = out.get(f.jid) || { ultimo: 0, nuestro: 0, deEllos: [] };
        // La respuesta automática de fuera de horario cuenta como si no le hubiéramos respondido nada:
        // no es contestarle, no mueve la hora del chat ni sale como último mensaje (nota 231)
        if (f.yo && f.automatico) { out.set(f.jid, a); continue; }
        a.ultimo = Math.max(a.ultimo, ts);
        if (f.yo) a.nuestro = Math.max(a.nuestro, ts); else a.deEllos.push(ts);
        out.set(f.jid, a);
    }
    for (const u of ultimos) {
        const a = out.get(u.jid);
        if (!a) continue;
        const texto = textoDe(u.message);
        const tipo = TIPOS_CONV[u.messageType] || 'otro';
        a.preview = { de: u.yo ? 'neggo' : 'contacto', texto: texto || TIPO_PREVIEW[tipo] || 'Mensaje' };
    }
    return out;
}

// La lista se arma con varias lecturas (embudo, clientes, mensajes de la semana): se guarda 20 s
// para que filtrar y buscar no la recalcule cada vez
const TTL_BASE_MS = 20 * 1000;
let baseCache = { at: 0, datos: null };
async function baseDeChats(db, ahora) {
    if (baseCache.datos && Date.now() - baseCache.at < TTL_BASE_MS) return baseCache.datos;
    const contactosTodos = await todosLosContactos(db, ahora);
    const { rows: ids } = await db.query(
        `SELECT chat_jid, lead_id, odoo_partner_id FROM whatsapp_chat_identidad
          WHERE tipo IS DISTINCT FROM 'proveedor' AND (lead_id IS NOT NULL OR odoo_partner_id IS NOT NULL)`);
    const semana = await actividadSemana(ids.map((w) => w.chat_jid), db);
    baseCache = { at: Date.now(), datos: { contactosTodos, ids, semana } };
    return baseCache.datos;
}

/** Descarta la lista guardada: después de marcar un chat como proveedor o asignarlo a un cliente (nota 232). */
function olvidarChats() {
    baseCache = { at: 0, datos: null };
}

/** Chats cuyo texto de la semana tiene `q` (para el buscador). */
async function chatsConTexto(jids, q, db) {
    if (!jids.length || !q) return new Set();
    const desde = Math.floor(Date.now() / 1000) - DIAS_CHARLA * 86400;
    try {
        const { rows } = await db.query(
            `SELECT DISTINCT m."key"->>'remoteJid' AS jid
               FROM evolution_negocio."Message" m
              WHERE m."key"->>'remoteJid' = ANY($1::text[]) AND m."messageTimestamp" >= $2
                AND (m."message"->>'conversation' ILIKE $3 OR m."message"->'extendedTextMessage'->>'text' ILIKE $3)`,
            [jids, desde, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]);
        return new Set(rows.map((r) => r.jid));
    } catch (err) {
        if (err.code === '3F000' || err.code === '42P01') return new Set();
        throw err;
    }
}

/**
 * Lista de chats como WhatsApp: el más reciente arriba. Por defecto los de los últimos 15 días
 * (activos y conversación abierta); con `q` busca en todos (nombre, teléfono, código del chat y el
 * texto de la semana). filtro: todos | esperan | prospecto | cliente | dormidos.
 */
async function chats(f = {}, db = pool) {
    await ensureSchema(db);
    const filtro = FILTROS_CHATS.includes(f.filtro) ? f.filtro : 'todos';
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 60, 1), 200);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
    const qCruda = String(f.q || '').trim().slice(0, 80);
    const q = reglas.normalizar(qCruda);
    const ahora = new Date();

    const { contactosTodos, ids, semana } = await baseDeChats(db, ahora);
    const chatsPorClave = new Map();
    for (const w of ids) {
        const k = claveDe(w);
        if (!k) continue;
        if (!chatsPorClave.has(k)) chatsPorClave.set(k, []);
        chatsPorClave.get(k).push(w.chat_jid);
    }
    const conTexto = await chatsConTexto(ids.map((w) => w.chat_jid), qCruda, db);

    const lista = [];
    for (const c of contactosTodos) {
        const propios = chatsPorClave.get(`${c.tipo}:${c.id}`) || (c.chat ? [c.chat] : []);
        // El chat más reciente del contacto (si tiene más de uno)
        let mejor = null;
        for (const j of propios) {
            const a = semana.get(j);
            if (a && a.ultimo > 0 && (!mejor || a.ultimo > mejor.a.ultimo)) mejor = { j, a };
        }
        let ultimo = c.ultimo_mensaje_at ? new Date(c.ultimo_mensaje_at) : null;
        let espera = c.espera_respuesta;
        let sinLeer = 0;
        let preview = null;
        if (mejor) {
            const vivo = new Date(mejor.a.ultimo * 1000);
            // Dentro de la semana manda lo leído en vivo: la fecha guardada puede ser la de una respuesta automática
            if (!ultimo || vivo > ultimo || ultimo.getTime() >= ahora.getTime() - DIAS_CHARLA * 86400000) ultimo = vivo;
            sinLeer = mejor.a.deEllos.filter((ts) => ts > mejor.a.nuestro).length;
            espera = sinLeer > 0;
            preview = mejor.a.preview || null;
        }
        const grupo = reglas.grupoDeCharla(ultimo, ahora);
        const coincide = !q || reglas.normalizar(`${c.nombre || ''} ${c.numero || ''} ${propios.join(' ')}`).includes(q)
            || propios.some((j) => conTexto.has(j));
        if (!coincide) continue;
        if (filtro === 'prospecto' || filtro === 'cliente') { if (c.tipo !== filtro) continue; }
        if (filtro === 'esperan' && !espera) continue;
        if (filtro === 'dormidos') { if (grupo !== 'dormidos') continue; } else if (!q && grupo !== 'activos' && grupo !== 'abiertos') continue;
        lista.push({
            clave: `${c.tipo}:${c.id}`, tipo: c.tipo, id: c.id, nombre: c.nombre, nombre_whatsapp: c.nombre_whatsapp || null, numero: c.numero,
            chat: mejor ? mejor.j : c.chat, chats: propios, grupo,
            ultimo_mensaje_at: ultimo ? ultimo.toISOString() : null,
            espera_respuesta: espera, sin_leer: sinLeer, preview,
            etapa: c.etapa || null, health: c.health || null,
        });
    }
    lista.sort((a, b) => new Date(b.ultimo_mensaje_at || 0) - new Date(a.ultimo_mensaje_at || 0) || a.clave.localeCompare(b.clave));
    const esperan = lista.filter((c) => c.espera_respuesta).length;
    return { filtro, q: qCruda, total: lista.length, esperan, limit, offset, items: lista.slice(offset, offset + limit) };
}

/** Conversación de un chat (con los otros chats del mismo contacto), de los últimos 7 días. */
async function mensajesDelChat(chat, db = pool) {
    if (typeof chat !== 'string' || !/^[\d]{6,20}@(lid|s\.whatsapp\.net)$/.test(chat)) throw new FichaError('Chat inválido', 422);
    await ensureSchema(db);
    const { rows: [w] } = await db.query('SELECT chat_jid, lead_id, odoo_partner_id, numero, nombre FROM whatsapp_chat_identidad WHERE chat_jid = $1', [chat]);
    if (!w) throw new FichaError('No conozco ese chat', 404);
    const { rows } = w.odoo_partner_id
        ? await db.query(`SELECT chat_jid FROM whatsapp_chat_identidad WHERE odoo_partner_id = $1 AND tipo IS DISTINCT FROM 'proveedor'`, [w.odoo_partner_id])
        : w.lead_id
            ? await db.query(`SELECT chat_jid FROM whatsapp_chat_identidad WHERE lead_id = $1 AND odoo_partner_id IS NULL AND tipo IS DISTINCT FROM 'proveedor'`, [w.lead_id])
            : { rows: [{ chat_jid: chat }] };
    const propios = rows.map((r) => r.chat_jid);
    const desde = Math.floor(Date.now() / 1000) - DIAS_CHARLA * 86400;
    return {
        chat, chats: propios, numero: w.numero || null,
        contacto: w.odoo_partner_id ? { tipo: 'cliente', id: w.odoo_partner_id } : w.lead_id ? { tipo: 'prospecto', id: w.lead_id } : null,
        mensajes: await mensajesDeChats(propios, desde, db),
    };
}

module.exports = {
    FichaError,
    chats,
    mensajesDelChat,
    ensureSchema,
    mensajesDeChats,
    ficha,
    guardarPerfil,
    renombrar,
    marcarInformado,
    marcarPresentacion,
    crearItem,
    editarItem,
    borrarItem,
    buscarProductos,
    contactosParecidos,
    cotizar,
    contactos,
    olvidarChats,
};
