// Tests del vigía de WhatsApp (nota 247). Sin Docker ni red.
// node tools/vigia-whatsapp/reglasVigia.test.js

const assert = require('assert');
const r = require('./reglasVigia');

const cab = (t, msg) => `\x1b[1m[Evolution API]\x1b[0m [neggo-negocio] v2.3.7 241 - ${t}   INFO   [ChannelStartupService]  [string]  ${msg}`;

// Señales
assert.deepStrictEqual(r.senalesDe(cab('x', 'Browser: Evolution API,Chrome,6.18')), ['conexiones']);
assert.deepStrictEqual(r.senalesDe('Error: rate-overlimit'), ['limite']);
assert.deepStrictEqual(r.senalesDe(cab('x', 'Updating cache for group: 1203@g.us')), ['grupos']);
assert.deepStrictEqual(r.senalesDe(cab('x', 'Parche Neggo: conexión cerrada (código 428), reintento 2 en 10 s')), ['cierres']);
assert.deepStrictEqual(r.senalesDe(cab('x', 'Baileys version: 2.3000')), []);

// La tormenta del 22/11 (25 conexiones por segundo) corta
{
    const ahora = Date.parse('2026-11-22T21:50:30Z');
    const lineas = Array.from({ length: 25 }, (_, k) => ({ t: ahora - k * 40, linea: cab('x', 'Browser: Evolution API') }));
    const v = r.acumular([], lineas, ahora);
    const ev = r.evaluar(v);
    assert.strictEqual(ev.nivel, 'cortar');
    assert.match(ev.motivos[0], /conexiones: 25/);
}

// Un despertar normal (2 conexiones) no dice nada; 6 avisa; los viejos salen de la ventana
{
    const ahora = 10 * 60 * 1000;
    const dos = [{ t: ahora - 1000, linea: 'Browser: a' }, { t: ahora - 500, linea: 'Browser: a' }];
    assert.strictEqual(r.evaluar(r.acumular([], dos, ahora)).nivel, 'normal');
    const seis = Array.from({ length: 6 }, (_, k) => ({ t: ahora - k * 1000, linea: 'Browser: a' }));
    assert.strictEqual(r.evaluar(r.acumular([], seis, ahora)).nivel, 'aviso');
    const viejos = Array.from({ length: 30 }, () => ({ t: ahora - r.VENTANA_MS - 1, linea: 'Browser: a' }));
    assert.strictEqual(r.evaluar(r.acumular([], viejos, ahora)).nivel, 'normal');
}

// Tres rate-overlimit cortan; una desvinculación corta sola
{
    const tres = Array.from({ length: 3 }, () => ({ t: 1000, linea: 'Error: rate-overlimit' }));
    assert.strictEqual(r.evaluar(r.acumular([], tres, 2000)).nivel, 'cortar');
    assert.strictEqual(r.evaluar(r.acumular([], [{ t: 1000, linea: 'message: Log out instance: neggo-negocio' }], 2000)).nivel, 'cortar');
}

// El reporte no lleva contenido de mensajes
{
    const lineas = [
        { linea: cab('x', 'Browser: a') },
        { linea: '  "conversation": "hola, ¿tenés stock?"' },
        { linea: 'Error: rate-overlimit' },
        { linea: '    at query (socket.js:127:13)' },
    ];
    const rep = r.lineasParaReporte(lineas).join('\n');
    assert.ok(rep.includes('Browser: a'));
    assert.ok(rep.includes('rate-overlimit'));
    assert.ok(!rep.includes('stock'));
}

// Stream de Docker con cabeceras de 8 bytes
{
    const bloque = (txt) => {
        const b = Buffer.from(txt);
        const h = Buffer.alloc(8);
        h[0] = 1;
        h.writeUInt32BE(b.length, 4);
        return Buffer.concat([h, b]);
    };
    const buf = Buffer.concat([bloque('hola\n'), bloque('chau\n'), bloque('cor').subarray(0, 9)]);
    const { texto, resto } = r.desmultiplexar(buf);
    assert.strictEqual(texto, 'hola\nchau\n');
    assert.strictEqual(resto.length, 9);
}

// Timestamps de Docker: se comparan bien aunque recorte ceros
{
    const a = r.separarTimestamp('2026-11-23T13:41:56.1Z linea');
    const b = r.separarTimestamp('2026-11-23T13:41:56.123456789Z otra');
    assert.strictEqual(a.ts, '2026-11-23T13:41:56.100000000Z');
    assert.ok(b.ts > a.ts);
    assert.strictEqual(b.linea, 'otra');
    assert.strictEqual(r.separarTimestamp('sin fecha'), null);
    assert.strictEqual(r.normalizarTs('2026-11-23T13:41:56Z'), '2026-11-23T13:41:56.000000000Z');
}

console.log('✅ reglasVigia: todo OK');
