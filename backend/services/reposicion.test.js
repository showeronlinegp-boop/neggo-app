// Detección de productos archivados/reactivados para la cola de reposición. Sin base de datos.
// node backend/services/reposicion.test.js

const assert = require('assert');
const { detectarTransiciones } = require('./reposicionService');

function testTransiciones() {
    const antes = new Map([
        [1, true],   // sigue activo
        [2, true],   // se archiva
        [3, false],  // se reactiva
        [4, false],  // sigue archivado
    ]);
    const productos = [
        { id: 1, active: true },
        { id: 2, active: false },
        { id: 3, active: true },
        { id: 4, active: false },
        { id: 5, active: false }, // producto nuevo, ya archivado: no es un cambio
    ];
    const r = detectarTransiciones(antes, productos);
    assert.deepStrictEqual(r.archivados, [2]);
    assert.deepStrictEqual(r.reactivados, [3]);
}

function testCacheVacio() {
    // Primer sync con el cache vacío: no encola nada (evita meter miles de archivados viejos)
    const r = detectarTransiciones(new Map(), [{ id: 1, active: false }, { id: 2, active: true }]);
    assert.deepStrictEqual(r, { archivados: [], reactivados: [] });
}

testTransiciones();
testCacheVacio();
console.log('✅ reposicion: todos los casos pasan');
process.exit(0);
