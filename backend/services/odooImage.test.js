// Cache de fotos Odoo: disco + fingerprint. Sin red ni Postgres.
// node backend/services/odooImage.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    getOdooImage,
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

async function run() {
    testHelpers();
    await testFetchAndPersist();
    await testLocalHitSkipsBinary();
    await testRefreshWhenOdooChanges();
    await testFallbackWhenOdooDown();
    await testMissingImageClearsLocal();
    console.log('✅ odooImage: todos los tests pasaron');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
