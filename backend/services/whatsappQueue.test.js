// Precio de catálogo, formato es-AR y cola persistente. Sin red ni Evolution.
// node backend/services/whatsappQueue.test.js

const assert = require('assert');
const { Client, Pool } = require('pg');
const { formatMoneyAR, catalogSalePrice, buildCaption } = require('./whatsappPrice');
const { calculatePrices } = require('./rulesEngine');
const { extractQr, normalizeGroups, instanceName } = require('./evolutionClient');
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
    process.env.EVOLUTION_STATUS_INSTANCE = 'neggo';
    assert.throws(() => instanceName('estado'), /distinta/);
    if (prevGroup == null) delete process.env.EVOLUTION_INSTANCE;
    else process.env.EVOLUTION_INSTANCE = prevGroup;
    if (prevStatus == null) delete process.env.EVOLUTION_STATUS_INSTANCE;
    else process.env.EVOLUTION_STATUS_INSTANCE = prevStatus;
    console.log('evolution parse ok');
}

async function recreateDb() {
    const admin = new Client({ host: '/var/run/postgresql', database: 'postgres' });
    await admin.connect();
    await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = 'neggo_wa_test' AND pid <> pg_backend_pid()
    `);
    await admin.query('DROP DATABASE IF EXISTS neggo_wa_test');
    await admin.query('CREATE DATABASE neggo_wa_test');
    await admin.end();
    const pool = new Pool({
        connectionString: 'postgresql://ubuntu@/neggo_wa_test?host=/var/run/postgresql',
    });
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
            available BOOLEAN NOT NULL DEFAULT true
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
            odoo_company VARCHAR(20), active BOOLEAN DEFAULT true, match_confidence NUMERIC
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

async function testQueue(pool) {
    const base = new Date('2020-01-01T03:00:00.000Z');
    const created = await queue.createBatch(pool, {
        company: 'preventas',
        groupJid: '120363001@g.us',
        groupSubject: 'Ofertas',
        intervalSeconds: 90,
        random: () => 0.5,
        scheduledAt: '2020-01-01T00:00',
        maxAttempts: 3,
    });
    assert.strictEqual(created.total, 2);

    const first = await queue.tick(pool, senderOk(), base);
    assert.strictEqual(first.action, 'enviado');
    const again = await queue.tick(pool, senderOk(), new Date(base.getTime() + 89_000));
    assert.strictEqual(again.action, 'idle');
    await queue.pauseBatch(pool, created.batch.id);
    const paused = await queue.tick(pool, senderOk(), new Date(base.getTime() + 90_000));
    assert.strictEqual(paused.action, 'idle');
    await queue.resumeBatch(pool, created.batch.id);
    const second = await queue.tick(pool, senderOk(), new Date(base.getTime() + 90_000));
    assert.strictEqual(second.action, 'enviado');
    const done = await queue.getBatch(pool, created.batch.id);
    assert.strictEqual(done.status, 'completada');
    assert.strictEqual(done.enviados, 2);

    const retry = await queue.createBatch(pool, {
        company: 'preventas',
        category: 'Bazar',
        destCategory: 'Bazar',
        groupJid: '120363001@g.us',
        intervalSeconds: 90,
        random: () => 0.5,
        scheduledAt: '2020-01-02T00:00',
        maxAttempts: 3,
    });
    await pool.query('DELETE FROM whatsapp_messages WHERE batch_id = $1 AND position > 0', [retry.batch.id]);
    let t = new Date('2020-01-02T03:00:00.000Z');
    for (let i = 0; i < 3; i++) {
        const r = await queue.tick(pool, senderFail(), t);
        assert.strictEqual(r.action, 'error');
        t = new Date(t.getTime() + 90_000);
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
        random: () => 0.5,
        scheduledAt: '2020-01-03T00:00',
        maxAttempts: 3,
    });
    const c0 = new Date('2020-01-03T03:00:00.000Z');
    assert.strictEqual((await queue.tick(pool, senderOk(), c0)).action, 'enviado');
    await queue.cancelBatch(pool, cancel.batch.id);
    assert.strictEqual((await queue.tick(pool, senderOk(), new Date(c0.getTime() + 90_000))).action, 'idle');
    const left = await stateOf(pool, cancel.batch.id);
    assert.strictEqual(left[0].status, 'enviado');
    assert.strictEqual(left[1].status, 'pendiente');

    await pool.query(`
        UPDATE whatsapp_messages
        SET status = 'enviando', attempts = 1, updated_at = $2
        WHERE batch_id = $1 AND position = 1
    `, [cancel.batch.id, new Date(c0.getTime() - 3 * 60_000)]);
    await pool.query(`UPDATE whatsapp_batches SET status = 'en_curso' WHERE id = $1`, [cancel.batch.id]);
    const recovered = await queue.tick(pool, senderOk(), new Date(c0.getTime() + 180_000));
    assert.strictEqual(recovered.action, 'enviado');
    const finalRows = await stateOf(pool, cancel.batch.id);
    assert.strictEqual(finalRows[1].status, 'enviado');
    assert.strictEqual(finalRows[1].attempts, 2);

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

    const logs = await pool.query('SELECT COUNT(*)::int AS n FROM whatsapp_logs');
    assert.ok(logs.rows[0].n > 0);
    console.log('cola ok');
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
