// Tests de los parches de Evolution. Sin Docker ni red.
// node evolution/parcheEvolution.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PARCHES, parchearTexto, aplicar } = require('./parcheEvolution');

const [GET_MESSAGE, REINTENTO] = PARCHES;

// Arma una carpeta falsa de Evolution con los archivos originales.
function armarRaiz({ sinMjs = false, sinBaileys = false } = {}) {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-'));
    const main = `x;async getMessage(e){try{return o[0].message}${GET_MESSAGE.original}){};y`;
    fs.mkdirSync(path.join(raiz, 'dist'));
    fs.writeFileSync(path.join(raiz, 'dist/main.js'), main);
    if (!sinMjs) fs.writeFileSync(path.join(raiz, 'dist/main.mjs'), main);
    if (!sinBaileys) {
        const dir = path.join(raiz, 'node_modules/baileys/lib/Socket');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'messages-recv.js'), `a\n${REINTENTO.original}\nb\n`);
    }
    return raiz;
}

const callado = () => {};

// parchearTexto: aplica una vez, es idempotente y no acepta ambigüedad
{
    const r = parchearTexto(`a${GET_MESSAGE.original}b`, GET_MESSAGE);
    assert.strictEqual(r.estado, 'aplicado');
    assert.ok(r.texto.includes('catch{return void 0}'));
    assert.ok(!r.texto.includes('conversation:""'));
    assert.strictEqual(parchearTexto(r.texto, GET_MESSAGE).estado, 'ya');
    assert.throws(() => parchearTexto('nada que ver', GET_MESSAGE), /hay 0/);
    assert.throws(() => parchearTexto(GET_MESSAGE.original + GET_MESSAGE.original, GET_MESSAGE), /hay 2/);
}

// El parche de Baileys corta antes de rehacer la sesión
{
    const r = parchearTexto(REINTENTO.original, REINTENTO);
    assert.ok(r.texto.includes('if (!msgs.some(Boolean))'));
    const corte = r.texto.indexOf('return;');
    const comentarioSesion = r.texto.indexOf("// if it's the primary jid");
    assert.ok(corte > 0 && corte < comentarioSesion, 'el return tiene que quedar antes de assertSessions');
}

// El código parcheado de Baileys se comporta: sin mensajes no llama a nada más
{
    const cuerpo = parchearTexto(REINTENTO.original, REINTENTO).texto;
    const fn = new Function('msgs', 'msg', 'logger', 'remoteJid', 'ids', 'siguio',
        `${cuerpo.replace('            msgs.push(msg);\n        }', 'msgs.push(msg);')}\nsiguio();`);
    let llamadas = 0;
    fn([], undefined, { debug() {} }, 'g@g.us', ['A'], () => { llamadas++; });
    assert.strictEqual(llamadas, 0, 'sin mensajes no tiene que seguir');
    fn([], { conversation: 'hola' }, { debug() {} }, 'g@g.us', ['A'], () => { llamadas++; });
    assert.strictEqual(llamadas, 1, 'con mensaje real sigue como antes');
}

// aplicar: todo bien, después idempotente y --verificar pasa
{
    const raiz = armarRaiz();
    assert.deepStrictEqual(aplicar(raiz, { log: callado }), []);
    assert.deepStrictEqual(aplicar(raiz, { log: callado }), []);
    assert.deepStrictEqual(aplicar(raiz, { soloVerificar: true, log: callado }), []);
    for (const f of ['dist/main.js', 'dist/main.mjs']) {
        assert.ok(fs.readFileSync(path.join(raiz, f), 'utf8').includes('catch{return void 0}'), f);
    }
}

// --verificar sobre una imagen sin parchear falla y no escribe nada
{
    const raiz = armarRaiz();
    const antes = fs.readFileSync(path.join(raiz, 'dist/main.js'), 'utf8');
    assert.ok(aplicar(raiz, { soloVerificar: true, log: callado }).length >= 2);
    assert.strictEqual(fs.readFileSync(path.join(raiz, 'dist/main.js'), 'utf8'), antes);
}

// main.mjs es opcional; main.js y Baileys son obligatorios
{
    assert.deepStrictEqual(aplicar(armarRaiz({ sinMjs: true }), { log: callado }), []);
    const errores = aplicar(armarRaiz({ sinBaileys: true }), { log: callado });
    assert.strictEqual(errores.length, 1);
    assert.match(errores[0], /no existe node_modules\/baileys/);
    const raiz = armarRaiz();
    fs.rmSync(path.join(raiz, 'dist/main.js'));
    assert.match(aplicar(raiz, { log: callado }).join('\n'), /no existe dist\/main\.js/);
}

console.log('✅ parcheEvolution: todos los tests pasan');
