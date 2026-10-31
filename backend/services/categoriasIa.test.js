// Sugerencias de categoría por IA: validación de pedido, armado del prompt e interpretación. Sin base ni red.
// node backend/services/categoriasIa.test.js

const assert = require('assert');
const { validarItems, armarPrompt, interpretarRespuesta, MAX_FILAS } = require('./categoriasIaService');

const categs = {
    neggo: [{ id: 10, complete_name: 'Bazar', usos: 3 }, { id: 11, complete_name: 'Tecnología', usos: 0 }],
    preventas: [{ id: 20, complete_name: 'Bazar', usos: 0 }],
};

// ── validarItems ─────────────────────────────────────────────
assert.ok(validarItems([]).error);
assert.ok(validarItems(null).error);
assert.ok(validarItems([{ supplier_id: 1 }]).error);
assert.ok(validarItems(Array.from({ length: MAX_FILAS + 1 }, (_, i) => ({ supplier_id: 1, source_category: `c${i}` }))).error);
{
    const { filas } = validarItems([
        { supplier_id: '3', source_category: 'Tazas' },
        { supplier_id: 3, source_category: 'Tazas' },
        { supplier_id: 4, source_category: 'Tazas ' },
    ]);
    assert.deepStrictEqual(filas, [
        { supplier_id: 3, source_category: 'Tazas' },
        { supplier_id: 4, source_category: 'Tazas ' },
    ], 'deduplica sin recortar espacios (la categoría tiene que coincidir exacta con la base)');
}

// ── armarPrompt ──────────────────────────────────────────────
{
    const { sistema, usuario } = armarPrompt({
        categs,
        ejemplos: [{ proveedor: 'ZLE', categoria: 'Halloween', neggo: 'Cotillon', preventas: 'Cotillon' }],
        filas: [{ i: 1, proveedor: 'Blumen', categoria: 'TAZAS', productos: 4, ejemplos_productos: ['Taza 300ml'] }],
    });
    assert.ok(sistema.includes('JSON'));
    assert.ok(usuario.includes('10 | Bazar (usada en 3 reglas)'));
    assert.ok(usuario.includes('11 | Tecnología\n'), 'sin usos no agrega el paréntesis');
    assert.ok(usuario.includes('ZLE | Halloween → Cotillon / Cotillon'));
    assert.ok(usuario.includes('1. Blumen | TAZAS | 4 prod. | ej: Taza 300ml'));
}

// ── interpretarRespuesta ─────────────────────────────────────
{
    const texto = JSON.stringify({ sugerencias: [
        { i: 1, neggo: 10, preventas: 20, confianza: 'alta', motivo: 'tazas = bazar' },
        { i: 2, neggo: 999, preventas: null, confianza: 'media', motivo: 'id inventado' },
        { i: 3, neggo: '11', preventas: 999, confianza: 'rarisima', motivo: 'x' },
        { i: 1, neggo: 11, preventas: 20, confianza: 'alta', motivo: 'repetida' },
        { i: 9, neggo: 10, preventas: 20, confianza: 'alta', motivo: 'fuera de rango' },
    ] });
    const r = interpretarRespuesta(texto, { categs, cantidadFilas: 3 });
    assert.deepStrictEqual(r.get(1), { neggo: 10, preventas: 20, confianza: 'alta', motivo: 'tazas = bazar' });
    assert.strictEqual(r.has(2), false, 'ids que no existen en Odoo se descartan');
    assert.deepStrictEqual(r.get(3), { neggo: 11, preventas: null, confianza: 'baja', motivo: 'x' });
    assert.strictEqual(r.size, 2);
    assert.strictEqual(interpretarRespuesta('no es json', { categs, cantidadFilas: 3 }).size, 0);
}

console.log('✅ categoriasIa.test.js: todo OK');
