// Formato de fotos para Odoo: AVIF → JPG (nota 183). Sin red ni Postgres.
// node backend/services/fotoFormato.test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const { fotoCompatible, fotoCompatibleBase64, esAvif, esHtml, conAvifdec } = require('./fotoFormato');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3)]);
// Cabecera como la de https://alifcell.com/fotos/34561.jpg (AVIF con nombre .jpg)
const AVIF_FALSO = Buffer.concat([Buffer.from('000000186674797061766966000000006d6966316d696166', 'hex'), Buffer.alloc(40)]);
const HTML = Buffer.from('<!DOCTYPE html><html><body>No encontrado</body></html>');

function haySharp() {
    try { require('sharp'); return true; } catch { return false; }
}
function hayAvifdec() {
    try { execFileSync('avifdec', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function rechaza(promesa, regex) {
    await assert.rejects(promesa, (err) => {
        assert.match(err.message, regex);
        assert.strictEqual(err.status, 502);
        return true;
    });
}

(async () => {
    // 1. Detección
    assert.strictEqual(esAvif(AVIF_FALSO), true);
    assert.strictEqual(esAvif(JPEG), false);
    assert.strictEqual(esHtml(HTML), true);
    assert.strictEqual(esHtml(JPEG), false);

    // 2. Lo que Odoo ya toma pasa igual, sin convertir
    const j = await fotoCompatible(JPEG, { convertidores: [() => { throw new Error('no debería convertir'); }] });
    assert.deepStrictEqual([j.mime, j.convertida, j.buffer], ['image/jpeg', false, JPEG]);
    assert.strictEqual(await fotoCompatibleBase64(PNG.toString('base64')), PNG.toString('base64'));

    // 3. AVIF: si el primer convertidor falla se prueba el siguiente
    const usados = [];
    const r = await fotoCompatible(AVIF_FALSO, {
        convertidores: [
            async () => { usados.push('sharp'); throw new Error('heif: Bitstream not supported'); },
            async () => { usados.push('avifdec'); return JPEG; },
        ],
    });
    assert.deepStrictEqual(usados, ['sharp', 'avifdec']);
    assert.deepStrictEqual([r.mime, r.convertida], ['image/jpeg', true]);
    assert.strictEqual(await fotoCompatibleBase64(AVIF_FALSO.toString('base64'), { convertidores: [async () => JPEG] }),
        JPEG.toString('base64'));

    // 4. AVIF que nadie puede convertir, o que no sale JPG: error claro
    await rechaza(fotoCompatible(AVIF_FALSO, { convertidores: [async () => { throw new Error('x'); }, async () => HTML] }),
        /formato AVIF y no se pudo pasar a JPG/);

    // 5. Lo que no es foto dice qué llegó
    await rechaza(fotoCompatible(HTML), /devolvió una página en vez de la foto/);
    await rechaza(fotoCompatible(Buffer.from('cualquier cosa')), /no es una foto/);
    await rechaza(fotoCompatible(Buffer.alloc(0)), /archivo vacío/);

    // 6. De verdad: un AVIF de 8 bits hecho con sharp se convierte con los convertidores reales
    if (haySharp()) {
        const sharp = require('sharp');
        const avif = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } } })
            .avif().toBuffer();
        assert.strictEqual(esAvif(avif), true);
        const real = await fotoCompatible(avif);
        assert.deepStrictEqual([real.mime, real.convertida], ['image/jpeg', true]);
        const { width } = await sharp(real.buffer).metadata();
        assert.strictEqual(width, 32);

        // 7. avifdec solo (lo que se usa con los AVIF de 10 bits que sharp no lee)
        if (hayAvifdec()) {
            const soloAvifdec = await fotoCompatible(avif, { convertidores: [conAvifdec] });
            assert.deepStrictEqual([soloAvifdec.mime, soloAvifdec.convertida], ['image/jpeg', true]);
        } else {
            console.log('⚠️ Sin avifdec: no se prueba la conversión con avifdec');
        }
    } else {
        console.log('⚠️ Sin sharp: no se prueba la conversión real');
    }

    console.log('✅ fotoFormato: todo OK');
})().catch((err) => { console.error('❌', err); process.exit(1); });
