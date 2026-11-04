// API del agente (Grok Bot): seguimiento de posibles clientes (crm_leads) por WhatsApp.
// La cadencia y el orden de la cola están en agenteLeads.js (lógica pura).
// Regla dura: no escribe nada en Odoo. Lee Odoo solo para chequear, antes de cada envío, que el
// teléfono no sea ya de un contacto de Odoo. Escribe en crm_bot_lead_*, y en el CRM de la app
// (crm_events, crm_followups, crm_actions) para que el equipo vea lo que pasó.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { callOdoo } = require('../config/odoo');
const health = require('./clientHealth');
const { ensureSchema } = require('./crmSchema');
const { buildPhoneIndex } = require('./crmContacts');
const followups = require('./crmFollowupService');
const nuevos = require('./agenteNuevos');
const leads = require('./agenteLeads');

const MIGRACION = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '060_agente_leads.sql'), 'utf8');
// Cada transacción que reserva toma este lock: así dos reservas en paralelo no pasan el tope
const LOCK_TOPE = 60600601;
const TZ = 'America/Argentina/Buenos_Aires';
const INICIO_HOY_SQL = `(date_trunc('day', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;

class AgenteError extends Error {
    constructor(status, message, codigo, details) {
        super(message);
        this.name = 'AgenteError';
        this.status = status;
        this.codigo = codigo;
        this.details = details;
    }
}

let schemaReady = null;

/** Tablas del CRM (crm_leads) y las del bot de leads (060). Idempotente. */
function ensureLeadsSchema() {
    if (!schemaReady) {
        schemaReady = ensureSchema().then(() => pool.query(MIGRACION)).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

async function enTransaccion(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

function hoyAr() {
    return health.toArDate(new Date());
}

function iso(value) {
    return value ? nuevos.toArIso(value) : null;
}

// =============================================
// Lectura
// =============================================

const LEAD_SELECT = `
    SELECT l.id, l.name, l.phone, l.phone_key, l.city, l.source_status, l.source_list, l.odoo_partner_id,
           COALESCE(f.stage, 'frio') AS crm_etapa,
           COALESCE(s.etapa, 'pendiente') AS etapa, s.resultado, s.resultado_at, s.ultimo_contacto,
           COALESCE(s.no_contactar, false) AS no_contactar, s.no_contactar_at, s.contacto, s.revisado_hasta,
           (SELECT MIN(e.created_at) FROM crm_events e
             WHERE e.lead_id = l.id AND e.kind = 'presentacion' AND COALESCE(e.meta->>'origen', '') <> 'agente') AS presentacion_manual,
           m.ultimo_envio, m.ultimo_recibido, m.ultimo_enviado,
           r.id_externo AS reserva_id_externo, r.etapa AS reserva_etapa, r.reservado_hasta AS reserva_hasta
    FROM crm_leads l
    LEFT JOIN crm_followups f ON f.lead_id = l.id
    LEFT JOIN crm_bot_lead_seguimiento s ON s.lead_id = l.id
    LEFT JOIN LATERAL (
        SELECT MAX(fecha) FILTER (WHERE envio_etapa AND estado = 'enviado') AS ultimo_envio,
               MAX(fecha) FILTER (WHERE tipo = 'recibido') AS ultimo_recibido,
               MAX(fecha) FILTER (WHERE tipo = 'enviado' AND estado = 'enviado') AS ultimo_enviado
        FROM crm_bot_lead_mensajes WHERE lead_id = l.id
    ) m ON true
    LEFT JOIN LATERAL (
        SELECT id_externo, etapa, reservado_hasta FROM crm_bot_lead_mensajes
        WHERE lead_id = l.id AND envio_etapa AND estado = 'reservado' AND reservado_hasta >= NOW()
        ORDER BY reservado_hasta DESC LIMIT 1
    ) r ON true`;

/** Envíos de la cadencia de hoy (hora de Argentina): confirmados y reservas vigentes. */
async function enviadosHoy(db = pool) {
    const { rows: [r] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM crm_bot_lead_mensajes
         WHERE envio_etapa AND fecha >= ${INICIO_HOY_SQL}
           AND (estado = 'enviado' OR (estado = 'reservado' AND reservado_hasta >= NOW()))`);
    return r.n;
}

/** Datos del día: horario, tope y cuántos quedan. */
async function meta(db = pool, ahora = new Date()) {
    const tope = leads.topeDiario();
    const enviados = await enviadosHoy(db);
    return {
        hoy: hoyAr(),
        ahora: nuevos.toArIso(ahora),
        ventana_envio: nuevos.VENTANA_ENVIO.texto,
        ventana_abierta: nuevos.ventanaAbierta(ahora),
        abre_a: nuevos.abreA(ahora),
        tope_diario: tope,
        enviados_hoy: enviados,
        quedan_hoy: leads.quedanHoy(tope, enviados),
    };
}

/** Posible cliente como lo ve el agente. Mismo formato en la lista y en la ficha. */
function armarLead(row, info) {
    const zona = leads.zonaDe(row.phone_key);
    // Los que pasaron a Churn porque se lo pidieron al bot siguen visibles como no_contactar
    const excluido = row.no_contactar ? null : leads.motivoExcluido({ phoneKey: row.phone_key, estadoAgenda: row.source_status });
    const bloqueado = Boolean(excluido) || Boolean(row.odoo_partner_id) || row.crm_etapa !== 'frio'
        || ['ya_en_odoo', 'interesado', 'no_interesado'].includes(row.resultado);
    const ef = leads.etapaEfectiva({
        etapa: row.etapa,
        fechaUltimoEnvio: health.toArDate(row.ultimo_envio),
        presentacionManual: health.toArDate(row.presentacion_manual),
    });
    const toca = leads.tocaHoy({
        etapa: row.etapa,
        fechaUltimoEnvio: health.toArDate(row.ultimo_envio),
        presentacionManual: health.toArDate(row.presentacion_manual),
        hoy: info.hoy,
        noContactar: row.no_contactar,
        respondio: Boolean(row.ultimo_recibido),
        bloqueado,
    });
    const pendiente = nuevos.respuestaPendiente({
        ultimoRecibido: row.ultimo_recibido, ultimoEnviado: row.ultimo_enviado, revisadoHasta: row.revisado_hasta,
    });
    const reserva = row.reserva_id_externo
        ? { id_externo: row.reserva_id_externo, etapa: row.reserva_etapa, reservado_hasta: iso(row.reserva_hasta) }
        : null;
    return {
        id: row.id,
        nombre: row.name || null,
        contacto: row.contacto || null,
        telefono: row.phone_key ? `+549${row.phone_key}` : null,
        ciudad: row.city || null,
        zona: zona ? { prioridad: zona.prioridad, localidad: zona.localidad, caracteristica: zona.caracteristica } : null,
        excluido,
        estado_agenda: row.source_status || null,
        lista_agenda: row.source_list || null,
        etapa_crm: row.crm_etapa,
        no_contactar: row.no_contactar,
        no_contactar_at: iso(row.no_contactar_at),
        toca_hoy: toca,
        desde: toca ? leads.proximaFecha(ef.etapa, ef.fecha, info.hoy) : null,
        respondio: Boolean(row.ultimo_recibido),
        respuesta_pendiente: pendiente,
        ultimo_recibido: iso(row.ultimo_recibido),
        reserva_activa: reserva,
        puede_enviar_ahora: Boolean(toca && row.phone_key && info.ventana_abierta && !reserva && info.quedan_hoy > 0),
        seguimiento: {
            etapa: row.etapa,
            presentacion_manual: iso(row.presentacion_manual),
            resultado: row.resultado || null,
            resultado_at: iso(row.resultado_at),
            ultimo_contacto: iso(row.ultimo_contacto),
            ultimo_envio: iso(row.ultimo_envio),
        },
    };
}

async function leerLead(id, db = pool) {
    const { rows: [row] } = await db.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
    return row || null;
}

async function exigirLead(id, db = pool) {
    await ensureLeadsSchema();
    const row = await leerLead(id, db);
    if (!row) throw new AgenteError(404, 'Posible cliente inexistente', 'no_encontrado');
    return row;
}

/**
 * GET leads. Por defecto: los que no están en Odoo, tienen celular y no pidieron que no les
 * escriban. para_hoy=true trae la cola del día ordenada (seguimientos primero, después
 * presentaciones por prioridad). Dispara el sync de clientes si pasaron 24 h, para que la
 * cola no traiga a alguien que ya compró.
 */
async function listarLeads({ para_hoy: paraHoy, con_respuesta_pendiente: conRespuesta, respondio, etapa, resultado, no_contactar: noContactar, page, limit, offset }) {
    await ensureLeadsSchema();
    require('./clientMetricsService').refreshIfStale().catch((err) => console.error('❌ Agente leads: sync de clientes:', err.message));
    // Una vez por día: los que ya están en Odoo salen del listado (la reserva igual lo chequea en vivo)
    cruzarConOdoo().catch((err) => console.error('❌ Agente leads: cruce con Odoo:', err.message));
    await vencerReservas(pool);
    const info = await meta();
    const { rows } = await pool.query(`${LEAD_SELECT} WHERE l.odoo_partner_id IS NULL AND l.phone_key IS NOT NULL`);
    // Fuera de la zona y Churn de la agenda no aparecen nunca
    let lista = rows.map((r) => armarLead(r, info)).filter((x) => !x.excluido);
    if (noContactar !== null) lista = lista.filter((x) => x.no_contactar === (noContactar ?? false));
    if (paraHoy !== undefined) lista = lista.filter((x) => Boolean(x.toca_hoy) === paraHoy);
    if (conRespuesta !== undefined) lista = lista.filter((x) => x.respuesta_pendiente === conRespuesta);
    if (respondio !== undefined) lista = lista.filter((x) => x.respondio === respondio);
    if (etapa) lista = lista.filter((x) => x.seguimiento.etapa === etapa);
    if (resultado) lista = lista.filter((x) => (x.seguimiento.resultado || 'ninguno') === resultado);
    if (paraHoy) lista.sort(leads.compararCola);
    else if (conRespuesta || respondio) lista.sort((a, b) => (b.ultimo_recibido || '').localeCompare(a.ultimo_recibido || ''));
    else lista.sort((a, b) => a.id - b.id);
    return { data: lista.slice(offset, offset + limit), total: lista.length, page, limit, meta: info };
}

/** GET leads/:id: ficha en vivo con los últimos mensajes (chequear justo antes de mandar). */
async function obtenerLead(id) {
    const row = await exigirLead(id);
    await vencerReservas(pool, id);
    const info = await meta();
    const data = armarLead(await leerLead(id), info);
    data.en_odoo = row.odoo_partner_id || null;
    const { rows } = await pool.query(
        'SELECT * FROM crm_bot_lead_mensajes WHERE lead_id = $1 ORDER BY fecha DESC, id DESC LIMIT 20', [id]);
    data.ultimos_mensajes = rows.map(formatMensaje);
    return { data, meta: info };
}

// =============================================
// Odoo: ¿ese celular ya es de un contacto?
// =============================================

/** Contacto de Odoo (cliente, proveedor o archivado) con el mismo celular, o null. */
async function contactoOdooConTelefono(phoneKey) {
    let rows;
    try {
        rows = await callOdoo('res.partner', 'search_read', [[['phone', 'ilike', phoneKey.slice(-4)]]], {
            fields: ['id', 'name', 'phone'], limit: 500, context: { active_test: false },
        });
    } catch (err) {
        console.error('❌ Agente leads: error leyendo Odoo:', err.message);
        throw new AgenteError(502, 'No pude leer Odoo', 'odoo_caido');
    }
    return buildPhoneIndex(rows).find(phoneKey);
}

/**
 * Ya es cliente (está en Odoo con el mismo celular): sale del listado de posibles clientes.
 * Se vincula a ese contacto de Odoo con su historial (como el vínculo automático del CRM) y
 * la cadencia del bot termina.
 */
async function marcarYaEnOdoo(leadId, partner, db = null) {
    const run = async (tx) => {
        const { rows: [lead] } = await tx.query('SELECT odoo_partner_id FROM crm_leads WHERE id = $1 FOR UPDATE', [leadId]);
        if (!lead || lead.odoo_partner_id) return false;
        await lockSeguimiento(tx, leadId);
        await tx.query(
            `UPDATE crm_bot_lead_seguimiento
             SET resultado = 'ya_en_odoo', resultado_at = NOW(), etapa = 'finalizado', updated_at = NOW()
             WHERE lead_id = $1`, [leadId]);
        await tx.query(
            `UPDATE crm_bot_lead_mensajes SET estado = 'cancelado', motivo_cancelacion = 'ya_en_odoo', reservado_hasta = NULL
             WHERE lead_id = $1 AND estado IN ('reservado', 'vencido')`, [leadId]);
        await followups.linkLead(leadId, partner.id, {
            db: tx,
            note: `Estaba como posible cliente y ya está en Odoo como ${partner.name}: sale de posibles clientes`,
        });
        return true;
    };
    const hecho = db ? await run(db) : await enTransaccion(run);
    if (hecho) console.log(`⚠️ Agente leads: el posible cliente ${leadId} ya está en Odoo (#${partner.id}), sale del listado`);
    return hecho;
}

// Cruce de todos los posibles clientes con todos los contactos de Odoo, una vez por día
const CRUCE_CADA_MS = 24 * 60 * 60 * 1000;
let ultimoCruce = 0;
let cruceEnCurso = null;

/**
 * Saca del listado a los posibles clientes cuyo celular ya está en Odoo (clientes, proveedores
 * o archivados, como al importar la agenda). Con forzar=false corre como mucho una vez por día.
 * @returns {Promise<{ vinculados: number }|null>} null si no le tocaba correr
 */
function cruzarConOdoo({ forzar = false } = {}) {
    if (cruceEnCurso) return cruceEnCurso;
    if (!forzar && Date.now() - ultimoCruce < CRUCE_CADA_MS) return Promise.resolve(null);
    cruceEnCurso = (async () => {
        await ensureLeadsSchema();
        const { readOdooPhones } = require('./crmLeadService');
        const index = buildPhoneIndex(await readOdooPhones());
        const { rows } = await pool.query('SELECT id, phone_key FROM crm_leads WHERE odoo_partner_id IS NULL AND phone_key IS NOT NULL');
        let vinculados = 0;
        for (const lead of rows) {
            const partner = index.find(lead.phone_key);
            if (partner && await marcarYaEnOdoo(lead.id, partner)) vinculados++;
        }
        ultimoCruce = Date.now();
        console.log(`✅ Agente leads: cruce con Odoo, ${vinculados} posible(s) cliente(s) ya estaban en Odoo y salieron del listado`);
        return { vinculados };
    })().finally(() => { cruceEnCurso = null; });
    return cruceEnCurso;
}

// =============================================
// Envíos y mensajes
// =============================================

function formatMensaje(r) {
    return {
        id: r.id,
        lead_id: r.lead_id,
        fecha: iso(r.fecha),
        tipo: r.tipo,
        etapa: r.etapa,
        envio_de_etapa: r.envio_etapa,
        estado: r.envio_etapa ? r.estado : null,
        reservado_hasta: r.estado === 'reservado' && r.reservado_hasta ? iso(r.reservado_hasta) : null,
        motivo_cancelacion: r.estado === 'cancelado' ? r.motivo_cancelacion || 'agente' : null,
        mensaje: r.mensaje,
        id_externo: r.id_externo,
    };
}

async function lockSeguimiento(db, id) {
    await db.query('INSERT INTO crm_bot_lead_seguimiento (lead_id) VALUES ($1) ON CONFLICT (lead_id) DO NOTHING', [id]);
    const { rows: [row] } = await db.query('SELECT * FROM crm_bot_lead_seguimiento WHERE lead_id = $1 FOR UPDATE', [id]);
    return row;
}

async function vencerReservas(db, id = null) {
    await db.query(
        `UPDATE crm_bot_lead_mensajes SET estado = 'vencido'
         WHERE estado = 'reservado' AND reservado_hasta < NOW() ${id ? 'AND lead_id = $1' : ''}`, id ? [id] : []);
}

async function porIdExterno(db, id, idExterno) {
    if (!idExterno) return null;
    const { rows: [r] } = await db.query('SELECT * FROM crm_bot_lead_mensajes WHERE id_externo = $1', [idExterno]);
    if (!r) return null;
    if (id !== null && r.lead_id !== id) throw new AgenteError(409, 'Ese id_externo ya se usó con otro posible cliente', 'id_externo_usado');
    return r;
}

function exigirMismoContenido(previa, value) {
    const distinto = previa.mensaje !== value.mensaje
        || (value.etapa !== undefined && (previa.etapa || null) !== (value.etapa || null))
        || (value.tipo !== undefined && previa.tipo !== value.tipo);
    if (distinto) {
        throw new AgenteError(409, 'Ese id_externo ya se usó con otro contenido (mensaje o etapa). Usá un id_externo nuevo', 'id_externo_distinto');
    }
}

function esDuplicado(err) {
    return err && err.code === '23505';
}

async function respuestaEnvio(id, r, repetida) {
    const info = await meta();
    return { data: { envio: formatMensaje(r), lead: armarLead(await leerLead(id), info) }, repetida };
}

/**
 * POST leads/:id/envios: RESERVA un mensaje de la cadencia antes de mandarlo. Chequea con la
 * hora del servidor: horario, tope del día, que no esté en Odoo (en vivo), no contactar, que el
 * equipo no lo esté siguiendo, que no haya contestado, y que la etapa sea la que toca.
 */
async function reservarEnvio(id, value) {
    const lead = await exigirLead(id);
    await vencerReservas(pool, id);
    const repetida = await porIdExterno(pool, id, value.id_externo);
    if (repetida) {
        exigirMismoContenido(repetida, value);
        if (repetida.estado === 'cancelado') throw new AgenteError(409, 'Esa reserva se canceló: reservá con un id_externo nuevo', 'reserva_cancelada');
        if (repetida.estado === 'vencido') throw new AgenteError(409, 'Esa reserva venció: reservá con un id_externo nuevo', 'reserva_vencida');
        return respuestaEnvio(id, repetida, true);
    }
    const ahora = new Date();
    if (!nuevos.ventanaAbierta(ahora)) {
        throw new AgenteError(409, `Fuera del horario de envío: ${nuevos.VENTANA_ENVIO.texto}. Abre: ${nuevos.abreA(ahora)}`, 'fuera_de_horario');
    }
    if (!lead.phone_key) throw new AgenteError(409, 'No tiene un celular válido', 'sin_telefono');
    if (lead.odoo_partner_id) throw new AgenteError(409, 'Ya es cliente en Odoo: se sigue como cliente', 'ya_en_odoo');
    const excluido = leads.motivoExcluido({ phoneKey: lead.phone_key, estadoAgenda: lead.source_status });
    if (excluido === 'churn') throw new AgenteError(409, 'Está en Churn: nos bloqueó o no quiere que lo contactemos', 'churn');
    if (excluido === 'fuera_de_zona') throw new AgenteError(409, 'La característica está fuera de la zona (150 km de Pergamino)', 'fuera_de_zona');
    if (leads.topeDiario() > 0 && (await enviadosHoy()) >= leads.topeDiario()) {
        throw new AgenteError(409, `Ya se llegó al tope de ${leads.topeDiario()} mensajes por hoy`, 'tope_diario');
    }
    const partner = await contactoOdooConTelefono(lead.phone_key);
    if (partner) {
        await marcarYaEnOdoo(id, partner);
        throw new AgenteError(409, `Ese celular ya está en Odoo (${partner.name}, #${partner.id}): no se le escribe como posible cliente`, 'ya_en_odoo');
    }
    try {
        const r = await enTransaccion(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_TOPE]);
            const tope = leads.topeDiario();
            if (tope === 0) throw new AgenteError(409, 'Los envíos a posibles clientes están apagados (tope 0)', 'tope_diario');
            if ((await enviadosHoy(db)) >= tope) throw new AgenteError(409, `Ya se llegó al tope de ${tope} mensajes por hoy`, 'tope_diario');
            await lockSeguimiento(db, id);
            const row = await leerLead(id, db);
            if (row.no_contactar) throw new AgenteError(409, 'Pidió no recibir mensajes', 'no_contactar');
            if (row.crm_etapa !== 'frio') {
                throw new AgenteError(409, `Lo está siguiendo el equipo (etapa ${row.crm_etapa} en el CRM)`, 'seguido_por_el_equipo');
            }
            const { rows: previas } = await db.query(
                `SELECT estado, id_externo FROM crm_bot_lead_mensajes
                 WHERE lead_id = $1 AND envio_etapa AND etapa = $2 AND estado IN ('reservado', 'enviado')`, [id, value.etapa]);
            if (previas.some((x) => x.estado === 'enviado')) throw new AgenteError(409, `La etapa ${value.etapa} ya se envió`, 'ya_enviado');
            if (previas.length) throw new AgenteError(409, `La etapa ${value.etapa} está reservada por otro envío (${previas[0].id_externo})`, 'etapa_reservada');
            if (row.ultimo_recibido) {
                throw new AgenteError(409, 'Ya contestó: la cadencia se frena. Seguí la charla y marcá el resultado', 'respondio');
            }
            const lista = armarLead(row, await meta(db));
            if (value.etapa !== lista.toca_hoy) {
                throw new AgenteError(409, lista.toca_hoy
                    ? `Hoy no le toca ${value.etapa}: le toca ${lista.toca_hoy}`
                    : `Hoy no le toca ningún mensaje (etapa ${row.etapa})`, 'etapa_no_corresponde');
            }
            const { rows: [msg] } = await db.query(
                `INSERT INTO crm_bot_lead_mensajes (lead_id, fecha, tipo, etapa, mensaje, id_externo, envio_etapa, estado, reservado_hasta)
                 VALUES ($1, NOW(), 'enviado', $2, $3, $4, true, 'reservado', NOW() + ($5::int * INTERVAL '1 second'))
                 RETURNING *`, [id, value.etapa, value.mensaje, value.id_externo, nuevos.RESERVA_SEGUNDOS]);
            return msg;
        });
        console.log(`📦 Agente leads: reserva ${value.etapa} para ${id} (${value.id_externo})`);
        return respuestaEnvio(id, r, false);
    } catch (err) {
        if (!esDuplicado(err)) throw err;
        const r = await porIdExterno(pool, id, value.id_externo);
        if (r) return respuestaEnvio(id, r, true);
        throw new AgenteError(409, `La etapa ${value.etapa} ya está reservada o enviada`, 'etapa_reservada');
    }
}

async function exigirEnvio(db, idExterno) {
    await ensureLeadsSchema();
    const r = await porIdExterno(db, null, idExterno);
    if (!r || !r.envio_etapa) throw new AgenteError(404, 'No hay un envío con ese id_externo', 'no_encontrado');
    return r;
}

/**
 * POST leads/envios/:idExterno/confirmar: el WhatsApp salió. Avanza la etapa y lo anota en el
 * CRM (la presentación como presentación; el resto como WhatsApp). Con el cierre, la cadencia
 * termina sin respuesta.
 */
async function confirmarEnvio(idExterno) {
    const previa = await exigirEnvio(pool, idExterno);
    if (previa.estado === 'enviado') return respuestaEnvio(previa.lead_id, previa, true);
    if (previa.estado === 'cancelado' && previa.motivo_cancelacion === 'agente') {
        throw new AgenteError(409, 'Ese envío se canceló: no se puede confirmar', 'reserva_cancelada');
    }
    try {
        const r = await enTransaccion(async (db) => {
            const seg = await lockSeguimiento(db, previa.lead_id);
            const { rows: [row] } = await db.query(
                `UPDATE crm_bot_lead_mensajes SET estado = 'enviado', fecha = NOW(), reservado_hasta = NULL, motivo_cancelacion = NULL
                 WHERE id = $1 AND (estado IN ('reservado', 'vencido') OR (estado = 'cancelado' AND motivo_cancelacion <> 'agente'))
                 RETURNING *`, [previa.id]);
            if (!row) throw new AgenteError(409, 'El envío cambió de estado mientras se confirmaba', 'reserva_cancelada');
            const avanza = seg.etapa !== 'finalizado' && leads.ordenEtapa(row.etapa) > leads.ordenEtapa(seg.etapa);
            await db.query(
                `UPDATE crm_bot_lead_seguimiento
                 SET ultimo_contacto = GREATEST(ultimo_contacto, NOW()), updated_at = NOW()
                     ${avanza ? ', etapa = $2' : ''}
                     ${avanza && row.etapa === 'cierre' ? ", resultado = COALESCE(resultado, 'sin_respuesta'), resultado_at = COALESCE(resultado_at, NOW())" : ''}
                 WHERE lead_id = $1`, avanza ? [row.lead_id, row.etapa] : [row.lead_id]);
            const target = { col: 'lead_id', id: row.lead_id };
            const { rows: [enApp] } = await db.query('SELECT odoo_partner_id FROM crm_leads WHERE id = $1', [row.lead_id]);
            // Si ya pasó a Odoo, el historial está en el cliente
            const destino = enApp.odoo_partner_id ? { col: 'odoo_partner_id', id: enApp.odoo_partner_id } : target;
            await followups.insertEvent(db, destino, row.etapa === 'presentacion'
                ? { kind: 'presentacion', meta: { via: 'whatsapp', origen: 'agente', id_externo: row.id_externo } }
                : { kind: 'whatsapp', text: `Grok Bot (${row.etapa}): ${row.mensaje}`.slice(0, 2000), meta: { origen: 'agente', etapa: row.etapa, id_externo: row.id_externo } });
            return row;
        });
        console.log(`✅ Agente leads: envío ${r.etapa} confirmado para ${r.lead_id}`);
        return respuestaEnvio(r.lead_id, r, false);
    } catch (err) {
        if (esDuplicado(err)) throw new AgenteError(409, `Otro envío ya ocupó la etapa ${previa.etapa}`, 'ya_enviado');
        throw err;
    }
}

/** POST leads/envios/:idExterno/cancelar: el WhatsApp no salió. Libera la etapa (y el lugar en el tope). */
async function cancelarEnvio(idExterno) {
    const previa = await exigirEnvio(pool, idExterno);
    if (previa.estado === 'cancelado') return respuestaEnvio(previa.lead_id, previa, true);
    if (previa.estado === 'enviado') throw new AgenteError(409, 'Ese envío ya se confirmó: no se puede cancelar', 'ya_enviado');
    const { rows: [r] } = await pool.query(
        `UPDATE crm_bot_lead_mensajes SET estado = 'cancelado', motivo_cancelacion = 'agente', reservado_hasta = NULL
         WHERE id = $1 AND estado IN ('reservado', 'vencido') RETURNING *`, [previa.id]);
    if (!r) throw new AgenteError(409, 'Ese envío ya se confirmó: no se puede cancelar', 'ya_enviado');
    return respuestaEnvio(r.lead_id, r, false);
}

/** GET leads/envios/:idExterno. */
async function estadoEnvio(idExterno) {
    const previa = await exigirEnvio(pool, idExterno);
    await vencerReservas(pool, previa.lead_id);
    return formatMensaje(await exigirEnvio(pool, idExterno));
}

/**
 * POST leads/:id/mensajes: la charla fuera de la cadencia (lo que contesta el posible cliente y
 * lo que le responde Grok). Lo recibido queda también en la ficha del CRM.
 */
async function registrarMensaje(id, value) {
    await exigirLead(id);
    try {
        return await enTransaccion(async (db) => {
            const repetida = await porIdExterno(db, id, value.id_externo);
            if (repetida) {
                exigirMismoContenido(repetida, value);
                return { data: formatMensaje(repetida), repetida: true };
            }
            const seg = await lockSeguimiento(db, id);
            if (value.tipo === 'enviado' && seg.no_contactar) throw new AgenteError(409, 'Pidió no recibir mensajes', 'no_contactar');
            const { rows: [row] } = await db.query(
                `INSERT INTO crm_bot_lead_mensajes (lead_id, fecha, tipo, mensaje, id_externo)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, value.fecha, value.tipo, value.mensaje, value.id_externo]);
            if (value.tipo === 'enviado') {
                await db.query(
                    `UPDATE crm_bot_lead_seguimiento SET ultimo_contacto = GREATEST(ultimo_contacto, $2), updated_at = NOW()
                     WHERE lead_id = $1`, [id, value.fecha]);
            } else {
                await followups.insertEvent(db, { col: 'lead_id', id }, {
                    kind: 'nota', text: `Contestó por WhatsApp a Grok Bot: ${value.mensaje}`.slice(0, 2000),
                    meta: { origen: 'agente', tipo: 'recibido' },
                });
            }
            return { data: formatMensaje(row), repetida: false };
        });
    } catch (err) {
        if (esDuplicado(err) && value.id_externo) {
            const r = await porIdExterno(pool, id, value.id_externo);
            if (r) return { data: formatMensaje(r), repetida: true };
        }
        throw err;
    }
}

/** GET leads/:id/mensajes, del más nuevo al más viejo. */
async function listarMensajes(id, { page, limit, offset }) {
    await exigirLead(id);
    const { rows: [c] } = await pool.query('SELECT COUNT(*)::int AS total FROM crm_bot_lead_mensajes WHERE lead_id = $1', [id]);
    const { rows } = await pool.query(
        'SELECT * FROM crm_bot_lead_mensajes WHERE lead_id = $1 ORDER BY fecha DESC, id DESC LIMIT $2 OFFSET $3', [id, limit, offset]);
    return { data: rows.map(formatMensaje), total: c.total, page, limit };
}

/** POST leads/:id/revisado: Grok leyó la respuesta y no hace falta contestar. */
async function marcarRevisado(id) {
    await exigirLead(id);
    await enTransaccion(async (db) => {
        await lockSeguimiento(db, id);
        await db.query('UPDATE crm_bot_lead_seguimiento SET revisado_hasta = NOW(), updated_at = NOW() WHERE lead_id = $1', [id]);
    });
    return (await obtenerLead(id)).data;
}

/** Cambia la etapa del CRM (si no la cambió antes el equipo) y lo deja en el historial. */
async function etapaCrm(db, leadId, to, motivo) {
    const { rows: [prev] } = await db.query('SELECT stage FROM crm_followups WHERE lead_id = $1 FOR UPDATE', [leadId]);
    const from = prev?.stage || 'frio';
    if (from !== 'frio' || from === to) return;
    await db.query(
        `INSERT INTO crm_followups (lead_id, stage, discard_reason, stage_changed_at, stage_changed_by)
         VALUES ($1, $2, $3, NOW(), NULL)
         ON CONFLICT (lead_id) DO UPDATE
         SET stage = EXCLUDED.stage, discard_reason = EXCLUDED.discard_reason, stage_changed_at = NOW(), stage_changed_by = NULL`,
        [leadId, to, to === 'descartado' ? motivo : null]);
    await followups.insertEvent(db, { col: 'lead_id', id: leadId }, { kind: 'etapa', text: motivo, meta: { from, to, origen: 'agente' } });
}

const TEXTOS_RESULTADO = {
    interesado: 'Le interesó (Grok Bot)',
    no_interesado: 'No le interesa (Grok Bot)',
    no_contactar: 'Pidió por WhatsApp que no le escriban más (Grok Bot)',
};

/**
 * PATCH leads/:id: { no_contactar, contacto, resultado, nota }.
 * - interesado: pasa a Templado en el CRM y le deja al equipo una acción para hoy.
 * - no_interesado: Descartado en el CRM.
 * - no_contactar: Descartado y no se le escribe más. El agente no lo puede desmarcar.
 * En los tres casos la cadencia termina.
 */
async function actualizarLead(id, value) {
    await exigirLead(id);
    const resultado = value.no_contactar === true ? 'no_contactar' : value.resultado;
    await enTransaccion(async (db) => {
        const seg = await lockSeguimiento(db, id);
        if (value.no_contactar === false && seg.no_contactar) {
            throw new AgenteError(409, 'Pidió no recibir mensajes: solo lo puede desmarcar el equipo de Neggo', 'no_contactar');
        }
        if (resultado && !(resultado === 'no_contactar' && seg.no_contactar)) {
            const error = leads.errorResultado(seg.resultado, resultado);
            if (error) throw new AgenteError(409, error, seg.resultado === 'no_contactar' ? 'no_contactar' : 'transicion_invalida');
        }
        const sets = ['updated_at = NOW()'];
        const params = [id];
        if ('contacto' in value) {
            params.push(value.contacto);
            sets.push(`contacto = $${params.length}`);
        }
        if (resultado && seg.resultado !== resultado) {
            params.push(resultado);
            sets.push(`resultado = $${params.length}`, 'resultado_at = NOW()', "etapa = 'finalizado'");
            if (resultado === 'no_contactar') {
                sets.push('no_contactar = true', 'no_contactar_at = NOW()');
                // Los que se caen pasan a Churn, como en la agenda
                await db.query("UPDATE crm_leads SET source_status = 'churn' WHERE id = $1", [id]);
            }
            await db.query(
                `UPDATE crm_bot_lead_mensajes SET estado = 'cancelado', motivo_cancelacion = $2, reservado_hasta = NULL
                 WHERE lead_id = $1 AND estado IN ('reservado', 'vencido')`, [id, resultado === 'no_contactar' ? 'no_contactar' : 'resultado']);
            const texto = [TEXTOS_RESULTADO[resultado], value.nota].filter(Boolean).join(': ');
            await followups.insertEvent(db, { col: 'lead_id', id }, { kind: 'nota', text: texto, meta: { origen: 'agente', resultado } });
            if (resultado === 'interesado') {
                await etapaCrm(db, id, 'templado', null);
                await db.query(
                    `INSERT INTO crm_actions (lead_id, action_type, note, due_date)
                     VALUES ($1, 'whatsapp', $2, $3)`,
                    [id, `Le interesó a Grok Bot: seguir la charla${value.nota ? ` (${value.nota})` : ''}`.slice(0, 500), hoyAr()]);
            } else {
                await etapaCrm(db, id, 'descartado', TEXTOS_RESULTADO[resultado]);
            }
        }
        await db.query(`UPDATE crm_bot_lead_seguimiento SET ${sets.join(', ')} WHERE lead_id = $1`, params);
    });
    if (resultado) console.log(`✅ Agente leads: posible cliente ${id} → ${resultado}`);
    return (await obtenerLead(id)).data;
}

// =============================================
// Resumen para la app (pestaña del bot en Clientes)
// =============================================

/** Cuántos van hoy, cómo viene la cadencia y los últimos mensajes. */
async function resumenBot() {
    await ensureLeadsSchema();
    await vencerReservas(pool);
    const info = await meta();
    const { rows } = await pool.query(`${LEAD_SELECT} WHERE l.phone_key IS NOT NULL`);
    const enOdoo = new Set(rows.filter((r) => r.odoo_partner_id).map((r) => r.id));
    const todos = rows.map((r) => armarLead(r, info));
    const lista = todos.filter((x) => !x.excluido);
    const activos = lista.filter((x) => !enOdoo.has(x.id));
    const contar = (fn) => lista.reduce((acc, x) => { const k = fn(x); if (k) acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const { rows: ultimos } = await pool.query(
        `SELECT m.*, l.name AS lead_name, l.phone_key FROM crm_bot_lead_mensajes m JOIN crm_leads l ON l.id = m.lead_id
         WHERE m.estado IN ('enviado', 'reservado') ORDER BY m.fecha DESC, m.id DESC LIMIT 40`);
    const { rows: porDia } = await pool.query(
        `SELECT (fecha AT TIME ZONE '${TZ}')::date::text AS dia, COUNT(*)::int AS n
         FROM crm_bot_lead_mensajes WHERE envio_etapa AND estado = 'enviado' AND fecha >= NOW() - INTERVAL '14 days'
         GROUP BY 1 ORDER BY 1`);
    return {
        meta: info,
        cola_hoy: activos.filter((x) => x.toca_hoy).length,
        en_zona: activos.length,
        ya_en_odoo: enOdoo.size,
        excluidos: {
            fuera_de_zona: todos.filter((x) => x.excluido === 'fuera_de_zona').length,
            churn: todos.filter((x) => x.excluido === 'churn').length,
        },
        por_localidad: contar((x) => (enOdoo.has(x.id) ? null : x.zona && x.zona.localidad)),
        por_etapa: contar((x) => x.seguimiento.etapa),
        por_resultado: contar((x) => x.seguimiento.resultado),
        // Los que ya tienen resultado los sigue el equipo (interesado) o no se les escribe más
        respuestas_pendientes: activos
            .filter((x) => x.respuesta_pendiente && [null, 'sin_respuesta'].includes(x.seguimiento.resultado))
            .map((x) => ({ id: x.id, nombre: x.nombre, telefono: x.telefono, ultimo_recibido: x.ultimo_recibido })),
        sin_contactar: activos.filter((x) => x.seguimiento.etapa === 'pendiente' && !x.seguimiento.presentacion_manual && !x.no_contactar).length,
        por_dia: porDia,
        ultimos: ultimos.map((m) => ({ ...formatMensaje(m), nombre: m.lead_name, telefono: m.phone_key ? `+549${m.phone_key}` : null })),
    };
}

module.exports = {
    AgenteError,
    ensureLeadsSchema,
    listarLeads,
    obtenerLead,
    reservarEnvio,
    confirmarEnvio,
    cancelarEnvio,
    estadoEnvio,
    registrarMensaje,
    listarMensajes,
    marcarRevisado,
    actualizarLead,
    resumenBot,
    cruzarConOdoo,
};
