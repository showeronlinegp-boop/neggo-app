// Cambiar el código de referencia desde Conflictos (nota 117): escribe en Odoo (simulado) y
// rechaza los vínculos por código que dejan de coincidir. Usa una base de prueba aparte.
// DATABASE_URL=postgresql://... node backend/services/vincularReferencia.test.js

const assert = require('assert');
const { Client } = require('pg');

const DB_PRUEBA = 'neggo_ref_test';
const urlBase = process.env.DATABASE_URL;
if (!urlBase) throw new Error('Falta DATABASE_URL (se usa solo para crear la base de prueba)');
const urlPrueba = urlBase.replace(/\/[^/?]+(\?|$)/, `/${DB_PRUEBA}$1`);

async function recrearBase() {
    const admin = new Client({ connectionString: urlBase });
    await admin.connect();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_PRUEBA]);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_PRUEBA}`);
    await admin.query(`CREATE DATABASE ${DB_PRUEBA}`);
    await admin.end();

    const db = new Client({ connectionString: urlPrueba });
    await db.connect();
    await db.query(`
        CREATE TABLE suppliers (id SERIAL PRIMARY KEY, name VARCHAR(100), prefix VARCHAR(20));
        CREATE TABLE supplier_products (id SERIAL PRIMARY KEY, supplier_id INTEGER, sku VARCHAR(100), name VARCHAR(500), source VARCHAR(20) DEFAULT 'web');
        CREATE TABLE odoo_products_cache (odoo_id INTEGER, company VARCHAR(20), name VARCHAR(500), internal_ref VARCHAR(100), active BOOLEAN DEFAULT true);
        CREATE TABLE product_mappings (
            id SERIAL PRIMARY KEY, supplier_product_id INTEGER, odoo_product_id INTEGER, odoo_company VARCHAR(20),
            odoo_internal_ref VARCHAR(100), match_confidence NUMERIC, active BOOLEAN DEFAULT true,
            es_habitual BOOLEAN DEFAULT false, estado VARCHAR(20), metodo VARCHAR(30)
        );
        CREATE TABLE match_decisiones (
            id SERIAL PRIMARY KEY, supplier_product_id INTEGER, odoo_product_id INTEGER, odoo_company VARCHAR(20),
            decision VARCHAR(20), metodo VARCHAR(30), puntaje NUMERIC, user_id INTEGER
        );
        INSERT INTO suppliers (id, name, prefix) VALUES (1, 'Impotekno', '');
        INSERT INTO supplier_products (id, supplier_id, sku, name) VALUES
            (10, 1, 'PREITLB1704S2', 'Mini pimer'),
            (11, 1, 'PREVIEJO8885', 'Minipimer vieja');
        INSERT INTO odoo_products_cache (odoo_id, company, name, internal_ref, active) VALUES
            (100, 'neggo', 'Mini Pimer Luma Bella 500W', 'ITLB1704S2', true),
            (200, 'neggo', 'Minipimer 600W Art. 8885', 'ITLB1704S2', false),
            (300, 'neggo', 'Otro producto', 'OTRO-1', true);
        INSERT INTO product_mappings (supplier_product_id, odoo_product_id, odoo_company, odoo_internal_ref, match_confidence, active, es_habitual, estado, metodo) VALUES
            (10, 100, 'neggo', 'ITLB1704S2', 1, true, true, 'confirmado', 'codigo'),
            (10, 200, 'neggo', 'ITLB1704S2', 1, true, false, 'confirmado', 'codigo'),
            (11, 200, 'neggo', 'ITLB1704S2', 0.8, true, false, 'confirmado', 'nombre');
    `);
    return db;
}

function odooSimulado({ falla = false } = {}) {
    const llamadas = [];
    return {
        llamadas,
        getCompanyIds: async () => ({ neggo: 7, preventas: 8 }),
        callOdoo: async (model, method, args, kwargs) => {
            llamadas.push({ model, method, args, kwargs });
            if (falla) throw new Error('Odoo caído');
            return true;
        },
    };
}

async function main() {
    const db = await recrearBase();
    process.env.DATABASE_URL = urlPrueba;
    const pool = require('../config/database');
    const { cambiarReferencia } = require('./vincularService');
    try {
        // Código repetido con otro producto: no se escribe en Odoo
        let odoo = odooSimulado();
        await assert.rejects(
            cambiarReferencia({ odooProductId: 200, ref: 'otro-1', userId: 1 }, odoo),
            (err) => err.status === 409 && /Otro producto/.test(err.message)
        );
        assert.strictEqual(odoo.llamadas.length, 0);

        // Producto que no existe
        await assert.rejects(cambiarReferencia({ odooProductId: 999, ref: 'X', userId: 1 }, odoo), (err) => err.status === 404);

        // Si Odoo falla, la app no cambia
        odoo = odooSimulado({ falla: true });
        await assert.rejects(cambiarReferencia({ odooProductId: 200, ref: 'VIEJO-8885', userId: 1 }, odoo), /Odoo caído/);
        let r = await db.query(`SELECT internal_ref FROM odoo_products_cache WHERE odoo_id = 200`);
        assert.strictEqual(r.rows[0].internal_ref, 'ITLB1704S2');

        // Cambio real: escribe en Odoo con la empresa Neggo y saca solo el vínculo por código
        odoo = odooSimulado();
        const res = await cambiarReferencia({ odooProductId: 200, ref: '  VIEJO-8885 ', userId: 5 }, odoo);
        assert.deepStrictEqual(res, { antes: 'ITLB1704S2', despues: 'VIEJO-8885', desvinculados: 1 });
        assert.deepStrictEqual(odoo.llamadas, [{
            model: 'product.product', method: 'write',
            args: [[200], { default_code: 'VIEJO-8885' }],
            kwargs: { context: { allowed_company_ids: [7] } },
        }]);
        r = await db.query(`SELECT internal_ref FROM odoo_products_cache WHERE odoo_id = 200`);
        assert.strictEqual(r.rows[0].internal_ref, 'VIEJO-8885');
        r = await db.query(`SELECT supplier_product_id, odoo_product_id, estado, active, odoo_internal_ref FROM product_mappings ORDER BY id`);
        assert.deepStrictEqual(r.rows.map(m => [m.supplier_product_id, m.odoo_product_id, m.estado, m.active, m.odoo_internal_ref]), [
            [10, 100, 'confirmado', true, 'ITLB1704S2'],   // el activo no se toca
            [10, 200, 'rechazado', false, 'VIEJO-8885'],   // por código y ya no coincide
            [11, 200, 'confirmado', true, 'VIEJO-8885'],   // por nombre: queda
        ]);
        r = await db.query(`SELECT supplier_product_id, odoo_product_id, decision, metodo, user_id FROM match_decisiones`);
        assert.deepStrictEqual(r.rows, [{ supplier_product_id: 10, odoo_product_id: 200, decision: 'rechazado', metodo: 'codigo', user_id: 5 }]);

        // Mismo código: no vuelve a escribir en Odoo
        odoo = odooSimulado();
        assert.strictEqual((await cambiarReferencia({ odooProductId: 200, ref: 'VIEJO-8885', userId: 5 }, odoo)).desvinculados, 0);
        assert.strictEqual(odoo.llamadas.length, 0);

        // Vacío borra el código en Odoo (false) y en la app (null), y saca los vínculos por código que queden
        odoo = odooSimulado();
        await db.query(`UPDATE product_mappings SET estado = 'confirmado', active = true WHERE supplier_product_id = 10 AND odoo_product_id = 200`);
        const vacio = await cambiarReferencia({ odooProductId: 200, ref: '', userId: 5 }, odoo);
        assert.strictEqual(vacio.desvinculados, 1);
        assert.strictEqual(odoo.llamadas[0].args[1].default_code, false);
        r = await db.query(`SELECT internal_ref FROM odoo_products_cache WHERE odoo_id = 200`);
        assert.strictEqual(r.rows[0].internal_ref, null);

        // Un código nuevo que sigue coincidiendo con la oferta (solo cambian símbolos) no la saca
        odoo = odooSimulado();
        const igual = await cambiarReferencia({ odooProductId: 100, ref: 'ITLB-1704-S2', userId: 5 }, odoo);
        assert.strictEqual(igual.desvinculados, 0);
        r = await db.query(`SELECT estado FROM product_mappings WHERE supplier_product_id = 10 AND odoo_product_id = 100`);
        assert.strictEqual(r.rows[0].estado, 'confirmado');

        console.log('✅ cambiar código de referencia ok');
    } finally {
        await pool.end();
        await db.end();
    }
}

main().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
