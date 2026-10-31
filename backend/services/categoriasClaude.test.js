// Categorías revisadas por Claude: texto de la tanda e interpretación de respuestas. Sin base ni Odoo.
// node backend/services/categoriasClaude.test.js

const assert = require('assert');
const { formatearLote, interpretarRespuestas } = require('./categoriasClaudeService');

// ── formatearLote ────────────────────────────────────────────
{
    const texto = formatearLote({
        filas: [{ id: 7, proveedor: 'Blumen', source_category: 'TAZAS', productos: 4, ejemplos: ['Taza 300ml', 'Taza 500ml'] }],
        categs: [{ id: 156, nombre: 'Bazar', usos: 30 }],
        reglas: [{ proveedor: 'ZLE', categoria: 'Halloween', neggo: 'Cotillon', preventas: 'Cotillon' }],
        quedan: 120,
    });
    assert.ok(texto.includes('1 filas (sin revisar en total: 120)'));
    assert.ok(texto.includes('  156 | Bazar | 30'));
    assert.ok(texto.includes('  ZLE | Halloween → Cotillon / Cotillon'));
    assert.ok(texto.includes('  7 | Blumen | TAZAS | 4 | Taza 300ml · Taza 500ml'));
}

// ── interpretarRespuestas ────────────────────────────────────
{
    const ctx = { idsFilas: [1, 2, 3, 4, 5], idsCategorias: [156, 163, 164] };
    const { respuestas, errores } = interpretarRespuestas([
        '# comentario',
        '1 156 alta tazas y vasos',
        '2 163/164 Media juguetes en Neggo, librería en Preventas',
        '3 - repuestos de máquinas, no encaja',
        '',
        '4 999 alta categoría inventada',
        '5 156 segura confianza inválida',
        '9 156 alta fuera de la tanda',
        '1 164 alta repetida',
        'cualquier cosa',
    ].join('\n'), ctx);

    assert.deepStrictEqual(respuestas, [
        { id: 1, neggo: 156, preventas: 156, confianza: 'alta', motivo: 'tazas y vasos' },
        { id: 2, neggo: 163, preventas: 164, confianza: 'media', motivo: 'juguetes en Neggo, librería en Preventas' },
        { id: 3, neggo: null, preventas: null, confianza: null, motivo: 'repuestos de máquinas, no encaja' },
    ]);
    assert.strictEqual(errores.length, 5);
    assert.ok(errores[0].includes('999 no existe'));
    assert.ok(errores[1].includes('confianza'));
    assert.ok(errores[2].includes('no está en la tanda'));
    assert.ok(errores[3].includes('repetido'));
    assert.ok(errores[4].includes('formato'));
}

console.log('✅ categoriasClaude.test.js: todo OK');
