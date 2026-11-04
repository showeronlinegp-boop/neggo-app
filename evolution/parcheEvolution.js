// Parches de Evolution API v2.3.7 (Baileys 7.0.0-rc.9) para que nunca salgan
// mensajes vacíos ni ráfagas al grupo cuando un teléfono pide reintentos.
//
// Contexto: si un integrante no puede descifrar un mensaje nuestro, su teléfono manda un
// "retry receipt" al dispositivo que lo envió (Evolution). Baileys busca el original con
// getMessage() y lo reenvía. Nosotros no guardamos mensajes, así que nunca lo tenemos.
//
// 1. getMessage (Evolution, dist/main.js y dist/main.mjs): devolvía { conversation: "" }
//    cuando no lo encontraba y Baileys reenviaba ese vacío al grupo. Ahora devuelve undefined.
//    `npm run start:prod` es `node dist/main`, que carga main.js: ese es obligatorio.
// 2. sendMessagesAgain (Baileys, messages-recv.js): antes de mirar si tenía algo para
//    reenviar, rehacía la sesión de cifrado y pedía claves nuevas al servidor de WhatsApp.
//    Con cientos de pedidos eso es tráfico raro hacia WhatsApp. Ahora, si no tiene ninguno
//    de los mensajes pedidos, ignora el pedido sin tocar nada.
//
// Se corre en el build de la imagen (evolution/Dockerfile) y otra vez en cada arranque
// como verificación. Si algún parche no encaja (cambió la versión), sale con código 1:
// el build falla o Evolution no arranca. Preferimos Evolution caído antes que vacíos al grupo.

const fs = require('fs');
const path = require('path');

const PARCHES = [
    {
        nombre: 'getMessage sin mensaje → undefined',
        archivos: [
            { ruta: 'dist/main.js', obligatorio: true },
            { ruta: 'dist/main.mjs', obligatorio: false },
        ],
        original: 'catch{return{conversation:""}}}async defineAuthState(',
        parcheado: 'catch{return void 0}}async defineAuthState(',
    },
    {
        nombre: 'reintento sin mensajes → no rehace sesión',
        archivos: [
            { ruta: 'node_modules/baileys/lib/Socket/messages-recv.js', obligatorio: true },
        ],
        original: [
            '            msgs.push(msg);',
            '        }',
            "        // if it's the primary jid sending the request",
        ].join('\n'),
        parcheado: [
            '            msgs.push(msg);',
            '        }',
            '        // Parche Neggo: sin ningún mensaje para reenviar no se rehace la sesión',
            '        // ni se piden claves al servidor (evolution/parcheEvolution.js).',
            '        if (!msgs.some(Boolean)) {',
            "            logger.debug({ jid: remoteJid, ids }, 'recv retry request, no messages available: ignored');",
            '            return;',
            '        }',
            "        // if it's the primary jid sending the request",
        ].join('\n'),
    },
];

function contar(texto, buscado) {
    return texto.split(buscado).length - 1;
}

// Devuelve el texto parcheado y qué pasó. Tira error si no encaja exactamente una vez.
function parchearTexto(texto, { original, parcheado }) {
    const yaEstan = contar(texto, parcheado);
    const originales = contar(texto, original);
    if (yaEstan === 1 && originales === 0) return { texto, estado: 'ya' };
    if (originales !== 1 || yaEstan !== 0) {
        throw new Error(`se esperaba 1 aparición del original y hay ${originales} (parcheadas: ${yaEstan})`);
    }
    return { texto: texto.replace(original, parcheado), estado: 'aplicado' };
}

function aplicar(raiz, { soloVerificar = false, log = console.log } = {}) {
    const errores = [];
    for (const parche of PARCHES) {
        for (const { ruta, obligatorio } of parche.archivos) {
            const file = path.join(raiz, ruta);
            if (!fs.existsSync(file)) {
                if (obligatorio) errores.push(`${parche.nombre}: no existe ${ruta}`);
                continue;
            }
            try {
                const src = fs.readFileSync(file, 'utf8');
                const r = parchearTexto(src, parche);
                if (r.estado === 'aplicado') {
                    if (soloVerificar) throw new Error('no estaba aplicado');
                    fs.writeFileSync(file, r.texto);
                }
                log(`✅ ${parche.nombre}: ${r.estado === 'ya' ? 'ya aplicado' : 'aplicado'} en ${ruta}`);
            } catch (err) {
                errores.push(`${parche.nombre} (${ruta}): ${err.message}`);
            }
        }
    }
    return errores;
}

if (require.main === module) {
    const raiz = process.env.EVOLUTION_ROOT || '/evolution';
    const soloVerificar = process.argv.includes('--verificar');
    const errores = aplicar(raiz, { soloVerificar });
    if (errores.length) {
        for (const e of errores) console.error(`❌ Parche Evolution: ${e}`);
        console.error('❌ Evolution no arranca sin los parches: ¿cambió la versión? Revisar evolution/parcheEvolution.js');
        process.exit(1);
    }
}

module.exports = { PARCHES, parchearTexto, aplicar };
