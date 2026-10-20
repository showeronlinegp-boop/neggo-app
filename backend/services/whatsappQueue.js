// Cola persistente de publicaciones. El estado vive en Postgres:
// un reinicio retoma pendiente / enviado / error sin repetir lo ya enviado.

const fs = require('fs');
const path = require('path');
const { findPublishable } = require('./whatsappProducts');
const { assertSendable } = require('./whatsappMessage');

const ART = 'America/Argentina/Buenos_Aires';
const LOCK_KEY = 842190;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'sql', 'whatsapp.sql'), 'utf8');

function clampInterval(value, fallback = 90) {
    const n = Number(value);
    if (!Number.isInteger(n)) return fallback;
    if (n < 10 || n > 3600) {
        throw new Error('El intervalo tiene que estar entre 10 y 3600 segundos');
    }
    return n;
}

// Para que no salgan con una separación exacta, cada espera varía ±35 % del intervalo,
// en segundos sueltos. El promedio queda en el intervalo elegido. Nunca menos de 10 s.
const JITTER = 0.35;

function jitterGaps(count, interval, random = Math.random) {
    const gaps = [];
    for (let i = 0; i < count; i++) {
        const factor = 1 - JITTER + 2 * JITTER * random();
        gaps.push(Math.max(10, Math.round(interval * factor)));
    }
    return gaps;
}

function clampAttempts(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return 3;
    return Math.min(n, 5);
}

function assertGroupJid(jid) {
    const value = String(jid || '').trim();
    if (!/^[\d-]+@g\.us$/.test(value)) {
        throw new Error('Elegí un grupo de la instancia (JID terminado en @g.us)');
    }
    return value;
}

function assertSchedule(input) {
    const value = String(input || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
        throw new Error('La fecha tiene que ser AAAA-MM-DDTHH:mm, hora de Argentina');
    }
    return value.replace('T', ' ') + ':00';
}

async function ensureSchema(pool) {
    await pool.query(SCHEMA_SQL);
}

async function logEvent(pool, { batchId, messageId = null, level = 'info', message }) {
    await pool.query(
        `INSERT INTO whatsapp_logs (batch_id, message_id, level, message)
         VALUES ($1, $2, $3, $4)`,
        [batchId, messageId, level, String(message).slice(0, 2000)]
    );
}

async function getSettings(pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query('SELECT * FROM whatsapp_settings WHERE id = 1');
    return rows[0];
}

async function saveSettings(pool, { groupJid, groupSubject, intervalSeconds }) {
    const jid = groupJid == null || groupJid === '' ? null : assertGroupJid(groupJid);
    const interval = intervalSeconds == null ? null : clampInterval(intervalSeconds);
    const { rows } = await pool.query(`
        UPDATE whatsapp_settings
        SET group_jid = COALESCE($1, group_jid),
            group_subject = COALESCE($2, group_subject),
            interval_seconds = COALESCE($3, interval_seconds),
            updated_at = NOW()
        WHERE id = 1
        RETURNING *
    `, [jid, groupSubject || null, interval]);
    return rows[0];
}

// input.products: productos ya elegidos (sorteo). Si no viene, se buscan con los filtros.
// input.sendNow: arranca ya, sin fecha. input.offsetSeconds: corre la hora de inicio
// para encadenar varias tandas sin que se pisen.
async function createBatch(pool, input) {
    const products = input.products || await findPublishable(pool, {
        company: input.company,
        category: input.category || null,
        destCategory: input.destCategory || null,
        pricelistId: input.pricelistId || null,
    });
    if (products.length === 0) {
        throw new Error('No hay productos con foto y precio de catálogo para ese filtro');
    }
    const empty = products.find((p) => !/[\p{L}\p{N}]/u.test(String(p.caption || '')) || !p.template_id);
    if (empty) {
        throw new Error(`"${empty.name || empty.odoo_id}" no tiene texto o foto: no se puede programar`);
    }
    const groupJid = assertGroupJid(input.groupJid);
    const interval = clampInterval(input.intervalSeconds, 90);
    const schedule = input.sendNow ? null : assertSchedule(input.scheduledAt);
    const offset = Math.max(0, Math.floor(Number(input.offsetSeconds) || 0));
    const maxAttempts = clampAttempts(input.maxAttempts);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const batchRes = await client.query(`
            INSERT INTO whatsapp_batches (
                company, category, dest_category, pricelist_id,
                group_jid, group_subject, interval_seconds, scheduled_at, created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                COALESCE($8::timestamp AT TIME ZONE '${ART}', NOW())
                    + ($10::int * INTERVAL '1 second'),
                $9
            )
            RETURNING *
        `, [
            input.company,
            input.category || null,
            input.destCategory || null,
            input.pricelistId || null,
            groupJid,
            input.groupSubject || null,
            interval,
            schedule,
            input.createdBy || null,
            offset,
        ]);
        const batch = batchRes.rows[0];
        // gaps[i] es la espera antes del mensaje i; la última sobra y separa la tanda siguiente.
        const gaps = jitterGaps(products.length + 1, interval, input.random);
        let offsetSeconds = 0;
        for (let i = 0; i < products.length; i++) {
            const p = products[i];
            if (i > 0) offsetSeconds += gaps[i];
            await client.query(`
                INSERT INTO whatsapp_messages (
                    batch_id, position, odoo_id, company, product_name,
                    price_amount, price_label, caption, image_template_id,
                    group_jid, max_attempts, gap_seconds, scheduled_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13::timestamptz + $14::int * INTERVAL '1 second'
                )
            `, [
                batch.id, i, p.odoo_id, p.company, p.name,
                p.price_amount, p.price_label, p.caption, p.template_id,
                groupJid, maxAttempts, gaps[i], batch.scheduled_at, offsetSeconds,
            ]);
        }
        const durationSeconds = offsetSeconds + gaps[products.length];
        await logEvent(client, {
            batchId: batch.id,
            message: `Tanda creada con ${products.length} productos. Un mensaje cada ${interval} s en promedio, con variación.`,
        });
        await client.query('COMMIT');
        return { batch, total: products.length, durationSeconds, sample: products.slice(0, 8) };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

const BATCH_COUNTS = `
    b.*,
    COUNT(m.id)::int AS total,
    COUNT(m.id) FILTER (WHERE m.status = 'enviado')::int AS enviados,
    COUNT(m.id) FILTER (WHERE m.status = 'error')::int AS errores,
    COUNT(m.id) FILTER (WHERE m.status = 'pendiente')::int AS pendientes,
    COUNT(m.id) FILTER (WHERE m.status = 'enviando')::int AS enviando
`;

async function listBatches(pool) {
    const { rows } = await pool.query(`
        SELECT ${BATCH_COUNTS}
        FROM whatsapp_batches b
        LEFT JOIN whatsapp_messages m ON m.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 30
    `);
    return rows;
}

async function getBatch(pool, id) {
    const { rows } = await pool.query(`
        SELECT ${BATCH_COUNTS}
        FROM whatsapp_batches b
        LEFT JOIN whatsapp_messages m ON m.batch_id = b.id
        WHERE b.id = $1
        GROUP BY b.id
    `, [id]);
    if (!rows.length) return null;
    const messages = await pool.query(`
        SELECT id, position, product_name, price_label, status, attempts, last_error, sent_at
        FROM whatsapp_messages
        WHERE batch_id = $1
        ORDER BY position
        LIMIT 200
    `, [id]);
    const logs = await pool.query(`
        SELECT id, level, message, created_at
        FROM whatsapp_logs
        WHERE batch_id = $1
        ORDER BY id DESC
        LIMIT 40
    `, [id]);
    return { ...rows[0], messages: messages.rows, logs: logs.rows };
}

// Hora en que va a salir de verdad cada mensaje, con la misma regla que claimNext:
// de a uno y nunca antes de que pase el intervalo desde el último intento.
// Si la cola viene atrasada, la hora programada ya pasó pero no salen todos juntos.
function estimateDepartures(messages, lastAttemptAt, now) {
    let prev = lastAttemptAt ? new Date(lastAttemptAt).getTime() : null;
    return messages.map((m) => {
        if (m.batch_status === 'pausada' || m.status === 'enviando') return { ...m, eta: null };
        const afterPrev = prev == null ? 0 : prev + (m.gap_seconds ?? m.interval_seconds) * 1000;
        const eta = Math.max(new Date(m.scheduled_at).getTime(), afterPrev, now.getTime());
        prev = eta;
        return { ...m, eta: new Date(eta).toISOString() };
    });
}

// Mensajes que todavía no salieron, en el orden en que van a salir.
async function listQueue(pool, now = new Date()) {
    const { rows } = await pool.query(`
        SELECT m.id, m.batch_id, m.position, m.odoo_id, m.company, m.product_name,
               m.price_label, m.image_template_id, m.status, m.attempts, m.last_error,
               m.scheduled_at, m.gap_seconds, b.status AS batch_status, b.category, b.interval_seconds,
               COALESCE(b.group_subject, b.group_jid) AS group_name
        FROM whatsapp_messages m
        JOIN whatsapp_batches b ON b.id = m.batch_id
        WHERE m.status IN ('pendiente', 'enviando')
          AND b.status IN ('programada', 'en_curso', 'pausada')
        ORDER BY (b.status = 'pausada'), m.scheduled_at, m.position
        LIMIT 300
    `);
    const last = await pool.query(
        'SELECT MAX(updated_at) AS at FROM whatsapp_messages WHERE attempts > 0'
    );
    return estimateDepartures(rows, last.rows[0].at, now);
}

async function setBatchStatus(pool, id, from, to, logMessage) {
    const { rows } = await pool.query(`
        UPDATE whatsapp_batches
        SET status = $3, updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING *
    `, [id, from, to]);
    if (!rows.length) {
        throw new Error('La tanda no está en un estado que permita esa acción');
    }
    await logEvent(pool, { batchId: id, message: logMessage });
    return rows[0];
}

function pauseBatch(pool, id) {
    return setBatchStatus(pool, id, ['programada', 'en_curso'], 'pausada', 'Tanda pausada');
}

async function resumeBatch(pool, id) {
    const { rows } = await pool.query('SELECT * FROM whatsapp_batches WHERE id = $1', [id]);
    if (!rows.length || rows[0].status !== 'pausada') {
        throw new Error('La tanda no está en un estado que permita esa acción');
    }
    // Si todavía no llegó la hora, vuelve a programada.
    const status = new Date(rows[0].scheduled_at).getTime() > Date.now() ? 'programada' : 'en_curso';
    return setBatchStatus(pool, id, ['pausada'], status, 'Tanda reanudada');
}

function cancelBatch(pool, id) {
    return setBatchStatus(
        pool, id,
        ['programada', 'en_curso', 'pausada'],
        'cancelada',
        'Tanda cancelada. Lo ya enviado no se borra.'
    );
}

async function recoverStuck(pool, now) {
    const { rows } = await pool.query(`
        UPDATE whatsapp_messages
        SET status = CASE WHEN attempts >= max_attempts THEN 'error' ELSE 'pendiente' END,
            last_error = COALESCE(last_error, 'Reintento tras reinicio'),
            updated_at = $1
        WHERE status = 'enviando'
          AND updated_at < $1::timestamptz - INTERVAL '2 minutes'
        RETURNING id, batch_id, status
    `, [now]);
    for (const row of rows) {
        await logEvent(pool, {
            batchId: row.batch_id,
            messageId: row.id,
            level: row.status === 'error' ? 'error' : 'warn',
            message: row.status === 'error'
                ? 'Envío interrumpido y sin reintentos'
                : 'Envío interrumpido: vuelve a pendiente',
        });
    }
    return rows.length;
}

async function claimNext(pool, now) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE whatsapp_batches
            SET status = 'en_curso', updated_at = $1
            WHERE status = 'programada' AND scheduled_at <= $1
        `, [now]);
        const { rows } = await client.query(`
            SELECT m.id
            FROM whatsapp_messages m
            JOIN whatsapp_batches b ON b.id = m.batch_id
            WHERE m.status = 'pendiente'
              AND m.attempts < m.max_attempts
              AND m.scheduled_at <= $1
              AND b.status = 'en_curso'
              AND NOT EXISTS (
                  SELECT 1 FROM whatsapp_messages inflight
                  WHERE inflight.status = 'enviando'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM whatsapp_messages recent
                  WHERE recent.id <> m.id
                    AND recent.attempts > 0
                    AND recent.updated_at > $1::timestamptz
                        - (COALESCE(m.gap_seconds, b.interval_seconds) * INTERVAL '1 second')
              )
            ORDER BY m.scheduled_at, m.position
            LIMIT 1
            FOR UPDATE OF m SKIP LOCKED
        `, [now]);
        if (!rows.length) {
            await client.query('COMMIT');
            return null;
        }
        const upd = await client.query(`
            UPDATE whatsapp_messages m
            SET status = 'enviando', attempts = attempts + 1, updated_at = $2
            FROM whatsapp_batches b
            WHERE m.id = $1 AND m.status = 'pendiente' AND b.id = m.batch_id
            RETURNING m.*, b.group_jid AS batch_group_jid, b.interval_seconds
        `, [rows[0].id, now]);
        await client.query('COMMIT');
        return upd.rows[0] || null;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function finishBatchIfDone(pool, batchId, now) {
    await pool.query(`
        UPDATE whatsapp_batches b
        SET status = 'completada', updated_at = $2
        WHERE b.id = $1
          AND b.status = 'en_curso'
          AND NOT EXISTS (
              SELECT 1 FROM whatsapp_messages m
              WHERE m.batch_id = b.id AND m.status IN ('pendiente', 'enviando')
          )
    `, [batchId, now]);
}

async function markSent(pool, message, evolutionId, now) {
    await pool.query(`
        UPDATE whatsapp_messages
        SET status = 'enviado', sent_at = $2, evolution_message_id = $3,
            last_error = NULL, updated_at = $2
        WHERE id = $1
    `, [message.id, now, evolutionId]);
    await logEvent(pool, {
        batchId: message.batch_id,
        messageId: message.id,
        message: `Enviado ${message.product_name} ${message.price_label}`,
    });
    await finishBatchIfDone(pool, message.batch_id, now);
}

async function markFailed(pool, message, errorText, now) {
    const { rows } = await pool.query(`
        UPDATE whatsapp_messages m
        SET status = CASE WHEN m.attempts >= m.max_attempts THEN 'error' ELSE 'pendiente' END,
            last_error = $3,
            scheduled_at = CASE
                WHEN m.attempts >= m.max_attempts THEN m.scheduled_at
                ELSE $2::timestamptz + (COALESCE(m.gap_seconds, b.interval_seconds) * INTERVAL '1 second')
            END,
            updated_at = $2
        FROM whatsapp_batches b
        WHERE m.id = $1 AND b.id = m.batch_id
        RETURNING m.status, m.attempts, m.max_attempts
    `, [message.id, now, String(errorText).slice(0, 500)]);
    const row = rows[0];
    await logEvent(pool, {
        batchId: message.batch_id,
        messageId: message.id,
        level: 'error',
        message: row?.status === 'error'
            ? `Error definitivo (intento ${row.attempts}/${row.max_attempts}): ${errorText}`
            : `Error, reintento ${row?.attempts}/${row?.max_attempts}: ${errorText}`,
    });
    await finishBatchIfDone(pool, message.batch_id, now);
    return row;
}

async function tick(pool, deps, now = new Date()) {
    const lock = await pool.connect();
    let locked = false;
    try {
        const { rows } = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
        locked = rows[0].ok === true;
        if (!locked) return { action: 'ocupado' };
        await recoverStuck(pool, now);
        const message = await claimNext(pool, now);
        if (!message) return { action: 'idle' };
        try {
            const media = await deps.loadImage(message);
            // Nunca sale un mensaje sin texto o sin foto.
            const ready = assertSendable({ caption: message.caption, base64: media?.base64 });
            const evolutionId = await deps.sendImage({
                number: message.group_jid,
                caption: ready.caption,
                base64: ready.base64,
                mimetype: ready.mimetype,
                fileName: `producto-${message.odoo_id}.${ready.mimetype.split('/')[1]}`,
            });
            await markSent(pool, message, evolutionId, now);
            return { action: 'enviado', id: message.id };
        } catch (err) {
            await markFailed(pool, message, err.message || 'Error al enviar', now);
            return { action: 'error', id: message.id, error: err.message };
        }
    } finally {
        if (locked) {
            await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        }
        lock.release();
    }
}

module.exports = {
    ensureSchema,
    getSettings,
    saveSettings,
    createBatch,
    listBatches,
    listQueue,
    estimateDepartures,
    jitterGaps,
    getBatch,
    pauseBatch,
    resumeBatch,
    cancelBatch,
    recoverStuck,
    claimNext,
    tick,
    clampInterval,
    assertGroupJid,
    assertSchedule,
};
