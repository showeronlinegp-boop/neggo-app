// Estado del backup y pedido manual, sobre una carpeta temporal. Sin base ni Drive.
// node backend/services/backupService.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estado, pedirBackup, SERVICIO_VIVO_SEG } = require('./backupService');

const NOW = Date.parse('2026-10-20T13:00:00Z');
const NOW_SEG = NOW / 1000;

function carpeta() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'neggo-backup-'));
}

function escribir(dir, nombre, contenido) {
    fs.writeFileSync(path.join(dir, nombre), typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
}

async function testSinServicio() {
    const dir = carpeta();
    const e = await estado({ dir, now: NOW });
    assert.strictEqual(e.servicio_activo, false);
    assert.strictEqual(e.drive_configurado, null);
    assert.deepStrictEqual(e.backups, []);
    await assert.rejects(pedirBackup('admin', { dir, now: NOW }), err => err.statusCode === 409 && /no está corriendo/.test(err.message));
    assert.ok(!fs.existsSync(path.join(dir, '.manual-request')));
}

async function testServicioViejo() {
    const dir = carpeta();
    escribir(dir, '.estado', { visto: NOW_SEG - SERVICIO_VIVO_SEG - 1, drive_configurado: true, proximo: NOW_SEG + 3600 });
    escribir(dir, '.manual-status', { estado: 'corriendo', inicio: NOW_SEG - 600, fin: null, mensaje: '' });
    const e = await estado({ dir, now: NOW });
    assert.strictEqual(e.servicio_activo, false);
    assert.strictEqual(e.en_curso, false, 'un corriendo de un servicio caído no cuenta');
}

async function testEstadoCompleto() {
    const dir = carpeta();
    escribir(dir, '.estado', { visto: NOW_SEG - 5, drive_configurado: false, proximo: NOW_SEG + 7200 });
    escribir(dir, 'neggo_app_2026-10-09.dump', 'aa');
    escribir(dir, 'neggo_app_2026-10-16.dump', 'bbbb');
    escribir(dir, '.neggo_app_2026-10-20.dump.partial', 'x');
    escribir(dir, 'otra-cosa.txt', 'x');
    escribir(dir, '.manual-status', { estado: 'error', inicio: NOW_SEG - 60, fin: NOW_SEG - 50, mensaje: 'Falta DRIVE_FOLDER_ID' });
    const e = await estado({ dir, now: NOW });
    assert.strictEqual(e.servicio_activo, true);
    assert.strictEqual(e.drive_configurado, false);
    assert.strictEqual(e.proximo_auto, new Date((NOW_SEG + 7200) * 1000).toISOString());
    assert.deepStrictEqual(e.backups.map(b => b.nombre), ['neggo_app_2026-10-16.dump', 'neggo_app_2026-10-09.dump']);
    assert.strictEqual(e.backups[0].bytes, 4);
    assert.strictEqual(e.ultimo_manual.estado, 'error');
    assert.strictEqual(e.ultimo_manual.mensaje, 'Falta DRIVE_FOLDER_ID');
    assert.strictEqual(e.en_curso, false);
}

async function testPedido() {
    const dir = carpeta();
    escribir(dir, '.estado', { visto: NOW_SEG, drive_configurado: true, proximo: NOW_SEG + 60 });
    const e = await pedirBackup('mariano', { dir, now: NOW });
    assert.strictEqual(e.pedido_pendiente, true);
    const pedido = JSON.parse(fs.readFileSync(path.join(dir, '.manual-request'), 'utf8'));
    assert.strictEqual(pedido.usuario, 'mariano');

    // Un segundo pedido mientras el primero espera
    await assert.rejects(pedirBackup('otro', { dir, now: NOW }), err => err.statusCode === 409);

    // Tomado por db-backup: sigue sin dejar pedir otro
    fs.renameSync(path.join(dir, '.manual-request'), path.join(dir, '.manual-running'));
    const corriendo = await estado({ dir, now: NOW });
    assert.strictEqual(corriendo.en_curso, true);
    await assert.rejects(pedirBackup('otro', { dir, now: NOW }), err => err.statusCode === 409);
}

(async () => {
    await testSinServicio();
    await testServicioViejo();
    await testEstadoCompleto();
    await testPedido();
    console.log('✅ backupService: todos los casos pasan');
    process.exit(0);
})().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
