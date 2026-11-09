// Fotos guardadas en /storage (nota 175). Sin DB ni Odoo.
// node backend/services/fotoStorage.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { esFotoStorage, rutaEnDisco, leerFotoStorage, urlDescargable } = require('./fotoStorage');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-storage-'));
    fs.mkdirSync(path.join(root, 'photos', 'panlin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'photos', 'panlin', 'prepl0030.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x01]));

    assert.strictEqual(esFotoStorage('/storage/photos/panlin/prepl0030.jpg'), true);
    assert.strictEqual(esFotoStorage('https://web.com/a.jpg'), false);
    assert.strictEqual(esFotoStorage(null), false);

    // Lee la foto del disco
    const buf = await leerFotoStorage('/storage/photos/panlin/prepl0030.jpg', root);
    assert.deepStrictEqual([...buf], [0xff, 0xd8, 0xff, 0x01]);

    // No existe → null (no rompe la sincronización)
    assert.strictEqual(await leerFotoStorage('/storage/photos/panlin/nada.jpg', root), null);

    // No se puede salir de la carpeta
    assert.strictEqual(rutaEnDisco('/storage/../../etc/passwd', root), null);
    assert.strictEqual(rutaEnDisco('/storage/%2e%2e/secreto', root), null);
    assert.strictEqual(await leerFotoStorage('/storage/../secreto', root), null);

    // "//cdn..." sin protocolo
    assert.strictEqual(urlDescargable('//cdn.x.com/a.jpg'), 'https://cdn.x.com/a.jpg');
    assert.strictEqual(urlDescargable('https://x.com/a.jpg'), 'https://x.com/a.jpg');

    fs.rmSync(root, { recursive: true, force: true });
    console.log('✅ fotoStorage: todo OK');
})().catch(err => { console.error('❌', err); process.exit(1); });
