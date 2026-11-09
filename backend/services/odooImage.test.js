// Cache de fotos Odoo: disco + fingerprint. Sin red ni Postgres.
// node backend/services/odooImage.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    getOdooImage,
    writeOdooImage,
    leerFotoDeOrigen,
    hashBuffer,
    detectContentType,
    etagMatches,
    shouldUseLocal,
} = require('./odooImageService');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 1)]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 2)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 3)]);

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-img-'));
}

function mockOdoo({ writeDate = '2026-01-01 12:00:00', images = {}, down = false } = {}) {
    const calls = [];
    async function callOdoo(model, method, args, kwargs) {
        calls.push({ model, method, args, kwargs });
        if (down) throw new Error('Odoo caído');
        if (method === 'read') {
            const id = args[0][0];
            const fields = args[1] || kwargs.fields || [];
            // Como Odoo real: product.template no tiene product_tmpl_id.
            if (model === 'product.template' && fields.includes('product_tmpl_id')) {
                throw new Error("Invalid field 'product_tmpl_id' on 'product.template'");
            }
            const row = { id, write_date: writeDate, product_tmpl_id: [99, 'T'] };
            for (const f of fields) {
                if (f.startsWith('image_')) {
                    const key = `${model}:${id}:${f}`;
                    row[f] = images[key] !== undefined ? images[key] : images[f] || false;
                }
            }
            return [row];
        }
        throw new Error(`callOdoo no mockeado: ${model}.${method}`);
    }
    return {
        calls,
        callOdoo,
        getCompanyIds: async () => ({ neggo: 7, preventas: 8 }),
        // Sin memoria de verificación: cada pedido vuelve a comparar con Odoo (nota 146)
        verificacionMs: 0,
    };
}

function testHelpers() {
    assert.strictEqual(detectContentType(JPEG), 'image/jpeg');
    assert.strictEqual(detectContentType(PNG), 'image/png');
    assert.strictEqual(etagMatches('"abc"', 'abc'), true);
    assert.strictEqual(etagMatches('W/"abc"', 'abc'), true);
    assert.strictEqual(etagMatches('"zzz"', 'abc'), false);
    assert.strictEqual(shouldUseLocal({ fingerprint: 'x' }, 'x'), true);
    assert.strictEqual(shouldUseLocal({ fingerprint: 'x' }, 'y'), false);
    assert.strictEqual(shouldUseLocal(null, 'x'), false);
    console.log('helpers ok');
}

async function testFetchAndPersist() {
    const root = tmpRoot();
    const odoo = mockOdoo({
        images: { 'product.product:68290:image_128': JPEG.toString('base64') },
    });
    const img = await getOdooImage(
        { kind: 'product', company: 'neggo', id: 68290, size: '128' },
        { ...odoo, storageRoot: root }
    );
    assert.strictEqual(img.contentType, 'image/jpeg');
    assert.strictEqual(img.hash, hashBuffer(JPEG));
    assert.strictEqual(img.fromCache, false);
    assert.ok(img.buffer.equals(JPEG));
    const disk = path.join(root, 'photos', 'odoo', 'neggo', 'neggo-product-68290-128.jpg');
    assert.ok(fs.existsSync(disk), 'tiene que quedar el jpg en disco');
    const reads = odoo.calls.filter((c) => c.method === 'read' && (c.args[1] || []).some((f) => String(f).startsWith('image_')));
    assert.strictEqual(reads.length, 1);
    console.log('primera carga pide Odoo y guarda en disco ok');
}

async function testLocalHitSkipsBinary() {
    const root = tmpRoot();
    const first = mockOdoo({
        writeDate: '2026-01-01 12:00:00',
        images: { 'product.product:10:image_128': JPEG.toString('base64') },
    });
    await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        { ...first, storageRoot: root }
    );
    const second = mockOdoo({ writeDate: '2026-01-01 12:00:00', images: {} });
    const img = await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        { ...second, storageRoot: root }
    );
    assert.strictEqual(img.fromCache, true);
    assert.ok(img.buffer.equals(JPEG));
    const reads = second.calls.filter((c) => c.method === 'read' && (c.args[1] || []).some((f) => String(f).startsWith('image_')));
    assert.strictEqual(reads.length, 0, 'si el fingerprint no cambió no hay que bajar el binario');
    console.log('segunda carga usa disco si Odoo no cambió ok');
}

async function testRefreshWhenOdooChanges() {
    const root = tmpRoot();
    await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        {
            ...mockOdoo({ writeDate: '2026-01-01 12:00:00', images: { 'product.product:10:image_128': JPEG.toString('base64') } }),
            storageRoot: root,
        }
    );
    const img = await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        {
            ...mockOdoo({ writeDate: '2026-02-02 12:00:00', images: { 'product.product:10:image_128': JPEG2.toString('base64') } }),
            storageRoot: root,
        }
    );
    assert.strictEqual(img.fromCache, false);
    assert.ok(img.buffer.equals(JPEG2));
    assert.strictEqual(img.hash, hashBuffer(JPEG2));
    const disk = fs.readFileSync(path.join(root, 'photos', 'odoo', 'neggo', 'neggo-product-10-128.jpg'));
    assert.ok(disk.equals(JPEG2), 'el archivo local tiene que quedar con la foto nueva');
    console.log('si Odoo cambia se pisa la copia local ok');
}

async function testFallbackWhenOdooDown() {
    const root = tmpRoot();
    await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        {
            ...mockOdoo({ images: { 'product.product:10:image_128': JPEG.toString('base64') } }),
            storageRoot: root,
        }
    );
    const img = await getOdooImage(
        { kind: 'product', company: 'neggo', id: 10, size: '128' },
        { ...mockOdoo({ down: true }), storageRoot: root }
    );
    assert.strictEqual(img.fromCache, true);
    assert.ok(img.buffer.equals(JPEG));
    console.log('si Odoo está caído se sirve la copia de disco ok');
}

async function testMissingImageClearsLocal() {
    const root = tmpRoot();
    await getOdooImage(
        { kind: 'template', company: 'neggo', id: 99, size: '128' },
        {
            ...mockOdoo({ writeDate: '2026-01-01 12:00:00', images: { 'product.template:99:image_128': JPEG.toString('base64') } }),
            storageRoot: root,
        }
    );
    const img = await getOdooImage(
        { kind: 'template', company: 'neggo', id: 99, size: '128' },
        {
            ...mockOdoo({ writeDate: '2026-03-03 12:00:00', images: { 'product.template:99:image_128': false } }),
            storageRoot: root,
        }
    );
    assert.strictEqual(img, null);
    const disk = path.join(root, 'photos', 'odoo', 'neggo', 'neggo-template-99-128.jpg');
    assert.strictEqual(fs.existsSync(disk), false);
    console.log('si Odoo ya no tiene foto se borra la local ok');
}

// Nota 146: comparada con Odoo hace poco → se sirve del disco sin llamar a Odoo
async function testVerificadaHacePocoNoLlamaOdoo() {
    const root = tmpRoot();
    let reloj = 1_000_000;
    const memoria = { storageRoot: root, verificadas: new Map(), verificacionMs: 10 * 60 * 1000, ahora: () => reloj };
    const opts = { kind: 'template', company: 'neggo', id: 99, size: '128' };

    await getOdooImage(opts, {
        ...mockOdoo({ images: { 'product.template:99:image_128': JPEG.toString('base64') } }),
        ...memoria,
    });

    // 5 minutos después: ni una llamada a Odoo, aunque Odoo tenga otra foto
    reloj += 5 * 60 * 1000;
    const enseguida = mockOdoo({ writeDate: '2026-05-05 12:00:00', images: { 'product.template:99:image_128': JPEG2.toString('base64') } });
    const img1 = await getOdooImage(opts, { ...enseguida, ...memoria });
    assert.strictEqual(enseguida.calls.length, 0, 'dentro de los 10 minutos no se le pregunta a Odoo');
    assert.ok(img1.buffer.equals(JPEG));

    // Pasados los 10 minutos se vuelve a comparar y aparece la foto nueva
    reloj += 6 * 60 * 1000;
    const despues = mockOdoo({ writeDate: '2026-05-05 12:00:00', images: { 'product.template:99:image_128': JPEG2.toString('base64') } });
    const img2 = await getOdooImage(opts, { ...despues, ...memoria });
    assert.ok(despues.calls.length > 0, 'vencida la memoria se compara con Odoo');
    assert.ok(img2.buffer.equals(JPEG2));
    console.log('memoria de 10 minutos ok');
}

// Nota 146: con Odoo caído y sin copia local no se queda marcada como verificada
async function testSinCopiaSiemprePreguntaOdoo() {
    const root = tmpRoot();
    const memoria = { storageRoot: root, verificadas: new Map(), verificacionMs: 10 * 60 * 1000, ahora: () => 5 };
    const opts = { kind: 'template', company: 'neggo', id: 77, size: '128' };
    await assert.rejects(getOdooImage(opts, { ...mockOdoo({ down: true }), ...memoria }));
    const odoo = mockOdoo({ images: { 'product.template:77:image_128': PNG.toString('base64') } });
    const img = await getOdooImage(opts, { ...odoo, ...memoria });
    assert.ok(odoo.calls.length > 0);
    assert.ok(img.buffer.equals(PNG));
    console.log('sin copia local siempre se pregunta a Odoo ok');
}

// Nota 146: subir una foto desde la app olvida la memoria de todos los tamaños
async function testSubirFotoOlvidaVerificacion() {
    const root = tmpRoot();
    const memoria = { storageRoot: root, verificadas: new Map(), verificacionMs: 10 * 60 * 1000, ahora: () => 5 };
    const opts = { kind: 'template', company: 'neggo', id: 99, size: '256' };
    await getOdooImage(opts, {
        ...mockOdoo({ images: { 'product.template:99:image_256': JPEG.toString('base64') } }),
        ...memoria,
    });

    const nueva = mockOdoo({
        writeDate: '2026-06-06 12:00:00',
        images: {
            image_128: JPEG2.toString('base64'), image_256: JPEG2.toString('base64'),
            image_512: JPEG2.toString('base64'), image_1024: JPEG2.toString('base64'),
        },
    });
    const callOdoo = async (model, method, args, kwargs) => (method === 'write' ? true : nueva.callOdoo(model, method, args, kwargs));
    const pool = { query: async () => ({ rows: [{ image_url: '/api/products/odoo-image/neggo/99' }] }) };
    await writeOdooImage(10, JPEG2.toString('base64'), { ...nueva, callOdoo, pool, ...memoria });

    // El 256 no se baja al subir (solo 128/512/1024), pero no puede quedar la vieja 10 minutos
    const img = await getOdooImage(opts, { ...nueva, ...memoria });
    assert.ok(img.buffer.equals(JPEG2), 'después de subir la foto se ve la nueva en todos los tamaños');
    console.log('subir foto olvida la memoria ok');
}

// Las cuatro formas de image_url que hay en supplier_products (nota 165)
async function testFotoDeOrigen() {
    const base = tmpRoot();
    const storageRoot = path.join(base, 'storage');
    fs.mkdirSync(path.join(storageRoot, 'photos', 'panlin'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'photos', 'panlin', 'a.jpg'), JPEG);
    fs.writeFileSync(path.join(storageRoot, 'photos', 'panlin', 'b.txt'), 'no soy una foto');
    fs.writeFileSync(path.join(base, 'afuera.jpg'), JPEG);

    const pedidas = [];
    const fetchMock = async (url) => {
        pedidas.push(url);
        return { ok: !url.includes('roto'), status: 404, arrayBuffer: async () => PNG };
    };
    const odoo = mockOdoo({ images: { 'product.template:9:image_1920': JPEG2.toString('base64') } });
    const deps = { ...odoo, storageRoot, fetch: fetchMock };
    const rechaza = (url, status) => assert.rejects(leerFotoDeOrigen(url, deps), (err) => err.status === status);

    // Disco: es el caso que reportó la nota
    assert.ok((await leerFotoDeOrigen('/storage/photos/panlin/a.jpg', deps)).equals(JPEG));
    await rechaza('/storage/photos/panlin/no-esta.jpg', 404);
    await rechaza('/storage/photos/panlin/b.txt', 502);
    await rechaza('/storage/../afuera.jpg', 400);

    // Web: con y sin protocolo
    assert.ok((await leerFotoDeOrigen('https://cdn.test/x.png', deps)).equals(PNG));
    assert.ok((await leerFotoDeOrigen('//cdn.test/y.png', deps)).equals(PNG));
    assert.deepStrictEqual(pedidas, ['https://cdn.test/x.png', 'https://cdn.test/y.png']);
    await rechaza('https://cdn.test/roto.png', 502);

    // Odoo: el id de la ruta es el del template
    assert.ok((await leerFotoDeOrigen('/api/products/odoo-image/neggo/9', deps)).equals(JPEG2));
    await rechaza('/api/products/odoo-image/neggo/10', 404);

    // Cualquier otra cosa no llega a fetch
    await rechaza('/otra/ruta.jpg', 400);
    assert.strictEqual(pedidas.length, 3);
}

async function run() {
    testHelpers();
    await testFetchAndPersist();
    await testLocalHitSkipsBinary();
    await testRefreshWhenOdooChanges();
    await testFallbackWhenOdooDown();
    await testMissingImageClearsLocal();
    await testVerificadaHacePocoNoLlamaOdoo();
    await testSinCopiaSiemprePreguntaOdoo();
    await testSubirFotoOlvidaVerificacion();
    await testFotoDeOrigen();
    console.log('✅ odooImage: todos los tests pasaron');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
