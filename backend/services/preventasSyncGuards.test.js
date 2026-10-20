// Protecciones del Sync Preventas. Sin DB ni Odoo.
// node backend/services/preventasSyncGuards.test.js
// Los casos salen de datos reales encontrados en la auditoría del 2026-10-20.

const assert = require('assert');
const { codigoEnNombre, motivoOmitir, motivoRevision, motivoOdoo } = require('./preventasSyncGuards');

// Fila típica de un cambio de precio correcto: todo coincide y el cambio es chico
function fila(overrides = {}) {
    return {
        estado: 'precio_sube',
        supplier_product_id: 10,
        sp_existe: true,
        proveedor_scrapeando: false,
        match_type: 'exact_sku',
        match_score: 100,
        scraper_sku: 'PRECTWB494',
        scraper_name: 'ESPEJO C/ PIE {WB494} FLOR 17.5CM',
        odoo_nombre: 'ESPEJO C PIE {WB494} FLOR 175CM Art. CT175',
        costo: '1100.00',
        precio_preventas: '1500.00',
        costo_actual: '1100.00',
        precio_actual: '1500.00',
        odoo_standard_price: '1000.00',
        ...overrides,
    };
}

let pasaron = 0;
function test(nombre, fn) {
    fn();
    pasaron++;
    console.log(`✅ ${nombre}`);
}

// ─── codigoEnNombre ──────────────────────────────────────────────────────────
test('extrae el código entre {} o () normalizado', () => {
    assert.strictEqual(codigoEnNombre('PEINE (MAB07) COLA FINO'), 'MAB07');
    assert.strictEqual(codigoEnNombre('VASO CHOPP (FH-105) ACRILICO'), 'FH105');
    assert.strictEqual(codigoEnNombre('MORDILLO {WB266} TRIANGULO'), 'WB266');
});
test('una cantidad entre paréntesis no es un código', () => {
    assert.strictEqual(codigoEnNombre('CUBETERA (144) X2 PLASTICA'), null);
    assert.strictEqual(codigoEnNombre('REC. RESIDUOS (712111.01)'), null);
    assert.strictEqual(codigoEnNombre('SIN CODIGO'), null);
    assert.strictEqual(codigoEnNombre(null), null);
});

// ─── motivoOmitir ────────────────────────────────────────────────────────────
test('un cambio de precio normal no se omite', () => {
    assert.strictEqual(motivoOmitir(fila()), null);
});
test('nunca escribir precio 0 (vaso de Cast con precio 0 en la web)', () => {
    assert.match(motivoOmitir(fila({ estado: 'precio_baja', costo: '0.00', precio_preventas: '0.00', costo_actual: '0', precio_actual: '0' })), /Sin precio válido/);
});
test('nunca crear sin precio (ZLE sin login devuelve precio vacío)', () => {
    assert.match(motivoOmitir(fila({ estado: 'solo_scraper', costo: null, precio_preventas: null })), /Sin precio válido/);
});
test('si el precio scrapeado cambió desde el cálculo, no aplicar lo viejo', () => {
    assert.match(motivoOmitir(fila({ costo_actual: '1300.00', precio_actual: '1800.00' })), /cambió desde el último cálculo/);
});
test('si el producto se borró del scraper, no aplicar', () => {
    assert.match(motivoOmitir(fila({ sp_existe: false, costo_actual: null, precio_actual: null })), /ya no está en el scraper/);
});
test('si se está scrapeando el proveedor, esperar', () => {
    assert.match(motivoOmitir(fila({ proveedor_scrapeando: true })), /scrapeando/);
});
test('crear exige SKU y nombre', () => {
    assert.match(motivoOmitir(fila({ estado: 'solo_scraper', scraper_sku: null })), /SKU/);
    assert.match(motivoOmitir(fila({ estado: 'solo_scraper', scraper_name: '  ' })), /nombre/);
});
test('activar/inactivar no dependen del precio', () => {
    assert.strictEqual(motivoOmitir(fila({ estado: 'activar', costo: null, precio_preventas: null })), null);
    assert.strictEqual(motivoOmitir({ estado: 'solo_odoo', supplier_product_id: null, proveedor_scrapeando: false }), null);
});

// ─── motivoRevision ──────────────────────────────────────────────────────────
test('cambio de costo de hasta 20% se aplica en bloque', () => {
    assert.strictEqual(motivoRevision(fila({ costo: '1200.00' })), null);   // +20%
    assert.strictEqual(motivoRevision(fila({ costo: '800.00', estado: 'precio_baja' })), null); // -20%
});
test('cambio de costo de más de 20% requiere revisión (labial de Cast al doble)', () => {
    assert.match(motivoRevision(fila({ costo: '24434.10', odoo_standard_price: '12217.05' })), /\+100\.0%/);
    assert.match(motivoRevision(fila({ estado: 'precio_baja', costo: '700.00' })), /-30\.0%/);
});
test('fuzzy por debajo de 90 requiere revisión', () => {
    assert.match(motivoRevision(fila({ match_type: 'fuzzy_name', match_score: '78.72', estado: 'activar' })), /nombre parecido/);
    assert.strictEqual(motivoRevision(fila({ match_type: 'fuzzy_name', match_score: '92' })), null);
});
test('códigos distintos en el nombre requieren revisión (MAB86 ≠ MAB96)', () => {
    const r = motivoRevision(fila({
        match_type: 'fuzzy_name', match_score: '95',
        scraper_name: 'MOCHILITA INFANTIL {MAB86} PERSONAJE ANIMADO',
        odoo_nombre: 'MOCHILITA INFANTIL (MAB96) PERSONAJE ANIMADO Art',
    }));
    assert.match(r, /MAB86 en el proveedor, MAB96 en Odoo/);
});
test('mismo código con distinta puntuación no requiere revisión', () => {
    assert.strictEqual(motivoRevision(fila({
        scraper_name: 'PELAPAPA PELADOR {CTE-012} ANCHO', odoo_nombre: 'PELAPAPA PELADOR {CTE012} ANCHO',
    })), null);
});

// ─── motivoOdoo ──────────────────────────────────────────────────────────────
test('no pisar un costo cambiado a mano en Odoo', () => {
    assert.match(motivoOdoo(fila(), { standard_price: 1050, active: true }), /cambió en Odoo/);
    assert.strictEqual(motivoOdoo(fila(), { standard_price: 1000, active: true }), null);
});
test('producto borrado de Odoo', () => {
    assert.match(motivoOdoo(fila(), null), /ya no existe en Odoo/);
});
test('activar/archivar algo que ya está así no hace nada', () => {
    assert.match(motivoOdoo(fila({ estado: 'activar' }), { standard_price: 1000, active: true }), /Ya está activo/);
    assert.match(motivoOdoo(fila({ estado: 'solo_odoo' }), { standard_price: 1000, active: false }), /Ya está archivado/);
    assert.strictEqual(motivoOdoo(fila({ estado: 'activar' }), { standard_price: 1000, active: false }), null);
});
test('crear no consulta este control (no hay producto en Odoo todavía)', () => {
    assert.strictEqual(motivoOdoo(fila({ estado: 'solo_scraper' }), null), null);
});

console.log(`\n✅ ${pasaron} tests OK`);
