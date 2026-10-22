// CRM de clientes, fase 2: etapa del funnel, próximas acciones, historial y Mi día.
// Cada seguimiento es de un cliente de Odoo (odoo_partner_id) o de un posible cliente (lead_id).
// Todos son responsables de todo (D8): no hay dueño por cliente, pero queda quién hizo cada cosa.

const pool = require('../config/database');
const health = require('./clientHealth');
const { ensureSchema } = require('./crmSchema');
const { buildPhoneIndex } = require('./crmContacts');

const COMPANY = 'neggo';
// Frío → Templado → Caliente → Ganado; Descartado como salida (D9). Ganado lo marca una compra.
const STAGES = ['frio', 'templado', 'caliente', 'ganado', 'descartado'];
const MANUAL_STAGES = ['frio', 'templado', 'caliente', 'descartado'];
const DEFAULT_STAGE = 'frio';
// Tipos de acción y de contacto registrado (D12; el envío por mail queda para después)
const ACTION_TYPES = ['llamar', 'whatsapp', 'visitar', 'lista', 'otra'];
const EVENT_KINDS = ['nota', ...ACTION_TYPES];
const TARGET_COLUMN = { cliente: 'odoo_partner_id', lead: 'lead_id' };
// Importancia que marca el equipo: 0 = sin marcar, 5 = la más alta (nota #71)
const IMPORTANCE_MAX = 5;

class FollowupError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function todayAr() {
    return health.toArDate(new Date());
}

function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(value));
}

/**
 * Una compra después de pasar a Caliente lo hace Ganado (plan, sección 3).
 * @param {{ stage: string, stage_changed_at: Date|string }} followup
 * @param {string|null} lastPurchaseDate — YYYY-MM-DD
 */
function shouldWin(followup, lastPurchaseDate) {
    if (!followup || followup.stage !== 'caliente' || !lastPurchaseDate) return false;
    const since = health.toArDate(followup.stage_changed_at instanceof Date
        ? followup.stage_changed_at
        : new Date(followup.stage_changed_at));
    return Boolean(since) && String(lastPurchaseDate).slice(0, 10) >= since;
}

/** Valida la importancia (entero de 0 a IMPORTANCE_MAX). */
function parseImportance(value) {
    const n = Number(value);
    if (value === null || value === '' || !Number.isInteger(n) || n < 0 || n > IMPORTANCE_MAX) {
        throw new FollowupError('Importancia inválida');
    }
    return n;
}

/** Valida y normaliza { tipo, id } → { tipo, col, id }. */
function toTarget(tipo, id) {
    const col = TARGET_COLUMN[tipo];
    const n = parseInt(id, 10);
    if (!col || !n) throw new FollowupError('Cliente inválido');
    return { tipo, col, id: n };
}

async function assertTargetExists(target, db = pool) {
    const { rows } = target.tipo === 'cliente'
        ? await db.query(
            'SELECT 1 FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = $2 AND is_generic = false',
            [COMPANY, target.id])
        : await db.query('SELECT 1 FROM crm_leads WHERE id = $1', [target.id]);
    if (!rows.length) throw new FollowupError('No encontré ese cliente', 404);
}

/** Etapa, acciones pendientes e historial de un cliente o posible cliente. */
async function getFollowup(target) {
    await ensureSchema();
    const { rows: [f] } = await pool.query(
        `SELECT f.stage, f.discard_reason, f.stage_changed_at, u.display_name AS stage_changed_by_name,
                f.importance
         FROM crm_followups f LEFT JOIN users u ON u.id = f.stage_changed_by
         WHERE f.${target.col} = $1`, [target.id]);
    const { rows: actions } = await pool.query(
        `SELECT a.id, a.action_type, a.note, a.due_date::text AS due_date, a.created_at,
                u.display_name AS created_by_name
         FROM crm_actions a LEFT JOIN users u ON u.id = a.created_by
         WHERE a.${target.col} = $1 AND a.done = false
         ORDER BY a.due_date ASC, a.id ASC`, [target.id]);
    const { rows: events } = await pool.query(
        `SELECT e.id, e.kind, e.text, e.meta, e.created_at, u.display_name AS user_name
         FROM crm_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.${target.col} = $1
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT 100`, [target.id]);
    return {
        stage: f?.stage || DEFAULT_STAGE,
        discard_reason: f?.discard_reason || null,
        stage_changed_at: f?.stage_changed_at || null,
        stage_changed_by_name: f?.stage_changed_by_name || null,
        importance: f?.importance || 0,
        actions,
        events,
    };
}

async function insertEvent(db, target, { kind, text = null, meta = {}, userId = null }) {
    await db.query(
        `INSERT INTO crm_events (${target.col}, kind, text, meta, user_id) VALUES ($1, $2, $3, $4, $5)`,
        [target.id, kind, text, JSON.stringify(meta), userId]);
}

async function withTransaction(fn) {
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

/** Cambia la etapa a mano y lo deja en el historial. Descartar pide motivo. */
async function setStage(target, { stage, reason, userId }) {
    await ensureSchema();
    if (!MANUAL_STAGES.includes(stage)) throw new FollowupError('Etapa inválida');
    const motivo = String(reason || '').trim().slice(0, 200) || null;
    if (stage === 'descartado' && !motivo) throw new FollowupError('Contá por qué lo descartás');
    await assertTargetExists(target);
    return withTransaction(async (db) => {
        const { rows: [prev] } = await db.query(
            `SELECT stage FROM crm_followups WHERE ${target.col} = $1 FOR UPDATE`, [target.id]);
        const from = prev?.stage || DEFAULT_STAGE;
        if (from === stage && stage !== 'descartado') return { stage, changed: false };
        await db.query(
            `INSERT INTO crm_followups (${target.col}, stage, discard_reason, stage_changed_at, stage_changed_by)
             VALUES ($1, $2, $3, NOW(), $4)
             ON CONFLICT (${target.col}) DO UPDATE
             SET stage = EXCLUDED.stage, discard_reason = EXCLUDED.discard_reason,
                 stage_changed_at = NOW(), stage_changed_by = EXCLUDED.stage_changed_by`,
            [target.id, stage, stage === 'descartado' ? motivo : null, userId]);
        await insertEvent(db, target, { kind: 'etapa', text: motivo, meta: { from, to: stage }, userId });
        return { stage, changed: true };
    });
}

/** Marca la importancia (0 a 5). Si no tenía seguimiento, lo crea en Frío sin fecha de etapa. */
async function setImportance(target, { importance, userId }) {
    await ensureSchema();
    const n = parseImportance(importance);
    await assertTargetExists(target);
    await pool.query(
        `INSERT INTO crm_followups (${target.col}, importance, importance_changed_at, importance_changed_by, stage_changed_at)
         VALUES ($1, $2, NOW(), $3, NULL)
         ON CONFLICT (${target.col}) DO UPDATE
         SET importance = EXCLUDED.importance, importance_changed_at = NOW(),
             importance_changed_by = EXCLUDED.importance_changed_by`,
        [target.id, n, userId]);
    return { importance: n };
}

// Tope de clientes por pedido al marcar varios juntos (la lista carga de a 50)
const BULK_MAX = 500;

/** Valida la lista de clientes elegidos: enteros positivos, sin repetir. */
function parsePartnerIds(value) {
    if (!Array.isArray(value) || !value.length) throw new FollowupError('Elegí al menos un cliente');
    const ids = [...new Set(value.map((v) => Number(v)))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new FollowupError('Cliente inválido');
    if (ids.length > BULK_MAX) throw new FollowupError(`Elegí hasta ${BULK_MAX} clientes por vez`);
    return ids;
}

/** Pone la misma importancia a varios clientes de una vez (nota #75). Ignora los que no existen. */
async function setImportanceMany(partnerIds, { importance, userId }) {
    await ensureSchema();
    const n = parseImportance(importance);
    const ids = parsePartnerIds(partnerIds);
    const { rowCount } = await pool.query(
        `INSERT INTO crm_followups (odoo_partner_id, importance, importance_changed_at, importance_changed_by, stage_changed_at)
         SELECT DISTINCT c.odoo_partner_id, $3::smallint, NOW(), $4::int, NULL::timestamp
           FROM client_metrics_cache c
          WHERE c.company = $1 AND c.odoo_partner_id = ANY($2::int[]) AND c.is_generic = false
         ON CONFLICT (odoo_partner_id) DO UPDATE
         SET importance = EXCLUDED.importance, importance_changed_at = NOW(),
             importance_changed_by = EXCLUDED.importance_changed_by`,
        [COMPANY, ids, n, userId]);
    if (!rowCount) throw new FollowupError('No encontré esos clientes', 404);
    return { importance: n, updated: rowCount };
}

/** Registra un contacto hecho (llamada, WhatsApp, visita…) o una nota. */
async function addEvent(target, { kind, text, userId }) {
    await ensureSchema();
    if (!EVENT_KINDS.includes(kind)) throw new FollowupError('Tipo de contacto inválido');
    const texto = String(text || '').trim().slice(0, 2000);
    if (!texto) throw new FollowupError('Escribí qué pasó');
    await assertTargetExists(target);
    await insertEvent(pool, target, { kind, text: texto, userId });
    return { ok: true };
}

/** Programa la próxima acción. */
async function createAction(target, { type, dueDate, note, userId }) {
    await ensureSchema();
    if (!ACTION_TYPES.includes(type)) throw new FollowupError('Tipo de acción inválido');
    if (!isIsoDate(dueDate)) throw new FollowupError('Elegí una fecha');
    await assertTargetExists(target);
    const { rows: [row] } = await pool.query(
        `INSERT INTO crm_actions (${target.col}, action_type, note, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [target.id, type, String(note || '').trim().slice(0, 500) || null, dueDate, userId]);
    return { id: row.id };
}

/** Reprograma o corrige una acción pendiente. */
async function updateAction(actionId, { type, dueDate, note }) {
    await ensureSchema();
    const sets = [];
    const params = [];
    if (type !== undefined) {
        if (!ACTION_TYPES.includes(type)) throw new FollowupError('Tipo de acción inválido');
        params.push(type); sets.push(`action_type = $${params.length}`);
    }
    if (dueDate !== undefined) {
        if (!isIsoDate(dueDate)) throw new FollowupError('Elegí una fecha');
        params.push(dueDate); sets.push(`due_date = $${params.length}`);
    }
    if (note !== undefined) {
        params.push(String(note || '').trim().slice(0, 500) || null); sets.push(`note = $${params.length}`);
    }
    if (!sets.length) throw new FollowupError('No hay nada para cambiar');
    params.push(parseInt(actionId, 10));
    const { rowCount } = await pool.query(
        `UPDATE crm_actions SET ${sets.join(', ')} WHERE id = $${params.length} AND done = false`, params);
    if (!rowCount) throw new FollowupError('Esa acción no existe o ya está hecha', 404);
    return { ok: true };
}

/** Marca la acción como hecha y registra el resultado en el historial. */
async function completeAction(actionId, { result, userId }) {
    await ensureSchema();
    const texto = String(result || '').trim().slice(0, 2000);
    if (!texto) throw new FollowupError('Contá cómo te fue');
    return withTransaction(async (db) => {
        const { rows: [a] } = await db.query(
            `UPDATE crm_actions SET done = true, done_at = NOW(), done_by = $2, result = $3
             WHERE id = $1 AND done = false
             RETURNING id, odoo_partner_id, lead_id, action_type, note, due_date::text AS due_date`,
            [parseInt(actionId, 10), userId, texto]);
        if (!a) throw new FollowupError('Esa acción no existe o ya está hecha', 404);
        const target = a.odoo_partner_id
            ? { tipo: 'cliente', col: 'odoo_partner_id', id: a.odoo_partner_id }
            : { tipo: 'lead', col: 'lead_id', id: a.lead_id };
        await insertEvent(db, target, {
            kind: a.action_type, text: texto,
            meta: { action_id: a.id, planned: a.note, due_date: a.due_date }, userId,
        });
        return { tipo: target.tipo, id: target.id };
    });
}

/**
 * Mi día: acciones pendientes vencidas, de hoy y de mañana, de todos (D8).
 * Con mine=true, solo las que programó el usuario.
 */
async function myDay({ userId, mine = false } = {}) {
    await ensureSchema();
    const today = todayAr();
    const tomorrow = health.addDays(today, 1);
    const params = [COMPANY, tomorrow];
    let filtro = '';
    if (mine && userId) { params.push(userId); filtro = `AND a.created_by = $${params.length}`; }
    const { rows } = await pool.query(
        `SELECT a.id, a.action_type, a.note, a.due_date::text AS due_date, a.created_at,
                a.odoo_partner_id, a.lead_id,
                CASE WHEN a.odoo_partner_id IS NOT NULL THEN 'cliente' ELSE 'lead' END AS tipo,
                COALESCE(c.partner_name, l.name) AS name, COALESCE(c.phone, l.phone) AS phone,
                c.health, c.rubro, COALESCE(c.city, l.city) AS city, l.source_status,
                COALESCE(f.stage, 'frio') AS stage, u.display_name AS created_by_name
         FROM crm_actions a
         LEFT JOIN client_metrics_cache c ON c.company = $1 AND c.odoo_partner_id = a.odoo_partner_id
         LEFT JOIN crm_leads l ON l.id = a.lead_id
         LEFT JOIN crm_followups f ON f.odoo_partner_id = a.odoo_partner_id OR f.lead_id = a.lead_id
         LEFT JOIN users u ON u.id = a.created_by
         WHERE a.done = false AND a.due_date <= $2 ${filtro}
         ORDER BY a.due_date ASC, a.id ASC`, params);
    const { rows: [counts] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE done = false AND due_date > $1)::int AS proximas,
                COUNT(*) FILTER (WHERE done = true AND done_at >= $2::date + INTERVAL '3 hours')::int AS hechas_hoy
         FROM crm_actions`, [tomorrow, today]);
    return {
        today,
        vencidas: rows.filter((r) => r.due_date < today),
        hoy: rows.filter((r) => r.due_date === today),
        manana: rows.filter((r) => r.due_date === tomorrow),
        proximas: counts.proximas,
        hechas_hoy: counts.hechas_hoy,
    };
}

/**
 * Después de cada sync de métricas:
 * 1. Un posible cliente que aparece en Odoo con el mismo teléfono pasa a ser ese cliente,
 *    con su etapa, acciones e historial.
 * 2. Un cliente en Caliente que compró después de pasar a Caliente queda Ganado.
 */
async function afterSync() {
    await ensureSchema();
    let vinculados = 0;
    let ganados = 0;

    const { rows: leads } = await pool.query(
        'SELECT id, phone_key FROM crm_leads WHERE odoo_partner_id IS NULL AND phone_key IS NOT NULL');
    if (leads.length) {
        const { rows: partners } = await pool.query(
            `SELECT odoo_partner_id AS id, phone FROM client_metrics_cache
             WHERE company = $1 AND is_generic = false AND phone IS NOT NULL`, [COMPANY]);
        const index = buildPhoneIndex(partners);
        for (const lead of leads) {
            const partner = index.find(lead.phone_key);
            if (!partner) continue;
            await linkLead(lead.id, partner.id);
            vinculados++;
        }
    }

    const { rows: calientes } = await pool.query(
        `SELECT f.id, f.odoo_partner_id, f.stage, f.stage_changed_at, c.last_purchase_date::text AS last_purchase_date
         FROM crm_followups f
         JOIN client_metrics_cache c ON c.company = $1 AND c.odoo_partner_id = f.odoo_partner_id
         WHERE f.stage = 'caliente'`, [COMPANY]);
    for (const f of calientes) {
        if (!shouldWin(f, f.last_purchase_date)) continue;
        await withTransaction(async (db) => {
            await db.query(
                `UPDATE crm_followups SET stage = 'ganado', stage_changed_at = NOW(), stage_changed_by = NULL
                 WHERE id = $1 AND stage = 'caliente'`, [f.id]);
            await insertEvent(db, { col: 'odoo_partner_id', id: f.odoo_partner_id }, {
                kind: 'compra', text: 'Compró después de pasar a Caliente',
                meta: { from: 'caliente', to: 'ganado', purchase_date: f.last_purchase_date, auto: true },
            });
        });
        ganados++;
    }
    if (vinculados || ganados) console.log(`✅ CRM: ${vinculados} posible(s) cliente(s) vinculados a Odoo, ${ganados} ganado(s)`);
    return { vinculados, ganados };
}

async function linkLead(leadId, partnerId) {
    await withTransaction(async (db) => {
        await db.query('UPDATE crm_leads SET odoo_partner_id = $2, linked_at = NOW() WHERE id = $1', [leadId, partnerId]);
        await db.query('UPDATE crm_events SET odoo_partner_id = $2, lead_id = NULL WHERE lead_id = $1', [leadId, partnerId]);
        await db.query('UPDATE crm_actions SET odoo_partner_id = $2, lead_id = NULL WHERE lead_id = $1', [leadId, partnerId]);
        const { rows: [own] } = await db.query('SELECT 1 FROM crm_followups WHERE odoo_partner_id = $1', [partnerId]);
        if (own) await db.query('DELETE FROM crm_followups WHERE lead_id = $1', [leadId]);
        else await db.query('UPDATE crm_followups SET odoo_partner_id = $2, lead_id = NULL WHERE lead_id = $1', [leadId, partnerId]);
        await insertEvent(db, { col: 'odoo_partner_id', id: partnerId }, {
            kind: 'nota', text: 'Apareció en Odoo con el mismo teléfono: pasa de posible cliente a cliente',
            meta: { lead_id: leadId, auto: true },
        });
    });
}

module.exports = {
    STAGES,
    MANUAL_STAGES,
    ACTION_TYPES,
    EVENT_KINDS,
    IMPORTANCE_MAX,
    FollowupError,
    parseImportance,
    parsePartnerIds,
    shouldWin,
    toTarget,
    getFollowup,
    setStage,
    setImportance,
    setImportanceMany,
    addEvent,
    createAction,
    updateAction,
    completeAction,
    myDay,
    afterSync,
};
