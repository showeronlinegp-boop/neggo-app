// Precios frescos en Reposición: quién tiene precios viejos y a quién se scrapea.
// Sin base de datos. node backend/services/preciosFrescos.test.js

const assert = require('assert');
const { resumirFrescura, elegirParaActualizar } = require('./preciosFrescosService');

const ahora = new Date('2026-10-30T12:00:00Z');
const filas = [
    { supplier_id: 1, proveedor: 'Babu', last_scraped_at: '2026-10-29T10:00:00Z', scrape_enabled: true, productos: '4', ultimo_run: 'completed' },
    { supplier_id: 2, proveedor: 'CastMayorista', last_scraped_at: '2026-10-22T18:56:00Z', scrape_enabled: true, productos: '12', ultimo_run: 'completed' },
    { supplier_id: 3, proveedor: 'ZLE', last_scraped_at: '2026-10-23T11:28:00Z', scrape_enabled: true, productos: '3', ultimo_run: 'paused' },
    { supplier_id: 6, proveedor: 'El Rey', last_scraped_at: '2026-10-23T18:56:00Z', scrape_enabled: true, productos: '1', ultimo_run: 'completed' },
    { supplier_id: 4, proveedor: 'Impotekno', last_scraped_at: '2026-10-20T10:00:00Z', scrape_enabled: true, productos: '9', ultimo_run: 'running' },
    { supplier_id: 5, proveedor: 'Mali', last_scraped_at: null, scrape_enabled: false, productos: '2', ultimo_run: null },
];

function testResumen() {
    const r = resumirFrescura(filas, ahora);
    const por = new Map(r.proveedores.map(p => [p.proveedor, p]));
    assert.strictEqual(por.get('Babu').viejo, false);
    assert.strictEqual(por.get('Babu').dias, 1);
    assert.strictEqual(por.get('CastMayorista').viejo, true);
    assert.strictEqual(por.get('ZLE').pausado, true);
    assert.strictEqual(por.get('ZLE').viejo, true);
    // 6,7 días: todavía no es viejo
    assert.strictEqual(por.get('El Rey').viejo, false);
    assert.strictEqual(por.get('El Rey').dias, 6);
    assert.strictEqual(por.get('Impotekno').en_curso, true);
    assert.strictEqual(por.get('Mali').dias, null);
    assert.strictEqual(por.get('Mali').viejo, true);
    // Los viejos primero y, entre ellos, los que afectan más productos
    assert.strictEqual(r.proveedores[0].proveedor, 'CastMayorista');
    assert.deepStrictEqual(r.proveedores.slice(-2).map(p => p.proveedor), ['Babu', 'El Rey']);
    // El que ya está corriendo no cuenta como viejo pendiente
    assert.strictEqual(r.n_viejos, 3);
    assert.strictEqual(r.productos_con_precio_viejo, 12 + 3 + 2);
    assert.strictEqual(r.n_en_curso, 1);
}

function testElegir() {
    const { proveedores } = resumirFrescura(filas, ahora);
    // Sin lista: los viejos que se pueden scrapear y no están corriendo
    assert.deepStrictEqual(elegirParaActualizar(proveedores).map(p => p.supplier_id).sort(), [2, 3]);
    // Con lista: aunque esté fresco, pero nunca uno en curso ni uno apagado
    assert.deepStrictEqual(elegirParaActualizar(proveedores, [1, 4, 5]).map(p => p.supplier_id), [1]);
    assert.deepStrictEqual(elegirParaActualizar(proveedores, []).map(p => p.supplier_id).sort(), [2, 3]);
}

testResumen();
testElegir();
console.log('✅ preciosFrescos: todos los casos pasan');
process.exit(0);
