// Imágenes para estados: validación y SQL del sorteo/registro con un pool falso. Sin base ni Odoo.
// node backend/services/estadoImagenes.test.js

const assert = require('assert');
const { validarDescargas, registrarDescargas, sortear } = require('./estadoImagenes');

function fakePool() {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/INSERT INTO estado_imagenes_descargas/.test(sql)) return { rows: [], rowCount: params[1].length };
            return { rows: [], rowCount: 0 };
        },
    };
}

(async () => {
    // Validación
    assert.deepStrictEqual(validarDescargas({ company: 'neggo', odooIds: [3, '3', 7, 'x', -1], formato: 'historia' }), [3, 7]);
    assert.throws(() => validarDescargas({ company: 'otra', odooIds: [1], formato: 'historia' }), /neggo o preventas/);
    assert.throws(() => validarDescargas({ company: 'neggo', odooIds: [1], formato: 'vertical' }), /historia o cuadrada/);
    assert.throws(() => validarDescargas({ company: 'neggo', odooIds: [], formato: 'cuadrada' }), /No hay productos/);
    assert.throws(() => validarDescargas({ company: 'neggo', odooIds: Array.from({ length: 501 }, (_, i) => i + 1), formato: 'cuadrada' }), /hasta 500/);

    // Registro: crea el esquema una sola vez y anota sin duplicados
    const pool = fakePool();
    const r1 = await registrarDescargas(pool, { company: 'preventas', odooIds: [10, 10, 11], formato: 'cuadrada', userId: 4 });
    assert.strictEqual(r1.anotadas, 2);
    await registrarDescargas(pool, { company: 'preventas', odooIds: [12], formato: 'historia' });
    const schemaRuns = pool.calls.filter((c) => /CREATE TABLE IF NOT EXISTS estado_imagenes_descargas/.test(c.sql)).length;
    assert.strictEqual(schemaRuns, 1, 'el esquema se aplica una vez por proceso');
    const insert = pool.calls.find((c) => /INSERT INTO/.test(c.sql));
    assert.deepStrictEqual(insert.params, ['preventas', [10, 11], 'cuadrada', 4]);

    // Sorteo: excluye lo descargado en los últimos días
    const pool2 = fakePool();
    await sortear(pool2, { company: 'neggo', category: 'Bazar', count: 5, excludeIds: [] });
    const select = pool2.calls.find((c) => /ORDER BY random\(\)/.test(c.sql));
    assert.ok(/FROM estado_imagenes_descargas/.test(select.sql), 'el sorteo mira las descargas');

    console.log('✅ estadoImagenes: todos los tests pasan');
})().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
