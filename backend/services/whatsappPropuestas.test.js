// Propuestas de WhatsApp por temporada: lectura del listado de Claude, agrupado e índice. Sin base ni Odoo.
// node backend/services/whatsappPropuestas.test.js

const assert = require('assert');
const { interpretar, agrupar, indice } = require('./whatsappPropuestas');

// ── interpretar ──────────────────────────────────────────────
{
    const r = interpretar([
        '# Fiestas: juguetes y pilas',
        '> Juguetería triplica su peso en diciembre.',
        '> Las pilas acompañan los regalos.',
        '',
        '101 Regalo top de Navidad',
        '202   Pilas para los juguetes  ',
    ].join('\n'));
    assert.deepStrictEqual(r.errores, []);
    assert.strictEqual(r.titulo, 'Fiestas: juguetes y pilas');
    assert.strictEqual(r.resumen, 'Juguetería triplica su peso en diciembre.\nLas pilas acompañan los regalos.');
    assert.deepStrictEqual(r.items, [
        { odoo_id: 101, motivo: 'Regalo top de Navidad' },
        { odoo_id: 202, motivo: 'Pilas para los juguetes' },
    ]);
}
{
    const r = interpretar('101 sin título\n101 repetido\nhola');
    assert.ok(r.errores.some((e) => e.includes('repetido')));
    assert.ok(r.errores.some((e) => e.includes('no la entiendo')));
    assert.ok(r.errores.some((e) => e.includes('Falta el título')));
}
{
    const r = interpretar('# Solo título');
    assert.ok(r.errores.includes('No hay ningún producto'));
}
{
    // Un número sin motivo no vale
    const r = interpretar('# T\n555');
    assert.ok(r.errores.some((e) => e.includes('Línea 2')));
}

// ── agrupar: por categoría, en el orden de la propuesta; lo que ya no se puede publicar se omite ──
{
    const items = [
        { odoo_id: 1, motivo: 'a' }, { odoo_id: 2, motivo: 'b' }, { odoo_id: 3, motivo: 'c' }, { odoo_id: 9, motivo: 'x' },
    ];
    const productos = [
        { odoo_id: 3, categ_name: 'Jugueteria', name: 'C' },
        { odoo_id: 1, categ_name: 'Jugueteria', name: 'A' },
        { odoo_id: 2, categ_name: 'Tecnología', name: 'B' },
    ];
    const { grupos, omitidos } = agrupar(items, productos);
    assert.strictEqual(omitidos, 1);
    assert.deepStrictEqual(grupos.map((g) => g.category), ['Jugueteria', 'Tecnología']);
    assert.deepStrictEqual(grupos[0].products.map((p) => [p.odoo_id, p.motivo]), [[1, 'a'], [3, 'c']]);
}

// ── indice ───────────────────────────────────────────────────
{
    const v = { semanas_ventana: 4, semanas_resto: 48 };
    assert.strictEqual(indice(40, 120, v), 4);          // 10 por semana vs 2,5
    assert.strictEqual(indice(5, 0, v), Infinity);      // solo se vendió en esa época
    assert.strictEqual(indice(0, 0, v), null);
    assert.strictEqual(indice(5, 5, { semanas_ventana: 0, semanas_resto: 52 }), null);
}

console.log('✅ whatsappPropuestas: ok');
