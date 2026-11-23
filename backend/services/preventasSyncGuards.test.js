// Protecciones del Sync Preventas. Sin DB ni Odoo.
// node backend/services/preventasSyncGuards.test.js
// Los casos salen de datos reales encontrados en la auditoría del 2026-10-20.

const assert = require('assert');
const {
    codigoEnNombre, motivoSinPrecio, motivoSinCategoria, categoriaPublicacion, claveCategoria,
    motivoOmitir, motivoRevision, tipoRevision, motivoOdoo, motivoSinFoto, motivoBloqueo,
} = require('./preventasSyncGuards');

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
        // Regla de categoría del proveedor (para crear, activar o publicar)
        odoo_categ_id_preventas: 40,
        regla_categoria_preventas: 'Bazar',
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
test('ZLE (raw_price NULL) queda marcado en la lista y bloqueado al aplicar', () => {
    const zle = { estado: 'solo_scraper', scraper_sku: 'PREZLBLG03', scraper_name: 'Glitter x12u', costo: null, precio_preventas: null };
    assert.match(motivoSinPrecio(zle), /no se sincroniza/);
    assert.match(motivoOmitir(zle), /no se sincroniza/);
    assert.match(motivoSinPrecio({ ...zle, estado: 'precio_baja', costo: '0' , precio_preventas: '0' }), /no se sincroniza/);
    // Activar sin precio lo pondría a la venta con el precio viejo de Odoo (1002 casos de ZLE)
    assert.match(motivoSinPrecio({ ...zle, estado: 'activar' }), /no se sincroniza/);
    // Archivar no depende del precio
    assert.strictEqual(motivoSinPrecio({ ...zle, estado: 'inactivar' }), null);
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
test('activar con precio y archivar sin scraper se aplican', () => {
    assert.strictEqual(motivoOmitir(fila({ estado: 'activar' })), null);
    assert.strictEqual(motivoOmitir({ estado: 'solo_odoo', supplier_product_id: null, proveedor_scrapeando: false }), null);
});

// ─── Categoría para crear / activar / publicar (nota 200) ────────────────────
const sinRegla = { odoo_categ_id_preventas: null, regla_categoria_preventas: null };
test('crear sin regla de categoría de Preventas no se hace', () => {
    assert.match(motivoOmitir(fila({ estado: 'solo_scraper', ...sinRegla })), /Falta la categoría de Preventas/);
    // Crear siempre necesita la regla: no hay categoría en Odoo todavía
    assert.match(motivoSinCategoria(fila({ estado: 'solo_scraper', ...sinRegla, odoo_categoria: 'Bazar' })), /Falta la categoría/);
    assert.strictEqual(motivoSinCategoria(fila({ estado: 'solo_scraper' })), null);
});
test('activar o publicar sin regla usa la categoría que ya tiene en Odoo', () => {
    assert.strictEqual(motivoSinCategoria(fila({ estado: 'publicar', ...sinRegla, odoo_categoria: 'Tecnología' })), null);
    assert.strictEqual(categoriaPublicacion(fila({ estado: 'activar', ...sinRegla, odoo_categoria: 'Tecnología' })), 'Tecnología');
    // "All" es la categoría por defecto de Odoo: no cuenta
    assert.match(motivoSinCategoria(fila({ estado: 'publicar', ...sinRegla, odoo_categoria: 'All' })), /Falta la categoría/);
    assert.match(motivoSinCategoria(fila({ estado: 'activar', ...sinRegla, odoo_categoria: 'All / Saleable' })), /Falta la categoría/);
    assert.match(motivoOmitir(fila({ estado: 'publicar', ...sinRegla, odoo_categoria: '' })), /Falta la categoría/);
});
test('la categoría web se encuentra por nombre aunque cambien acentos o el "de"', () => {
    assert.strictEqual(claveCategoria('Accesorios de Moda'), claveCategoria('Accesorios Moda'));
    assert.strictEqual(claveCategoria('Tecnologia'), claveCategoria('Tecnología'));
    assert.strictEqual(claveCategoria('All / Hogar / Bazar'), 'bazar');
    assert.strictEqual(claveCategoria('navidad'), claveCategoria('Navidad'));
    assert.notStrictEqual(claveCategoria('Insumos'), claveCategoria('Insumos de Comercios'));
    assert.strictEqual(claveCategoria(null), '');
});
test('la regla manda sobre la categoría de Odoo', () => {
    assert.strictEqual(categoriaPublicacion(fila({ estado: 'publicar', odoo_categoria: 'Tecnología' })), 'Bazar');
});
test('cambiar precio y archivar no piden categoría', () => {
    assert.strictEqual(motivoSinCategoria(fila({ ...sinRegla })), null);
    assert.strictEqual(motivoSinCategoria({ estado: 'inactivar', ...sinRegla }), null);
    assert.strictEqual(motivoOmitir(fila({ ...sinRegla })), null);
});
test('publicar no pide precio del proveedor (ya está a la venta con el de Odoo)', () => {
    assert.strictEqual(motivoSinPrecio(fila({ estado: 'publicar', costo: null, precio_preventas: null })), null);
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
test('vínculo confirmado en la tabla maestra no pide revisar la identidad (nota 143)', () => {
    assert.strictEqual(motivoRevision(fila({ match_type: 'fuzzy_name', match_score: '78.72', estado: 'activar', vinculo_confirmado: true })), null);
    assert.strictEqual(motivoRevision(fila({
        match_type: 'fuzzy_name', match_score: '95', vinculo_confirmado: true,
        scraper_name: 'MOCHILITA INFANTIL {MAB86}', odoo_nombre: 'MOCHILITA INFANTIL (MAB96)',
    })), null);
    // El cambio de costo grande se sigue revisando aunque el vínculo esté confirmado
    assert.match(motivoRevision(fila({ match_type: 'fuzzy_name', match_score: '78', vinculo_confirmado: true, costo: '24434.10', odoo_standard_price: '12217.05' })), /\+100\.0%/);
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
test('aceptar cambios de costo en bloque no saltea un vínculo dudoso (nota 145)', () => {
    const costoGrande = { costo: '24434.10', odoo_standard_price: '12217.05' };
    assert.strictEqual(motivoRevision(fila(costoGrande), { aceptarCambioCosto: true }), null);
    assert.match(motivoRevision(fila({ ...costoGrande, match_type: 'fuzzy_name', match_score: '78' }), { aceptarCambioCosto: true }), /nombre parecido/);
    assert.match(motivoRevision(fila({
        ...costoGrande, scraper_name: 'MOCHILITA {MAB86}', odoo_nombre: 'MOCHILITA (MAB96)',
    }), { aceptarCambioCosto: true }), /no coincide/);
});
test('tipoRevision distingue vínculo dudoso de cambio de costo', () => {
    assert.strictEqual(tipoRevision(fila()), null);
    assert.strictEqual(tipoRevision(fila({ costo: '1500.00' })), 'costo');
    // Si pasan las dos cosas, manda el vínculo (no se acepta en bloque)
    assert.strictEqual(tipoRevision(fila({ costo: '1500.00', match_type: 'fuzzy_name', match_score: '70' })), 'vinculo');
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
test('publicar algo archivado o ya publicado no hace nada', () => {
    assert.match(motivoOdoo(fila({ estado: 'publicar' }), { standard_price: 1000, active: false, is_published: false }), /archivado/);
    assert.match(motivoOdoo(fila({ estado: 'publicar' }), { standard_price: 1000, active: true, is_published: true }), /Ya está publicado/);
    assert.strictEqual(motivoOdoo(fila({ estado: 'publicar' }), { standard_price: 1000, active: true, is_published: false }), null);
});
test('crear no consulta este control (no hay producto en Odoo todavía)', () => {
    assert.strictEqual(motivoOdoo(fila({ estado: 'solo_scraper' }), null), null);
});

test('crear sin foto del proveedor ni de Neggo se bloquea (nota 203)', () => {
    const nuevo = fila({ estado: 'solo_scraper', sin_foto_disponible: true });
    assert.match(motivoSinFoto(nuevo), /Sin foto/);
    assert.match(motivoBloqueo(nuevo), /Sin foto/);
    assert.match(motivoOmitir(nuevo), /Sin foto/);
    assert.strictEqual(motivoSinFoto(fila({ estado: 'solo_scraper', sin_foto_disponible: false })), null);
    // Solo frena crear: los demás estados no miran la foto
    assert.strictEqual(motivoSinFoto(fila({ estado: 'precio_sube', sin_foto_disponible: true })), null);
});
test('archivar por falta de foto no se hace si Odoo ya tiene foto (nota 203)', () => {
    assert.match(motivoOdoo(fila({ estado: 'sin_foto' }), { standard_price: 1000, active: true, tiene_foto: true }), /Ya tiene foto/);
    assert.match(motivoOdoo(fila({ estado: 'sin_foto' }), { standard_price: 1000, active: false }), /Ya está archivado/);
    assert.strictEqual(motivoOdoo(fila({ estado: 'sin_foto' }), { standard_price: 1000, active: true }), null);
    assert.match(motivoOdoo(fila({ estado: 'sin_foto' }), null), /ya no existe/);
});
console.log(`\n✅ ${pasaron} tests OK`);
