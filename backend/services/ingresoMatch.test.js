// Reglas de clasificación del ingreso. Sin Odoo.
// node backend/services/ingresoMatch.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');
const {
    nameMatchDecision,
    MATCH_LEVELS_TO_CONFIRM,
    refWithoutSupplierPrefix,
    buildRefWithoutPrefixIndex,
    matchByRefWithoutPrefix,
    allocatePreventaQty,
    capPreventaShares,
    distributePreventaQty,
    persistPurchaseOrderIds,
} = require('./ingresoService');

function testDecision() {
    const same = nameMatchDecision('Lámpara de pie', 'lampara   de pie');
    assert.strictEqual(same.matchLevel, 'exact_name');
    assert.strictEqual(same.estado, 'matched');
    assert.strictEqual(same.confidence, 1);

    const accent = nameMatchDecision('Jabón líquido', 'jabon liquido');
    assert.strictEqual(accent.estado, 'matched');

    const fuzzy = nameMatchDecision('Vaso largo de vidrio', 'Vaso largo vidrio');
    assert.ok(fuzzy);
    assert.strictEqual(fuzzy.matchLevel, 'fuzzy_name');
    assert.strictEqual(fuzzy.estado, 'pending');

    assert.strictEqual(nameMatchDecision('tornillo', 'heladera no frost'), null);
    console.log('decision ok');
}

function testRefOtroProveedor() {
    const prefixes = ['MG', 'CY', 'FX'];
    assert.strictEqual(refWithoutSupplierPrefix('MG-BR8003021', prefixes), 'BR8003021');
    assert.strictEqual(refWithoutSupplierPrefix('MGCL0005', prefixes), 'CL0005');
    assert.strictEqual(refWithoutSupplierPrefix('XX123', prefixes), null);

    const products = [
        { odoo_id: 1, internal_ref: 'MG-BR8003021', active: true },
        { odoo_id: 2, internal_ref: 'MG-0001', active: true },
        { odoo_id: 3, internal_ref: 'FX-AB12345', active: true },
        { odoo_id: 4, internal_ref: 'CY-AB12345', active: true },
        { odoo_id: 5, internal_ref: 'MG-ZZ99999', active: false },
        { odoo_id: 6, internal_ref: 'FX-ZZ99999', active: true },
    ];
    const index = buildRefWithoutPrefixIndex(products, prefixes);
    // Código de factura de un proveedor → producto cargado con prefijo de otro
    assert.strictEqual(matchByRefWithoutPrefix(index, 'BR8003021').odoo_id, 1);
    assert.strictEqual(matchByRefWithoutPrefix(index, 'br-8003021').odoo_id, 1);
    // Código corto: no se arriesga
    assert.strictEqual(matchByRefWithoutPrefix(index, '0001'), null);
    // Dos productos activos con el mismo código: queda para una persona
    assert.strictEqual(matchByRefWithoutPrefix(index, 'AB12345'), null);
    // El activo gana al archivado
    assert.strictEqual(matchByRefWithoutPrefix(index, 'ZZ99999').odoo_id, 6);
    assert.strictEqual(matchByRefWithoutPrefix(index, 'NOEXISTE1'), null);
    // Se vincula solo; el parecido de nombre sigue pidiendo confirmación
    assert.ok(!MATCH_LEVELS_TO_CONFIRM.includes('ref_other_prefix'));
    assert.ok(MATCH_LEVELS_TO_CONFIRM.includes('fuzzy_name'));
    console.log('ref otro proveedor ok');
}

function testAllocation() {
    const rows = [{ id: 2, cantidad: 4 }, { id: 1, cantidad: 6 }];
    assert.deepStrictEqual(
        allocatePreventaQty(rows, 10).map(r => r.preventa_qty_confirmed),
        [6, 4]
    );
    assert.deepStrictEqual(
        allocatePreventaQty(rows, 7).map(r => r.preventa_qty_confirmed),
        [6, 1]
    );
    assert.deepStrictEqual(
        allocatePreventaQty(rows, 20).map(r => r.preventa_qty_confirmed),
        [6, 4]
    );

    const capped = capPreventaShares({
        cantidad: 4,
        preventa_qty_confirmed: 10,
        preventa_links: [
            { preventas_product_id: 1, qty: 6 },
            { preventas_product_id: 2, qty: 4 },
        ],
    });
    assert.strictEqual(capped.reduce((s, l) => s + l.qty, 0), 4);
    assert.ok(capped.every(l => l.qty > 0));
    console.log('reparto ok');
}

function testSource() {
    const service = fs.readFileSync(path.join(__dirname, 'ingresoService.js'), 'utf8');
    const route = fs.readFileSync(path.join(__dirname, '../routes/ingreso.js'), 'utf8');
    assert.ok(!service.includes('LIKE UPPER($3)'));
    assert.ok(!route.includes('nombre_fuzzy'));
    assert.ok(service.includes("matchLevel !== 'fuzzy_name'"));
    assert.ok(route.includes('persistPurchaseOrderIds'));
    console.log('fuente ok');
}

async function recreateDb() {
    const admin = new Client({ host: '/var/run/postgresql', database: 'postgres' });
    await admin.connect();
    await admin.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = 'neggo_ingreso_test' AND pid <> pg_backend_pid()
    `);
    await admin.query('DROP DATABASE IF EXISTS neggo_ingreso_test');
    await admin.query('CREATE DATABASE neggo_ingreso_test');
    await admin.end();
    const pool = new Pool({
        connectionString: 'postgresql://ubuntu@/neggo_ingreso_test?host=/var/run/postgresql',
    });
    await pool.query(`
        CREATE TABLE ingreso_mercaderia (
            id SERIAL PRIMARY KEY,
            odoo_purchase_order_id INTEGER,
            odoo_purchase_order_id_preventas INTEGER
        );
        CREATE TABLE ingreso_items (
            id SERIAL PRIMARY KEY,
            ingreso_id INTEGER NOT NULL,
            codigo VARCHAR(80),
            cantidad INTEGER NOT NULL,
            preventa_qty_confirmed INTEGER NOT NULL DEFAULT 0,
            preventas_product_id INTEGER,
            preventas_product_name VARCHAR(200)
        );
    `);
    return pool;
}

async function testPersistence(pool) {
    await pool.query(`INSERT INTO ingreso_mercaderia (id) VALUES (1)`);
    await pool.query(`
        INSERT INTO ingreso_items (id, ingreso_id, codigo, cantidad) VALUES
            (1, 1, 'AB-1', 6),
            (2, 1, 'ab1', 4),
            (3, 1, 'OTRO', 5)
    `);
    // El código se compara en mayúsculas, no ignorando el guion: AB-1 y ab1 son distintos.
    const same = await distributePreventaQty(pool, 1, 1, 9);
    assert.strictEqual(same.length, 1);
    assert.strictEqual(same[0].preventa_qty_confirmed, 6);

    await pool.query(`UPDATE ingreso_items SET codigo = 'AB-1' WHERE id = 2`);
    const split = await distributePreventaQty(pool, 1, 1, 9);
    assert.deepStrictEqual(split.map(r => r.preventa_qty_confirmed), [6, 3]);

    await persistPurchaseOrderIds(1, 55, null, pool);
    await persistPurchaseOrderIds(1, 99, 77, pool);
    const { rows } = await pool.query('SELECT * FROM ingreso_mercaderia WHERE id = 1');
    assert.strictEqual(rows[0].odoo_purchase_order_id, 55);
    assert.strictEqual(rows[0].odoo_purchase_order_id_preventas, 77);
    console.log('persistencia ok');
}

async function main() {
    testDecision();
    testRefOtroProveedor();
    testAllocation();
    testSource();
    const pool = await recreateDb();
    try {
        await testPersistence(pool);
    } finally {
        await pool.end();
    }
    console.log('ingreso ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
