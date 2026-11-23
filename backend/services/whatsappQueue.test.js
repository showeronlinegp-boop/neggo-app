// Precio de catálogo, formato es-AR y cola persistente. Sin red ni Evolution.
// node backend/services/whatsappQueue.test.js

const assert = require('assert');
const { Client, Pool } = require('pg');
const { formatMoneyAR, catalogSalePrice, buildCaption } = require('./whatsappPrice');
const { calculatePrices } = require('./rulesEngine');
const { extractQr, normalizeGroups, instanceName, statusDataUri } = require('./evolutionClient');
const products = require('./whatsappProducts');
const queue = require('./whatsappQueue');

function priceRow(overrides = {}) {
    return {
        has_image: true,
        template_id: 99,
        raw_price: 1000,
        rule_id: 1,
        ignored: false,
        default_discount: 0,
        markup_neggo: 20,
        markup_preventas: 50,
        discount_override: null,
        markup_neggo_override: null,
        markup_preventas_override: null,
        ...overrides,
    };
}

function testPrice() {
    assert.strictEqual(formatMoneyAR(1523), '$1.523');
    assert.strictEqual(formatMoneyAR(1015000), '$1.015.000');
    assert.strictEqual(formatMoneyAR(0), '$0');
    assert.strictEqual(formatMoneyAR(null), null);

    const expected = calculatePrices(
        { raw_price: 1000 },
        { default_discount: 0, markup_neggo: 20, markup_preventas: 50 },
        {},
        'preventas'
    ).sale_price;
    assert.strictEqual(expected, 1523);
    const priced = catalogSalePrice(priceRow(), 'preventas');
    assert.deepStrictEqual(priced, { amount: 1523, label: '$1.523' });
    assert.strictEqual(catalogSalePrice(priceRow(), 'neggo').label, '$1.218');
    // Fuente Neggo: sin flete encima del costo de Neggo (nota 129)
    assert.strictEqual(catalogSalePrice(priceRow({ source: 'neggo' }), 'preventas').amount, 1500);
    assert.strictEqual(catalogSalePrice(priceRow({ list_price: 99999 }), 'preventas').amount, 1523);
    assert.strictEqual(catalogSalePrice(priceRow({ has_image: false }), 'preventas'), null);
    assert.strictEqual(catalogSalePrice(priceRow({ template_id: null }), 'preventas'), null);
    assert.strictEqual(catalogSalePrice(priceRow({ raw_price: null }), 'preventas'), null);
    assert.strictEqual(catalogSalePrice(priceRow({ raw_price: 0 }), 'preventas'), null);
    assert.strictEqual(catalogSalePrice(priceRow({ rule_id: null }), 'preventas'), null);
    assert.strictEqual(catalogSalePrice(priceRow({ ignored: true }), 'preventas'), null);
    assert.strictEqual(buildCaption('Vaso largo', '$1.523'), 'Vaso largo\n$1.523');
    console.log('precio ok');
}

function testEvolutionParse() {
    const qr = extractQr({ base64: 'data:image/png;base64,aaa', pairingCode: 'ABCD' });
    assert.strictEqual(qr.base64, 'data:image/png;base64,aaa');
    assert.strictEqual(qr.pairingCode, 'ABCD');
    const groups = normalizeGroups([
        { id: '120363001@g.us', subject: 'Ofertas', size: 12 },
        { id: '549111@s.whatsapp.net', subject: 'Privado' },
    ]);
    assert.deepStrictEqual(groups, [{ jid: '120363001@g.us', subject: 'Ofertas', size: 12 }]);
    const prevGroup = process.env.EVOLUTION_INSTANCE;
    const prevStatus = process.env.EVOLUTION_STATUS_INSTANCE;
    process.env.EVOLUTION_INSTANCE = 'neggo';
    process.env.EVOLUTION_STATUS_INSTANCE = 'neggo-estados';
    assert.strictEqual(instanceName('grupo'), 'neggo');
    assert.strictEqual(instanceName('estado'), 'neggo-estados');
    // Evolution toma content como URL: el base64 tiene que ir como data URI
    assert.strictEqual(statusDataUri('AAAA', 'image/png'), 'data:image/png;base64,AAAA');
    assert.strictEqual(statusDataUri('AAAA'), 'data:image/jpeg;base64,AAAA');
    assert.strictEqual(statusDataUri('data:image/webp;base64,BBBB', 'image/png'), 'data:image/webp;base64,BBBB');
    process.env.EVOLUTION_STATUS_INSTANCE = 'neggo';
    assert.throws(() => instanceName('estado'), /distinta/);
    if (prevGroup == null) delete process.env.EVOLUTION_INSTANCE;
    else process.env.EVOLUTION_INSTANCE = prevGroup;
    if (prevStatus == null) delete process.env.EVOLUTION_STATUS_INSTANCE;
    else process.env.EVOLUTION_STATUS_INSTANCE = prevStatus;
    console.log('evolution parse ok');
}

function testPgAdmin() {
    if (process.env.WA_TEST_PGHOST) {
        return {
            host: process.env.WA_TEST_PGHOST,
            port: Number(process.env.WA_TEST_PGPORT || 5432),
            user: process.env.WA_TEST_PGUSER || 'neggo',
            password: process.env.WA_TEST_PGPASSWORD || process.env.POSTGRES_PASSWORD || 'neggo_pass',
            database: 'postgres',
        };
    }
    return { host: '/var/run/postgresql', database: 'postgres' };
}

function testPgPool() {
    if (process.env.WA_TEST_PGHOST) {
        return {
            host: process.env.WA_TEST_PGHOST,
            port: Number(process.env.WA_TEST_PGPORT || 5432),
            user: process.env.WA_TEST_PGUSER || 'neggo',
            password: process.env.WA_TEST_PGPASSWORD || process.env.POSTGRES_PASSWORD || 'neggo_pass',
            database: 'neggo_wa_test',
        };
    }
    return { connectionString: 'postgresql://ubuntu@/neggo_wa_test?host=/var/run/postgresql' };
}

async function recreateDb() {
    const admin = new Client(testPgAdmin());
    await admin.connect();
    await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = 'neggo_wa_test' AND pid <> pg_backend_pid()
    `);
    await admin.query('DROP DATABASE IF EXISTS neggo_wa_test');
    await admin.query('CREATE DATABASE neggo_wa_test');
    await admin.end();
    const pool = new Pool(testPgPool());
    await pool.query(`
        CREATE TABLE users (id SERIAL PRIMARY KEY);
        CREATE TABLE client_pricelists (
            id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, active BOOLEAN DEFAULT true
        );
        CREATE TABLE suppliers (
            id SERIAL PRIMARY KEY, name VARCHAR(200), active BOOLEAN DEFAULT true,
            default_discount NUMERIC,
            markup_neggo NUMERIC, markup_preventas NUMERIC
        );
        CREATE TABLE supplier_products (
            id SERIAL PRIMARY KEY, supplier_id INTEGER, name VARCHAR(500),
            raw_price NUMERIC, source_category VARCHAR(200),
            available BOOLEAN NOT NULL DEFAULT true, source VARCHAR(40)
        );
        CREATE TABLE supplier_category_rules (
            id SERIAL PRIMARY KEY, supplier_id INTEGER, source_category VARCHAR(200),
            active BOOLEAN DEFAULT true, ignored BOOLEAN DEFAULT false,
            discount_override NUMERIC,
            markup_neggo_override NUMERIC, markup_preventas_override NUMERIC,
            dest_category_neggo VARCHAR(200), dest_category_preventas VARCHAR(200)
        );
        CREATE TABLE product_mappings (
            id SERIAL PRIMARY KEY, supplier_product_id INTEGER, odoo_product_id INTEGER,
            odoo_company VARCHAR(20), active BOOLEAN DEFAULT true, match_confidence NUMERIC,
            es_habitual BOOLEAN DEFAULT true
        );
        CREATE TABLE odoo_products_cache (
            id SERIAL PRIMARY KEY, odoo_id INTEGER, company VARCHAR(20), name VARCHAR(500),
            categ_name VARCHAR(200), template_id INTEGER, has_image BOOLEAN DEFAULT false,
            active BOOLEAN DEFAULT true, locally_archived BOOLEAN DEFAULT false, list_price NUMERIC
        );
        CREATE TABLE client_pricelist_rules (
            id SERIAL PRIMARY KEY, pricelist_id INTEGER, supplier_id INTEGER, active BOOLEAN DEFAULT true
        );
    `);
    await queue.ensureSchema(pool);
    return pool;
}

async function seed(pool) {
    const sup = await pool.query(`
        INSERT INTO suppliers (name, default_discount, markup_neggo, markup_preventas)
        VALUES ('Cast', 0, 20, 50) RETURNING id
    `);
    const other = await pool.query(`
        INSERT INTO suppliers (name, default_discount, markup_neggo, markup_preventas)
        VALUES ('Otro', 0, 10, 10) RETURNING id
    `);
    const sid = sup.rows[0].id;
    const sp = await pool.query(`
        INSERT INTO supplier_products (supplier_id, name, raw_price, source_category, available) VALUES
            ($1, 'Vaso', 1000, 'Bazar', true),
            ($1, 'Plato', 2000, 'Bazar', true),
            ($1, 'Sin foto raw', 500, 'Bazar', true),
            ($1, 'Ignorado', 800, 'Oculto', true),
            ($1, 'Sin precio', NULL, 'Bazar', true),
            ($1, 'Agotado', 1500, 'Bazar', false)
        RETURNING id
    `, [sid]);
    const [vaso, plato, sinFoto, ignorado, sinPrecio, agotado] = sp.rows.map((r) => r.id);
    await pool.query(`
        INSERT INTO supplier_category_rules
            (supplier_id, source_category, dest_category_neggo, dest_category_preventas, ignored)
        VALUES
            ($1, 'Bazar', 'Bazar', 'Bazar', false),
            ($1, 'Oculto', 'Oculto', 'Oculto', true)
    `, [sid]);
    await pool.query(`
        INSERT INTO odoo_products_cache
            (odoo_id, company, name, categ_name, template_id, has_image, list_price)
        VALUES
            (10, 'preventas', 'Vaso largo', 'Bazar', 501, true, 99999),
            (11, 'preventas', 'Plato hondo', 'Bazar', 502, true, 1),
            (12, 'preventas', 'Sin foto', 'Bazar', 503, false, 500),
            (13, 'preventas', 'Sin vinculo', 'Bazar', 504, true, 500),
            (14, 'preventas', 'Regla ignorada', 'Oculto', 505, true, 800),
            (15, 'preventas', 'Sin precio odoo', 'Bazar', 506, true, 999),
            (16, 'preventas', 'Agotado en proveedor', 'Bazar', 507, true, 1500)
    `);
    await pool.query(`
        INSERT INTO product_mappings (supplier_product_id, odoo_product_id, odoo_company, match_confidence)
        VALUES
            ($1, 10, 'preventas', 1),
            ($2, 11, 'preventas', 1),
            ($3, 12, 'preventas', 1),
            ($4, 14, 'preventas', 1),
            ($5, 15, 'preventas', 1),
            ($6, 16, 'preventas', 1)
    `, [vaso, plato, sinFoto, ignorado, sinPrecio, agotado]);
    const list = await pool.query(`INSERT INTO client_pricelists (name) VALUES ('Mayorista') RETURNING id`);
    await pool.query(
        `INSERT INTO client_pricelist_rules (pricelist_id, supplier_id) VALUES ($1, $2)`,
        [list.rows[0].id, other.rows[0].id]
    );
    return { pricelistId: list.rows[0].id };
}

async function testSelection(pool, ids) {
    const all = await products.findPublishable(pool, { company: 'preventas' });
    assert.deepStrictEqual(all.map((p) => p.odoo_id), [11, 10]);
    assert.ok(!all.some((p) => p.odoo_id === 16));
    assert.deepStrictEqual(all.map((p) => p.price_label), ['$3.045', '$1.523']);
    assert.ok(all.every((p) => !String(p.price_label).includes('99999')));
    const none = await products.findPublishable(pool, { company: 'preventas', category: 'Inexistente' });
    assert.strictEqual(none.length, 0);
    const dest = await products.findPublishable(pool, { company: 'preventas', destCategory: 'Bazar' });
    assert.strictEqual(dest.length, 2);
    const filtered = await products.findPublishable(pool, { company: 'preventas', pricelistId: ids.pricelistId });
    assert.strictEqual(filtered.length, 0);
    console.log('seleccion ok');
}

// Cabecera JPEG + relleno: pasa la validación de foto sin depender de Odoo.
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400)]).toString('base64');

function senderOk() {
    return { loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }), sendImage: async () => 'evo-1' };
}

function senderFail() {
    return { loadImage: async () => ({ base64: FAKE_JPEG }), sendImage: async () => { throw new Error('grupo cerrado'); } };
}

async function stateOf(pool, batchId) {
    const { rows } = await pool.query(
        `SELECT position, status, attempts FROM whatsapp_messages WHERE batch_id = $1 ORDER BY position`,
        [batchId]
    );
    return rows;
}

async function plannedOf(pool, batchId) {
    const { rows } = await pool.query(
        `SELECT id, position, status, scheduled_at, deadline_at FROM whatsapp_messages WHERE batch_id = $1 ORDER BY position`,
        [batchId]
    );
    return rows;
}

// Hora de Argentina (UTC-3) para los tests: '2020-01-01T09:00' → Date
const arT = (s) => new Date(`${s}:00-03:00`);

async function testQueue(pool) {
    // 2020-01-01 es miércoles. Dos productos desde las 9: se reparten hasta las 18.
    const created = await queue.createBatch(pool, {
        company: 'preventas',
        groupJid: '120363001@g.us',
        groupSubject: 'Ofertas',
        intervalSeconds: 90,
        scheduledAt: '2020-01-01T09:00',
        now: arT('2020-01-01T09:00'),
        maxAttempts: 3,
    });
    assert.strictEqual(created.total, 2);
    assert.strictEqual(created.plan.programados, 2);
    assert.strictEqual(created.plan.omitidos, 0);
    let plan = await plannedOf(pool, created.batch.id);
    const m0 = new Date(plan[0].scheduled_at);
    assert.ok(m0 >= arT('2020-01-01T09:00') && m0 < arT('2020-01-01T13:30'), m0.toISOString());
    assert.ok(new Date(plan[1].scheduled_at) > arT('2020-01-01T13:30'));
    assert.ok(new Date(plan[1].scheduled_at) <= arT('2020-01-01T18:00'));
    assert.strictEqual(new Date(plan[0].deadline_at).toISOString(), arT('2020-01-01T18:00').toISOString());

    assert.strictEqual((await queue.tick(pool, senderOk(), new Date(m0.getTime() - 1000))).action, 'idle');
    const first = await queue.tick(pool, senderOk(), m0);
    assert.strictEqual(first.action, 'enviado');
    await queue.pauseBatch(pool, created.batch.id);
    const m1 = new Date(plan[1].scheduled_at);
    assert.strictEqual((await queue.tick(pool, senderOk(), m1)).action, 'idle');
    await queue.resumeBatch(pool, created.batch.id, m1);
    plan = await plannedOf(pool, created.batch.id);
    const m1b = new Date(plan[1].scheduled_at);
    const second = await queue.tick(pool, senderOk(), m1b);
    assert.strictEqual(second.action, 'enviado');
    const done = await queue.getBatch(pool, created.batch.id);
    assert.strictEqual(done.status, 'completada');
    assert.strictEqual(done.enviados, 2);

    // Reintentos: el reintento sale a los 90 s del intento anterior
    const retry = await queue.createBatch(pool, {
        company: 'preventas',
        category: 'Bazar',
        destCategory: 'Bazar',
        groupJid: '120363001@g.us',
        intervalSeconds: 90,
        scheduledAt: '2020-01-02T09:00',
        now: arT('2020-01-02T09:00'),
        maxAttempts: 3,
    });
    await pool.query('DELETE FROM whatsapp_messages WHERE batch_id = $1 AND position > 0', [retry.batch.id]);
    let t = new Date((await plannedOf(pool, retry.batch.id))[0].scheduled_at);
    for (let i = 0; i < 3; i++) {
        const r = await queue.tick(pool, senderFail(), t);
        assert.strictEqual(r.action, 'error');
        t = new Date(t.getTime() + 91_000);
    }
    const after = await stateOf(pool, retry.batch.id);
    assert.ok(after.every((m) => m.status === 'error'));
    assert.ok(after.every((m) => m.attempts === 3));
    const stopped = await queue.tick(pool, senderFail(), t);
    assert.strictEqual(stopped.action, 'idle');

    const cancel = await queue.createBatch(pool, {
        company: 'preventas',
        groupJid: '120363001@g.us',
        intervalSeconds: 90,
        scheduledAt: '2020-01-03T09:00',
        now: arT('2020-01-03T09:00'),
        maxAttempts: 3,
    });
    const c0 = new Date((await plannedOf(pool, cancel.batch.id))[0].scheduled_at);
    assert.strictEqual((await queue.tick(pool, senderOk(), c0)).action, 'enviado');
    await queue.cancelBatch(pool, cancel.batch.id);
    assert.strictEqual((await queue.tick(pool, senderOk(), arT('2020-01-03T17:59'))).action, 'idle');
    const left = await stateOf(pool, cancel.batch.id);
    assert.strictEqual(left[0].status, 'enviado');
    assert.strictEqual(left[1].status, 'pendiente');

    await pool.query(`
        UPDATE whatsapp_messages
        SET status = 'enviando', attempts = 1, updated_at = $2, scheduled_at = $2
        WHERE batch_id = $1 AND position = 1
    `, [cancel.batch.id, new Date(c0.getTime() - 3 * 60_000)]);
    await pool.query(`UPDATE whatsapp_batches SET status = 'en_curso' WHERE id = $1`, [cancel.batch.id]);
    const recovered = await queue.tick(pool, senderOk(), new Date(c0.getTime() + 180_000));
    assert.strictEqual(recovered.action, 'enviado');
    const finalRows = await stateOf(pool, cancel.batch.id);
    assert.strictEqual(finalRows[1].status, 'enviado');
    assert.strictEqual(finalRows[1].attempts, 2);

    await testReparto(pool);

    const statusBatch = await queue.createBatch(pool, {
        company: 'preventas',
        destino: 'estado',
        intervalSeconds: 90,
        scheduledAt: '2020-01-04T00:00',
        maxAttempts: 3,
    });
    assert.strictEqual(statusBatch.batch.destino, 'estado');
    assert.strictEqual(statusBatch.batch.group_jid, queue.STATUS_JID);
    const posted = [];
    const statusTick = await queue.tick(pool, {
        loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }),
        sendImage: async () => { throw new Error('un estado no se manda al grupo'); },
        sendStatus: async (payload) => { posted.push(payload); return 'status-1'; },
    }, new Date('2020-01-04T03:00:00.000Z'));
    assert.strictEqual(statusTick.action, 'enviado');
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].caption, /Plato hondo/);
    assert.match(posted[0].caption, /\$3\.045/);
    await assert.rejects(
        () => queue.createBatch(pool, {
            company: 'preventas',
            destino: 'grupo',
            intervalSeconds: 90,
            scheduledAt: '2020-01-05T00:00',
        }),
        /JID/
    );

    await pool.query(`
        UPDATE whatsapp_batches SET status = 'cancelada'
        WHERE destino = 'estado' AND status IN ('programada', 'en_curso', 'pausada')
    `);
    const oneStatus = {
        odoo_id: 11,
        company: 'preventas',
        name: 'Plato hondo',
        price_amount: 3045,
        price_label: '$3.045',
        caption: 'Plato hondo\n$3.045',
        template_id: 502,
    };
    const timeoutStatus = await queue.createBatch(pool, {
        company: 'preventas',
        destino: 'estado',
        products: [oneStatus],
        intervalSeconds: 90,
        scheduledAt: '2020-01-06T00:00',
        maxAttempts: 3,
    });
    let statusTimeoutCalls = 0;
    const tTimeout = new Date('2020-01-06T03:00:00.000Z');
    const timeoutTick = await queue.tick(pool, {
        loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }),
        sendImage: async () => { throw new Error('un estado no se manda al grupo'); },
        sendStatus: async () => {
            statusTimeoutCalls += 1;
            throw new Error('Evolution API no responde (The operation was aborted due to timeout)');
        },
    }, tTimeout);
    assert.strictEqual(timeoutTick.action, 'error');
    assert.strictEqual(statusTimeoutCalls, 1);
    const afterTimeout = await stateOf(pool, timeoutStatus.batch.id);
    assert.strictEqual(afterTimeout.length, 1);
    assert.strictEqual(afterTimeout[0].status, 'error');
    assert.strictEqual(afterTimeout[0].attempts, 1);
    const noRetry = await queue.tick(pool, {
        loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }),
        sendImage: async () => { throw new Error('no'); },
        sendStatus: async () => {
            statusTimeoutCalls += 1;
            return 'should-not-run';
        },
    }, new Date(tTimeout.getTime() + 90_000));
    assert.strictEqual(noRetry.action, 'idle');
    assert.strictEqual(statusTimeoutCalls, 1);

    // Tras el timeout Evolution sigue con ese estado: la cola entera espera 10 min, grupos incluidos.
    const busyUntil = await queue.getBusyUntil(pool, tTimeout);
    assert.ok(busyUntil);
    assert.ok(Math.abs(busyUntil.getTime() - (tTimeout.getTime() + 10 * 60_000)) < 5_000);
    const waiting = await queue.createBatch(pool, {
        company: 'preventas',
        groupJid: '120363001@g.us',
        products: [{ ...oneStatus, odoo_id: 10, name: 'Vaso largo', caption: 'Vaso largo\n$1.523' }],
        intervalSeconds: 90,
        scheduledAt: '2020-01-06T09:00',
        now: arT('2020-01-06T09:00'),
    });
    await pool.query('UPDATE whatsapp_messages SET scheduled_at = $2, deadline_at = NULL WHERE batch_id = $1', [waiting.batch.id, tTimeout]); await pool.query('UPDATE whatsapp_batches SET scheduled_at = $2 WHERE id = $1', [waiting.batch.id, tTimeout]);
    const blocked = await queue.tick(pool, senderOk(), new Date(tTimeout.getTime() + 9 * 60_000));
    assert.strictEqual(blocked.action, 'idle');
    const queued = await queue.listQueue(pool, new Date(tTimeout.getTime() + 9 * 60_000));
    assert.strictEqual(queued[0].eta, busyUntil.toISOString());
    const freed = await queue.tick(pool, senderOk(), new Date(busyUntil.getTime() + 1_000));
    assert.strictEqual(freed.action, 'enviado');
    assert.strictEqual((await stateOf(pool, waiting.batch.id))[0].status, 'enviado');

    // rate-overlimit de WhatsApp: 15 min sin mandar nada.
    const limited = await queue.createBatch(pool, {
        company: 'preventas',
        groupJid: '120363001@g.us',
        products: [oneStatus],
        intervalSeconds: 90,
        scheduledAt: '2020-01-07T09:00',
        now: arT('2020-01-07T09:00'),
    });
    const tLimit = new Date('2020-01-07T03:00:00.000Z');
    await pool.query('UPDATE whatsapp_messages SET scheduled_at = $2, deadline_at = NULL WHERE batch_id = $1', [limited.batch.id, tLimit]); await pool.query('UPDATE whatsapp_batches SET scheduled_at = $2 WHERE id = $1', [limited.batch.id, tLimit]);
    const limitTick = await queue.tick(pool, {
        loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }),
        sendImage: async () => { throw new Error('Evolution API 400: Error: rate-overlimit'); },
    }, tLimit);
    assert.strictEqual(limitTick.action, 'error');
    const limitUntil = await queue.getBusyUntil(pool, tLimit);
    assert.ok(Math.abs(limitUntil.getTime() - (tLimit.getTime() + 15 * 60_000)) < 5_000);
    const retryLimited = await queue.tick(pool, senderOk(), new Date(tLimit.getTime() + 14 * 60_000));
    assert.strictEqual(retryLimited.action, 'idle');
    const afterLimit = await queue.tick(pool, senderOk(), new Date(limitUntil.getTime() + 1_000));
    assert.strictEqual(afterLimit.action, 'enviado');
    assert.strictEqual((await stateOf(pool, limited.batch.id))[0].status, 'enviado');

    const stuckStatus = await queue.createBatch(pool, {
        company: 'preventas',
        destino: 'estado',
        products: [{ ...oneStatus, odoo_id: 10, name: 'Vaso largo', caption: 'Vaso largo\n$1.523' }],
        intervalSeconds: 90,
        scheduledAt: '2020-01-08T00:00',
        maxAttempts: 3,
    });
    await pool.query(`
        UPDATE whatsapp_messages
        SET status = 'enviando', attempts = 1, updated_at = $2
        WHERE batch_id = $1
    `, [stuckStatus.batch.id, new Date(tTimeout.getTime() - 3 * 60_000)]);
    await pool.query(`UPDATE whatsapp_batches SET status = 'en_curso' WHERE id = $1`, [stuckStatus.batch.id]);
    let stuckCalls = 0;
    const recoveredStatus = await queue.tick(pool, {
        loadImage: async () => ({ base64: FAKE_JPEG, mimetype: 'image/jpeg' }),
        sendImage: async () => 'no',
        sendStatus: async () => { stuckCalls += 1; return 'dup'; },
    }, tTimeout);
    assert.strictEqual(recoveredStatus.action, 'idle');
    assert.strictEqual(stuckCalls, 0);
    const stuckRows = await stateOf(pool, stuckStatus.batch.id);
    assert.strictEqual(stuckRows[0].status, 'error');

    const logs = await pool.query('SELECT COUNT(*)::int AS n FROM whatsapp_logs');
    assert.ok(logs.rows[0].n > 0);
    console.log('cola ok');
}

// Reparto en el día contra la base: intercalado, 90 s, omitidos y vencidos.
async function testReparto(pool) {
    const base = {
        company: 'preventas', groupJid: '120363001@g.us', intervalSeconds: 90, maxAttempts: 3,
    };
    const p = (odoo_id, name) => ({
        odoo_id, company: 'preventas', name, price_amount: 1000, price_label: '$1.000',
        caption: `${name}\n$1.000`, template_id: 500 + odoo_id,
    });
    const muchos = (n, desde) => Array.from({ length: n }, (_, i) => p(desde + i, `Prod ${desde + i}`));
    // 2020-01-09 jueves: 10 desde las 9 y, a las 13, 6 más
    const a = await queue.createBatch(pool, { ...base, products: muchos(10, 100), scheduledAt: '2020-01-09T09:00', now: arT('2020-01-09T09:00') });
    assert.strictEqual(a.plan.programados, 10);
    const b = await queue.createBatch(pool, { ...base, products: muchos(6, 200), scheduledAt: '2020-01-09T13:00', now: arT('2020-01-09T13:00') });
    assert.strictEqual(b.plan.programados, 6);
    const { rows } = await pool.query(`
        SELECT batch_id, scheduled_at FROM whatsapp_messages
        WHERE batch_id = ANY($1::int[]) AND scheduled_at >= $2 ORDER BY scheduled_at
    `, [[a.batch.id, b.batch.id], arT('2020-01-09T13:00')]);
    const orden = rows.map((r) => (r.batch_id === a.batch.id ? 'A' : 'B')).join('');
    assert.ok(!/AAA|BBBB/.test(orden), orden);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(new Date(rows[i].scheduled_at) - new Date(rows[i - 1].scheduled_at) >= 90_000);
    }
    assert.ok(rows.every((r) => new Date(r.scheduled_at) <= arT('2020-01-09T18:00')));
    await queue.cancelBatch(pool, a.batch.id);
    await queue.cancelBatch(pool, b.batch.id);

    // A las 17:30, 30 fotos: entran las que caben a 90 s y el resto no se publica
    const tarde = await queue.createBatch(pool, { ...base, products: muchos(30, 300), scheduledAt: '2020-01-10T17:30', now: arT('2020-01-10T17:30') });
    assert.ok(tarde.plan.programados >= 19 && tarde.plan.programados <= 21, tarde.plan.programados);
    assert.strictEqual(tarde.plan.programados + tarde.plan.omitidos, 30);
    const detalle = await queue.getBatch(pool, tarde.batch.id);
    assert.strictEqual(detalle.omitidos, tarde.plan.omitidos);
    // Lo que no salió hasta las 18 se omite y la tanda termina
    assert.strictEqual((await queue.tick(pool, senderOk(), arT('2020-01-10T18:01'))).action, 'idle');
    const cerrada = await queue.getBatch(pool, tarde.batch.id);
    assert.strictEqual(cerrada.pendientes, 0);
    assert.strictEqual(cerrada.status, 'completada');

    // Domingo: pasa al lunes. Programado para un día que ya pasó: no entra nada
    const domingo = await queue.createBatch(pool, { ...base, products: muchos(2, 400), scheduledAt: '2020-01-12T10:00', now: arT('2020-01-11T12:00') });
    assert.ok(new Date(domingo.plan.desde) >= arT('2020-01-13T09:00'));
    await queue.cancelBatch(pool, domingo.batch.id);
    const viejo = await queue.createBatch(pool, { ...base, products: muchos(2, 500), scheduledAt: '2020-01-14T10:00', now: arT('2020-01-15T10:00') });
    assert.strictEqual(viejo.plan.programados, 0);
    assert.strictEqual((await queue.getBatch(pool, viejo.batch.id)).status, 'completada');
    console.log('reparto ok');
}

// Cola atrasada: todas las horas programadas ya pasaron, pero salen de a una.
function testEstimate() {
    const now = new Date('2020-01-05T12:30:00.000Z');
    const msg = (id, scheduled, extra = {}) => ({
        id, scheduled_at: scheduled, interval_seconds: 90, batch_status: 'en_curso', status: 'pendiente', ...extra,
    });
    const out = queue.estimateDepartures([
        msg(1, '2020-01-05T12:03:00.000Z'),
        msg(2, '2020-01-05T12:04:30.000Z'),
        msg(3, '2020-01-05T13:00:00.000Z'),
        msg(4, '2020-01-05T12:05:00.000Z', { batch_status: 'pausada' }),
    ], '2020-01-05T12:29:13.000Z', now);
    assert.deepStrictEqual(out.map((m) => m.eta), [
        '2020-01-05T12:30:43.000Z',
        '2020-01-05T12:32:13.000Z',
        '2020-01-05T13:00:00.000Z',
        null,
    ]);
    const fresh = queue.estimateDepartures([msg(1, '2020-01-05T12:00:00.000Z')], null, now);
    assert.strictEqual(fresh[0].eta, now.toISOString());
    // Con espera propia por mensaje, la estimación la respeta en vez del intervalo fijo.
    const jittered = queue.estimateDepartures([
        msg(1, '2020-01-05T12:03:00.000Z', { gap_seconds: 61 }),
        msg(2, '2020-01-05T12:04:00.000Z', { gap_seconds: 117 }),
    ], '2020-01-05T12:29:13.000Z', now);
    assert.deepStrictEqual(jittered.map((m) => m.eta), ['2020-01-05T12:30:14.000Z', '2020-01-05T12:32:11.000Z']);
    console.log('estimacion ok');
}

// Las esperas varían ±35 % alrededor del intervalo, en segundos enteros y nunca menos de 10 (con 90 s: 59 a 121).
function testJitter() {
    assert.deepStrictEqual(queue.jitterGaps(3, 90, () => 0.5), [90, 90, 90]);
    assert.deepStrictEqual(queue.jitterGaps(2, 90, () => 0), [59, 59]);
    assert.deepStrictEqual(queue.jitterGaps(1, 90, () => 0.999999), [121]);
    assert.deepStrictEqual(queue.jitterGaps(1, 10, () => 0), [10]);
    const gaps = queue.jitterGaps(200, 90);
    assert.ok(gaps.every((g) => Number.isInteger(g) && g >= 59 && g <= 121));
    assert.ok(new Set(gaps).size > 10);
    console.log('variacion ok');
}

async function main() {
    testPrice();
    testEvolutionParse();
    testEstimate();
    testJitter();
    const pool = await recreateDb();
    try {
        const ids = await seed(pool);
        await testSelection(pool, ids);
        await testQueue(pool);
    } finally {
        await pool.end();
    }
    console.log('whatsapp ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
