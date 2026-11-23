// Grupo de avisos de la comunidad de Neggo en WhatsApp (nota 228, migración 068).
// Saca la lista de miembros del WhatsApp del negocio (neggo-evolution-negocio) SOLO LEYENDO
// (GET findGroupInfos: no manda nada ni toca el grupo), la compara con la foto anterior y guarda
// quién entró y quién se fue. Una foto por día (cron del worker) y al tocar Actualizar en Chats.
// Lógica pura en grupoAvisos.js.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const g = require('./grupoAvisos');
const contacts = require('./crmContacts');
const { readOdooPhones } = require('./crmLeadService');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '068_whatsapp_grupo_avisos.sql'), 'utf8');

// Grupo de avisos de la comunidad «Neggo Polirrubros» (el que eligió Mariano)
const GRUPO_JID = process.env.WHATSAPP_GRUPO_AVISOS_JID || '120363218295245705@g.us';
const EVOLUTION_URL = String(process.env.EVOLUTION_NEGOCIO_URL || 'http://neggo-evolution-negocio:8080').replace(/\/+$/, '');
const EVOLUTION_INSTANCE = process.env.EVOLUTION_NEGOCIO_INSTANCE || 'neggo-negocio';
const TIMEOUT_MS = 45 * 1000;
const TTL_INDICE_MS = 60 * 1000;
const TTL_TELEFONOS_MS = 30 * 60 * 1000;
// Lock de Postgres para que el backend (botón) y el worker (cron) no saquen dos fotos a la vez
const LOCK_ID = 228068;

class GrupoAvisosError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

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

/** Lista de miembros del grupo, leída en vivo. Solo GET. */
async function leerGrupo(fetchImpl = fetch) {
    const apiKey = process.env.EVOLUTION_NEGOCIO_API_KEY || process.env.EVOLUTION_API_KEY || '';
    const url = `${EVOLUTION_URL}/group/findGroupInfos/${encodeURIComponent(EVOLUTION_INSTANCE)}?groupJid=${encodeURIComponent(GRUPO_JID)}`;
    let res;
    try {
        res = await fetchImpl(url, { method: 'GET', headers: { apikey: apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new GrupoAvisosError(`No se pudo consultar el WhatsApp del negocio: ${err.message}`, 503);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.participants)) {
        const detalle = body?.response?.message || body?.message || `HTTP ${res.status}`;
        throw new GrupoAvisosError(`El WhatsApp del negocio no devolvió el grupo de avisos (${Array.isArray(detalle) ? detalle.join(' ') : detalle})`, 503);
    }
    return { nombre: body.subject || null, participantes: g.normalizarParticipantes(body.participants) };
}

let tomando = null;
/**
 * Saca una foto de los miembros y registra entradas y salidas desde la anterior.
 * @param {{origen?: 'cron'|'manual', fetchImpl?: Function}} opciones
 */
function tomarFoto(opciones = {}) {
    if (!tomando) tomando = tomarFotoAhora(opciones).finally(() => { tomando = null; });
    return tomando;
}

async function tomarFotoAhora({ origen = 'cron', fetchImpl } = {}, db = pool) {
    await ensureSchema(db);
    const { nombre, participantes } = await leerGrupo(fetchImpl);
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '30s'");
        const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_ID]);
        if (!lock.ok) throw new GrupoAvisosError('Ya se está actualizando el grupo de avisos: probá en un minuto', 409);

        const { rows: [anterior] } = await client.query(
            'SELECT total FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [GRUPO_JID]);
        const confiable = g.fotoConfiable(anterior ? anterior.total : 0, participantes.length);
        if (!confiable.ok) throw new GrupoAvisosError(`No se guardó la foto: ${confiable.motivo}`, 502);

        const inicial = !anterior;
        const { rows: activos } = await client.query(
            'SELECT lid FROM whatsapp_grupo_miembros WHERE grupo_jid = $1 AND activo', [GRUPO_JID]);
        const { entraron, salieron } = inicial ? { entraron: [], salieron: [] } : g.diferencias(activos, participantes);

        const { rows: [foto] } = await client.query(
            `INSERT INTO whatsapp_grupo_fotos (grupo_jid, nombre, total, altas, bajas, inicial, origen)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
            [GRUPO_JID, nombre, participantes.length, entraron.length, salieron.length, inicial, origen === 'manual' ? 'manual' : 'cron']);

        // Los que están ahora: altas nuevas, reingresos (vuelven a activo con fecha nueva) y los que siguen
        const nuevos = new Set(entraron.map((m) => m.lid));
        await client.query(
            `INSERT INTO whatsapp_grupo_miembros (grupo_jid, lid, numero, admin, activo, visto_desde, desde_foto_inicial, visto_ultima_vez, salio_at)
             SELECT $1, p.lid, p.numero, p.admin, true, NOW(), $5, NOW(), NULL
               FROM unnest($2::text[], $3::text[], $4::text[]) AS p(lid, numero, admin)
             ON CONFLICT (grupo_jid, lid) DO UPDATE SET
                numero = COALESCE(EXCLUDED.numero, whatsapp_grupo_miembros.numero),
                admin = EXCLUDED.admin,
                visto_ultima_vez = NOW(),
                visto_desde = CASE WHEN whatsapp_grupo_miembros.activo THEN whatsapp_grupo_miembros.visto_desde ELSE NOW() END,
                desde_foto_inicial = CASE WHEN whatsapp_grupo_miembros.activo THEN whatsapp_grupo_miembros.desde_foto_inicial ELSE false END,
                activo = true,
                salio_at = NULL`,
            [GRUPO_JID, participantes.map((p) => p.lid), participantes.map((p) => p.numero), participantes.map((p) => p.admin), inicial]);

        if (salieron.length) {
            await client.query(
                `UPDATE whatsapp_grupo_miembros SET activo = false, salio_at = NOW()
                  WHERE grupo_jid = $1 AND lid = ANY($2::text[])`,
                [GRUPO_JID, salieron.map((m) => m.lid)]);
        }
        const movimientos = [
            ...participantes.filter((p) => nuevos.has(p.lid)).map((p) => ({ ...p, tipo: 'entro' })),
            ...salieron.map((m) => ({ lid: m.lid, numero: null, tipo: 'salio' })),
        ];
        if (movimientos.length) {
            await client.query(
                `INSERT INTO whatsapp_grupo_movimientos (grupo_jid, foto_id, lid, numero, tipo)
                 SELECT $1, $2, m.lid, COALESCE(m.numero, gm.numero), m.tipo
                   FROM unnest($3::text[], $4::text[], $5::text[]) AS m(lid, numero, tipo)
                   LEFT JOIN whatsapp_grupo_miembros gm ON gm.grupo_jid = $1 AND gm.lid = m.lid`,
                [GRUPO_JID, foto.id, movimientos.map((m) => m.lid), movimientos.map((m) => m.numero), movimientos.map((m) => m.tipo)]);
        }
        await client.query('COMMIT');
        indiceCache = { at: 0, indice: null };
        return { foto_id: foto.id, grupo: nombre, total: participantes.length, entraron: entraron.length, salieron: salieron.length, inicial };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Saca la foto solo si la última tiene más de `horas` (o no hay ninguna). null si no hacía falta. */
async function tomarFotoSiHaceFalta(horas = 20, db = pool) {
    await ensureSchema(db);
    const { rows: [u] } = await db.query(
        `SELECT 1 FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 AND created_at > NOW() - make_interval(hours => $2::int) LIMIT 1`,
        [GRUPO_JID, horas]);
    return u ? null : tomarFoto({ origen: 'cron' });
}

let indiceCache = { at: 0, indice: null };
async function indice(db = pool) {
    if (indiceCache.indice && Date.now() - indiceCache.at < TTL_INDICE_MS) return indiceCache.indice;
    await ensureSchema(db);
    const { rows } = await db.query(
        `SELECT lid, numero, activo, visto_desde, desde_foto_inicial, salio_at
           FROM whatsapp_grupo_miembros WHERE grupo_jid = $1`, [GRUPO_JID]);
    indiceCache = { at: Date.now(), indice: g.indiceMiembros(rows) };
    return indiceCache.indice;
}

/**
 * Agrega `grupo_avisos` a los chats de la lista: { estado: miembro | salio | no_esta, desde,
 * desde_foto_inicial, salio_at }, o null si todavía no hay ninguna foto del grupo.
 */
async function marcarChats(items, db = pool) {
    const idx = await indice(db);
    return items.map((c) => {
        const e = g.estadoDeContacto({ chats: c.chats || (c.chat ? [c.chat] : []), numero: c.numero }, idx);
        return { ...c, grupo_avisos: e };
    });
}

let telefonosCache = { at: 0, index: null };
async function telefonosOdoo() {
    if (!telefonosCache.index || Date.now() - telefonosCache.at > TTL_TELEFONOS_MS) {
        telefonosCache = { at: Date.now(), index: contacts.buildPhoneIndex(await readOdooPhones()) };
    }
    return telefonosCache.index;
}

/**
 * Quién es cada miembro: cliente de Odoo (por teléfono), posible cliente de la app o un chat
 * conocido del WhatsApp del negocio. Devuelve Map lid → { tipo, nombre }.
 */
async function identificar(miembros, db) {
    const out = new Map();
    let odoo = null;
    try { odoo = await telefonosOdoo(); } catch (err) {
        console.warn('⚠️ Grupo de avisos: no se pudieron leer los teléfonos de Odoo:', err.message);
    }
    const claves = [...new Set(miembros.map((m) => contacts.phoneKey(m.numero)).filter(Boolean))];
    const { rows: leads } = claves.length
        ? await db.query('SELECT id, name, phone_key, odoo_partner_id FROM crm_leads WHERE phone_key = ANY($1::text[])', [claves])
        : { rows: [] };
    const leadPorClave = new Map(leads.map((l) => [l.phone_key, l]));
    const jids = miembros.flatMap((m) => [`${m.lid}@lid`, m.numero ? `${m.numero}@s.whatsapp.net` : null]).filter(Boolean);
    const { rows: ids } = await db.query(
        `SELECT w.chat_jid, w.tipo, w.odoo_partner_id, w.lead_id, COALESCE(l.name, w.nombre) AS nombre
           FROM whatsapp_chat_identidad w LEFT JOIN crm_leads l ON l.id = w.lead_id
          WHERE w.chat_jid = ANY($1::text[])`, [jids]);
    const idPorJid = new Map(ids.map((r) => [r.chat_jid, r]));
    for (const m of miembros) {
        const k = contacts.phoneKey(m.numero);
        const partner = odoo && k ? odoo.find(k) : null;
        const lead = k ? leadPorClave.get(k) : null;
        const w = idPorJid.get(`${m.lid}@lid`) || (m.numero ? idPorJid.get(`${m.numero}@s.whatsapp.net`) : null);
        let r = { tipo: 'sin_identificar', nombre: null };
        if (partner) r = { tipo: 'cliente', nombre: partner.name };
        else if (w?.tipo === 'proveedor') r = { tipo: 'proveedor', nombre: w.nombre };
        else if (w?.odoo_partner_id || lead?.odoo_partner_id) r = { tipo: 'cliente', nombre: w?.nombre || lead?.name || null };
        else if (lead) r = { tipo: 'prospecto', nombre: lead.name };
        else if (w?.lead_id) r = { tipo: 'prospecto', nombre: w.nombre };
        out.set(m.lid, r);
    }
    return { quien: out, odoo_ok: !!odoo };
}

/** Números del grupo, para la pantalla de estadísticas. */
async function estadisticas(db = pool) {
    await ensureSchema(db);
    const { rows: fotos } = await db.query(
        `SELECT DISTINCT ON (dia) dia, total, created_at,
                SUM(altas) OVER (PARTITION BY dia) AS altas, SUM(bajas) OVER (PARTITION BY dia) AS bajas
           FROM (SELECT *, (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia
                   FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 AND created_at > NOW() - INTERVAL '90 days') f
          ORDER BY dia DESC, created_at DESC`, [GRUPO_JID]);
    const { rows: [resumen] } = await db.query(
        `SELECT (SELECT MIN(created_at) FROM whatsapp_grupo_fotos WHERE grupo_jid = $1) AS desde,
                (SELECT created_at FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 ORDER BY created_at DESC, id DESC LIMIT 1) AS ultima,
                (SELECT nombre FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 ORDER BY created_at DESC, id DESC LIMIT 1) AS nombre,
                (SELECT total FROM whatsapp_grupo_fotos WHERE grupo_jid = $1 ORDER BY created_at DESC, id DESC LIMIT 1) AS total,
                COUNT(*) FILTER (WHERE tipo = 'entro' AND created_at > NOW() - INTERVAL '7 days') AS entraron_7,
                COUNT(*) FILTER (WHERE tipo = 'salio' AND created_at > NOW() - INTERVAL '7 days') AS salieron_7,
                COUNT(*) FILTER (WHERE tipo = 'entro' AND created_at > NOW() - INTERVAL '30 days') AS entraron_30,
                COUNT(*) FILTER (WHERE tipo = 'salio' AND created_at > NOW() - INTERVAL '30 days') AS salieron_30
           FROM whatsapp_grupo_movimientos WHERE grupo_jid = $1`, [GRUPO_JID]);
    if (!resumen.ultima) {
        return { grupo_jid: GRUPO_JID, nombre: null, total: 0, desde: null, ultima: null, sin_fotos: true, composicion: null, por_dia: [], movimientos: [] };
    }
    const { rows: activos } = await db.query(
        'SELECT lid, numero, visto_desde, desde_foto_inicial FROM whatsapp_grupo_miembros WHERE grupo_jid = $1 AND activo', [GRUPO_JID]);
    const { rows: movs } = await db.query(
        `SELECT m.tipo, m.lid, COALESCE(m.numero, gm.numero) AS numero, m.created_at
           FROM whatsapp_grupo_movimientos m
           LEFT JOIN whatsapp_grupo_miembros gm ON gm.grupo_jid = m.grupo_jid AND gm.lid = m.lid
          WHERE m.grupo_jid = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [GRUPO_JID]);
    const { quien, odoo_ok: odooOk } = await identificar([...activos, ...movs], db);
    const composicion = { cliente: 0, prospecto: 0, proveedor: 0, sin_identificar: 0 };
    for (const m of activos) composicion[quien.get(m.lid)?.tipo || 'sin_identificar'] += 1;
    const n = (v) => parseInt(v, 10) || 0;
    return {
        grupo_jid: GRUPO_JID,
        nombre: resumen.nombre,
        total: n(resumen.total),
        desde: resumen.desde,
        ultima: resumen.ultima,
        sin_fotos: false,
        entraron_7: n(resumen.entraron_7),
        salieron_7: n(resumen.salieron_7),
        entraron_30: n(resumen.entraron_30),
        salieron_30: n(resumen.salieron_30),
        composicion,
        odoo_ok: odooOk,
        por_dia: fotos.slice(0, 30).map((f) => ({ dia: f.dia instanceof Date ? f.dia.toISOString().slice(0, 10) : String(f.dia), total: f.total, altas: n(f.altas), bajas: n(f.bajas) })),
        movimientos: movs.map((m) => ({
            tipo: m.tipo,
            fecha: m.created_at,
            numero: m.numero ? `+${m.numero}` : null,
            nombre: quien.get(m.lid)?.nombre || null,
            quien: quien.get(m.lid)?.tipo || 'sin_identificar',
        })),
    };
}

module.exports = {
    GrupoAvisosError,
    GRUPO_JID,
    ensureSchema,
    leerGrupo,
    tomarFoto,
    tomarFotoSiHaceFalta,
    marcarChats,
    estadisticas,
};
