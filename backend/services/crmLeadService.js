// CRM de clientes, fase 2: posibles clientes (todavía no están en Odoo).
// Solo con celular o mail (D11). Antes de cargar se cruzan con los teléfonos de Odoo y con los
// ya cargados, para no duplicar.

const pool = require('../config/database');
const { callOdoo } = require('../config/odoo');
const { ensureSchema } = require('./crmSchema');
const contacts = require('./crmContacts');
const { FollowupError } = require('./crmFollowupService');

const SOURCE_STATUSES = contacts.SOURCE_STATUS_ORDER;
const SORTS = {
    recientes: 'l.created_at DESC, l.id DESC',
    nombre: 'l.name ASC NULLS LAST, l.id ASC',
    accion: 'next_action_date ASC NULLS LAST, l.name ASC NULLS LAST',
};

/** Teléfonos de todos los contactos de Odoo (clientes, proveedores, archivados). */
async function readOdooPhones() {
    const out = [];
    for (let offset = 0; ; offset += 2000) {
        const rows = await callOdoo('res.partner', 'search_read', [[['phone', '!=', false]]], {
            fields: ['id', 'name', 'phone'], limit: 2000, offset, order: 'id asc',
            context: { active_test: false },
        });
        out.push(...rows);
        if (rows.length < 2000) break;
    }
    return out;
}

/** Posibles clientes que no están cargados ni en la app ni en Odoo. */
async function splitNew(list, odooPartners) {
    const { nuevos, enOdoo } = contacts.splitAgainstOdoo(list, contacts.buildPhoneIndex(odooPartners));
    const keys = nuevos.map((c) => c.phone_key).filter(Boolean);
    const { rows } = keys.length
        ? await pool.query('SELECT phone_key FROM crm_leads WHERE phone_key = ANY($1)', [keys])
        : { rows: [] };
    const cargados = new Set(rows.map((r) => r.phone_key));
    return {
        aCargar: nuevos.filter((c) => !cargados.has(c.phone_key)),
        yaCargados: nuevos.filter((c) => cargados.has(c.phone_key)).length,
        enOdoo,
    };
}

/**
 * Importa un CSV de Google Contacts. Con dryRun solo devuelve el resumen.
 * @returns {Promise<object>} resumen: filas, descartados, en Odoo, ya cargados, a cargar, cargados
 */
async function importGoogleContacts(csvText, { userId = null, dryRun = false } = {}) {
    await ensureSchema();
    const rows = contacts.parseCsv(csvText);
    if (!rows.length || !rows[0].includes('Phone 1 - Value')) {
        throw new FollowupError('No parece un CSV exportado de Google Contacts');
    }
    const { contacts: limpios, discarded } = contacts.cleanGoogleContacts(rows);
    const odooPartners = await readOdooPhones();
    const { aCargar, yaCargados, enOdoo } = await splitNew(limpios, odooPartners);

    const resumen = {
        filas: rows.length - 1,
        descartados: discarded,
        unicos: limpios.length,
        en_odoo: enOdoo.length,
        ya_cargados: yaCargados,
        a_cargar: aCargar.length,
        sin_nombre: aCargar.filter((c) => !c.name).length,
        por_estado: aCargar.reduce((acc, c) => {
            const k = c.source_status || 'sin_estado';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {}),
        ejemplos_en_odoo: enOdoo.slice(0, 10).map(({ contact, partner }) => ({
            contacto: contact.name, telefono: contact.phone, odoo: partner.name, odoo_id: partner.id,
        })),
        cargados: 0,
    };
    if (dryRun || !aCargar.length) return resumen;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < aCargar.length; i += 200) {
            const batch = aCargar.slice(i, i + 200);
            const params = [];
            const values = batch.map((c) => {
                params.push(c.name, c.phone, c.phone_key, c.email, c.city, c.source_status, c.source_list, userId);
                const n = params.length;
                return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, 'google_contacts', $${n - 2}, $${n - 1}, $${n})`;
            });
            const { rowCount } = await client.query(
                `INSERT INTO crm_leads (name, phone, phone_key, email, city, source, source_status, source_list, created_by)
                 VALUES ${values.join(', ')}
                 ON CONFLICT (phone_key) DO NOTHING`, params);
            resumen.cargados += rowCount;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    console.log(`✅ CRM: ${resumen.cargados} posible(s) cliente(s) importados de Google Contacts (${resumen.en_odoo} ya estaban en Odoo)`);
    return resumen;
}

/** Alta a mano. Pide celular o mail y avisa si ya existe en Odoo o en la app. */
async function createLead({ name, phone, email, city, userId }) {
    await ensureSchema();
    const nombre = String(name || '').trim().slice(0, 200);
    if (!nombre) throw new FollowupError('Poné un nombre');
    const key = phone ? contacts.phoneKey(phone) : null;
    if (phone && !key) throw new FollowupError('El celular tiene que tener característica y número, por ejemplo 2477 51-9062');
    const mail = String(email || '').trim().toLowerCase().slice(0, 200) || null;
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new FollowupError('El mail no parece válido');
    if (!key && !mail) throw new FollowupError('Hace falta un celular o un mail para poder contactarlo');

    if (key) {
        const { rows: [ya] } = await pool.query('SELECT id, name FROM crm_leads WHERE phone_key = $1', [key]);
        if (ya) throw new FollowupError(`Ya está cargado como «${ya.name || contacts.phoneDisplay(key)}»`, 409);
        const partner = contacts.buildPhoneIndex(await readOdooPhones()).find(key);
        if (partner) throw new FollowupError(`Ya es cliente en Odoo: «${partner.name}»`, 409);
    }
    const { rows: [row] } = await pool.query(
        `INSERT INTO crm_leads (name, phone, phone_key, email, city, source, created_by)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id`,
        [nombre, contacts.phoneDisplay(key), key, mail, String(city || '').trim().slice(0, 120) || null, userId]);
    return { id: row.id };
}

const LEAD_SELECT = `
    SELECT l.id, l.name, l.phone, l.email, l.city, l.source, l.source_status, l.source_list, l.created_at,
           COALESCE(f.stage, 'frio') AS stage,
           (SELECT MIN(a.due_date)::text FROM crm_actions a WHERE a.lead_id = l.id AND a.done = false) AS next_action_date,
           (SELECT MAX(e.created_at) FROM crm_events e WHERE e.lead_id = l.id) AS last_event_at,
           (SELECT MAX(e.created_at) FROM crm_events e WHERE e.lead_id = l.id AND e.kind = 'presentacion') AS presentacion_at
    FROM crm_leads l
    LEFT JOIN crm_followups f ON f.lead_id = l.id`;

// Ya recibió el mensaje de presentación (nota #81). Antes no se anotaba: arrancan todos sin.
const PRESENTACION_EXISTS = `EXISTS (SELECT 1 FROM crm_events e WHERE e.lead_id = l.id AND e.kind = 'presentacion')`;

/**
 * Listado de posibles clientes (sin los que ya pasaron a Odoo).
 * presentacion: 'sin' | 'con' según si ya se le mandó el mensaje de presentación (nota #81);
 * celular: solo los que tienen celular (para mandarles por WhatsApp).
 * @param {{ search?: string, status?: string, stage?: string, city?: string, presentacion?: string, celular?: boolean, sort?: string, limit?: number, offset?: number }} f
 */
async function listLeads(f = {}) {
    await ensureSchema();
    const where = ['l.odoo_partner_id IS NULL'];
    const params = [];
    const search = String(f.search || '').trim();
    if (search) {
        params.push(`%${search}%`);
        const digits = search.replace(/\D/g, '');
        if (digits.length >= 4) {
            params.push(`%${digits}%`);
            where.push(`(l.name ILIKE $${params.length - 1} OR l.email ILIKE $${params.length - 1} OR l.phone LIKE $${params.length})`);
        } else {
            where.push(`(l.name ILIKE $${params.length} OR l.email ILIKE $${params.length})`);
        }
    }
    if (f.status === 'sin_estado') where.push('l.source_status IS NULL');
    else if (SOURCE_STATUSES.includes(f.status)) { params.push(f.status); where.push(`l.source_status = $${params.length}`); }
    if (f.stage) { params.push(f.stage); where.push(`COALESCE(f.stage, 'frio') = $${params.length}`); }
    if (f.city) { params.push(String(f.city).trim()); where.push(`LOWER(TRIM(l.city)) = LOWER($${params.length})`); }
    if (f.presentacion === 'sin') where.push(`NOT ${PRESENTACION_EXISTS}`);
    else if (f.presentacion === 'con') where.push(PRESENTACION_EXISTS);
    if (f.celular) where.push('l.phone IS NOT NULL');

    const whereSql = where.join(' AND ');
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
    const { rows: [count] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM crm_leads l LEFT JOIN crm_followups f ON f.lead_id = l.id WHERE ${whereSql}`, params);
    const { rows } = await pool.query(
        `SELECT * FROM (${LEAD_SELECT} WHERE ${whereSql}) l
         ORDER BY ${SORTS[f.sort] || SORTS.accion}
         LIMIT ${limit} OFFSET ${offset}`, params);
    return { rows, total: count.total, limit, offset };
}

/** Contadores: por estado de origen, por etapa y ciudades. */
async function leadsSummary() {
    await ensureSchema();
    const { rows: byStatus } = await pool.query(
        `SELECT COALESCE(source_status, 'sin_estado') AS status, COUNT(*)::int AS n
         FROM crm_leads WHERE odoo_partner_id IS NULL GROUP BY 1`);
    const { rows: byStage } = await pool.query(
        `SELECT COALESCE(f.stage, 'frio') AS stage, COUNT(*)::int AS n
         FROM crm_leads l LEFT JOIN crm_followups f ON f.lead_id = l.id
         WHERE l.odoo_partner_id IS NULL GROUP BY 1`);
    const { rows: cities } = await pool.query(
        `SELECT MIN(TRIM(city)) AS city, COUNT(*)::int AS n FROM crm_leads
         WHERE odoo_partner_id IS NULL AND NULLIF(TRIM(city), '') IS NOT NULL
         GROUP BY LOWER(TRIM(city)) ORDER BY n DESC, city ASC`);
    const { rows: [conv] } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM crm_leads WHERE odoo_partner_id IS NOT NULL');
    const { rows: [pres] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE ${PRESENTACION_EXISTS})::int AS con,
                COUNT(*) FILTER (WHERE NOT ${PRESENTACION_EXISTS})::int AS sin
         FROM crm_leads l WHERE l.odoo_partner_id IS NULL`);
    return {
        presentacion: { con: pres.con, sin: pres.sin },
        total: byStatus.reduce((s, r) => s + r.n, 0),
        status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        stages: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
        cities,
        convertidos: conv.n,
    };
}

async function getLead(id) {
    await ensureSchema();
    const { rows: [row] } = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [parseInt(id, 10)]);
    return row || null;
}

module.exports = {
    readOdooPhones,
    importGoogleContacts,
    createLead,
    listLeads,
    leadsSummary,
    getLead,
};
