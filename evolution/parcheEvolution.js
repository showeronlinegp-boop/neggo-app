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
// 3. Estados de WhatsApp (Baileys, messages-recv.js): WhatsApp manda los estados (historias)
//    de los contactos como stanza <status> de primer nivel. Baileys rc.9 no tiene handler y
//    nunca la confirma: el servidor retiene todo lo demás detrás de ella y cada ~50 min corta
//    el stream con <ack class="status">. Ahora se responde con sendMessageAck (ack simple, sin
//    código de error, sin recibo de lectura) online y offline, como el backport de
//    evolution-api PR #2785 / Baileys #2858. No marca los estados como vistos.
//
// 4. Cola offline (Baileys, socket.js): tras <offline_preview> Baileys pide UN solo
//    <offline_batch count=100> y nunca el siguiente. Con más de 100 pendientes el servidor no
//    manda <offline> y retiene también los mensajes en vivo detrás de la cola (WAHA #2349).
//    Ahora, mientras no llegue <offline>, se pide el lote siguiente cada 5 s (tope 720 pedidos,
//    ~1 h) y se corta al llegar <offline> o al cerrarse el socket.
//
// 5. Procesador offline (Baileys, messages-recv.js): si un nodo offline tira error (p. ej. el
//    JSON.parse de GROUP_PARTICIPANT_CHANGE_NUMBER en process-message.js), el bucle se cortaba
//    con isProcessing=true para siempre y nunca más procesaba (ni confirmaba) nodos offline:
//    la cola quedaba trabada de nuevo. Ahora el error de un nodo se registra y se sigue.
//
// 6. Reconexión (Evolution, dist/main.js, connectionUpdate): al cerrarse la conexión por
//    cualquier motivo que no sea logout, Evolution reconectaba al instante, sin pausa y sin
//    registrar por qué se cerró. Sin red (PC suspendida o recién despierta) cada intento falla en
//    milisegundos y dispara otro: hubo hasta 1.548 intentos por minuto (nota 247) y WhatsApp terminó
//    desvinculando el número. Ahora queda un solo reintento pendiente a la vez, con espera
//    creciente (5 s, 10 s, 20 s… hasta 5 min), y se registra el código del cierre.
// 7. Al conectar (connection "open") el contador de intentos vuelve a cero.
//
// Se corre en el build de la imagen (evolution/Dockerfile) y otra vez en cada arranque
// como verificación. Si algún parche no encaja (cambió la versión), sale con código 1:
// el build falla o Evolution no arranca. Preferimos Evolution caído antes que vacíos al grupo.

const fs = require('fs');
const path = require('path');

// Reintento con espera creciente (parche 6). Va en una sola línea porque reemplaza código minificado.
const RECONEXION_NEGGO = [
    '(()=>{',
    'const n=(this.neggoIntentos=(this.neggoIntentos||0)+1),espera=Math.min(5e3*2**Math.min(n-1,6),3e5);',
    'this.logger.warn(`Parche Neggo: conexión cerrada (código ${i??"sin código"}), reintento ${n} en ${espera/1e3} s`);',
    'if(this.neggoReconexion)return;',
    'this.neggoReconexion=setTimeout(async()=>{',
    // Se libera antes de conectar: si este intento también se cae, agenda el siguiente
    'this.neggoReconexion=void 0;',
    'try{await this.connectToWhatsapp(this.phoneNumber)}catch(e){this.logger.error(e)}',
    '},espera)',
    '})()',
].join('');

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
    {
        nombre: 'estados <status> offline → ack simple',
        archivos: [
            { ruta: 'node_modules/baileys/lib/Socket/messages-recv.js', obligatorio: true },
        ],
        original: [
            '    const makeOfflineNodeProcessor = () => {',
            '        const nodeProcessorMap = new Map([',
            "            ['message', handleMessage],",
            "            ['call', handleCall],",
            "            ['receipt', handleReceipt],",
            "            ['notification', handleNotification]",
            '        ]);',
        ].join('\n'),
        parcheado: [
            '    // Parche Neggo: los estados (<status>) solo se confirman con un ack simple',
            '    // (sin error ni recibo de lectura) para que el servidor no retenga la cola',
            '    // (evolution/parcheEvolution.js, evolution-api PR #2785).',
            '    const handleStatusNeggo = async (node) => {',
            '        await sendMessageAck(node);',
            '    };',
            '    const makeOfflineNodeProcessor = () => {',
            '        const nodeProcessorMap = new Map([',
            "            ['message', handleMessage],",
            "            ['call', handleCall],",
            "            ['receipt', handleReceipt],",
            "            ['notification', handleNotification],",
            "            ['status', handleStatusNeggo]",
            '        ]);',
        ].join('\n'),
    },
    {
        nombre: 'estados <status> online → ack simple',
        archivos: [
            { ruta: 'node_modules/baileys/lib/Socket/messages-recv.js', obligatorio: true },
        ],
        original: [
            "    ws.on('CB:notification', async (node) => {",
            "        await processNode('notification', node, 'handling notification', handleNotification);",
            '    });',
            "    ws.on('CB:ack,class:message', (node) => {",
        ].join('\n'),
        parcheado: [
            "    ws.on('CB:notification', async (node) => {",
            "        await processNode('notification', node, 'handling notification', handleNotification);",
            '    });',
            '    // Parche Neggo: ack simple de los estados (ver handleStatusNeggo).',
            "    ws.on('CB:status', async (node) => {",
            "        await processNode('status', node, 'handling status', handleStatusNeggo);",
            '    });',
            "    ws.on('CB:ack,class:message', (node) => {",
        ].join('\n'),
    },
    {
        nombre: 'cola offline → pide lotes hasta <offline>',
        archivos: [
            { ruta: 'node_modules/baileys/lib/Socket/socket.js', obligatorio: true },
        ],
        original: [
            "    ws.on('CB:ib,,offline_preview', async (node) => {",
            "        logger.info('offline preview received', JSON.stringify(node));",
            '        await sendNode({',
            "            tag: 'ib',",
            '            attrs: {},',
            "            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]",
            '        });',
            '    });',
        ].join('\n'),
        parcheado: [
            '    // Parche Neggo: pedir lotes offline hasta que llegue <offline> (evolution/parcheEvolution.js).',
            '    let vigiaOfflineNeggo;',
            '    const pararOfflineNeggo = () => {',
            '        if (vigiaOfflineNeggo) {',
            '            clearInterval(vigiaOfflineNeggo);',
            '            vigiaOfflineNeggo = undefined;',
            '        }',
            '    };',
            "    ws.on('CB:ib,,offline', () => pararOfflineNeggo());",
            "    ws.on('close', () => pararOfflineNeggo());",
            "    ws.on('CB:ib,,offline_preview', async (node) => {",
            "        logger.info('offline preview received', JSON.stringify(node));",
            '        await sendNode({',
            "            tag: 'ib',",
            '            attrs: {},',
            "            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]",
            '        });',
            '        pararOfflineNeggo();',
            '        let pedidosNeggo = 1;',
            '        vigiaOfflineNeggo = setInterval(() => {',
            '            if (!ws.isOpen || pedidosNeggo >= 720) {',
            '                pararOfflineNeggo();',
            '                return;',
            '            }',
            '            pedidosNeggo++;',
            "            logger.info({ pedido: pedidosNeggo }, 'offline queue still open, requesting next offline batch');",
            "            sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })",
            "                .catch(err => logger.warn({ err }, 'failed to request next offline batch'));",
            '        }, 5000);',
            '    });',
        ].join('\n'),
    },
    {
        nombre: 'procesador offline → un error no lo frena',
        archivos: [
            { ruta: 'node_modules/baileys/lib/Socket/messages-recv.js', obligatorio: true },
        ],
        original: [
            '                    await nodeProcessor(node);',
            '                }',
            '                isProcessing = false;',
        ].join('\n'),
        parcheado: [
            '                    // Parche Neggo: un nodo con error no frena la cola offline (evolution/parcheEvolution.js).',
            '                    try {',
            '                        await nodeProcessor(node);',
            '                    }',
            '                    catch (error) {',
            "                        onUnexpectedError(error, `processing offline ${type}`);",
            '                    }',
            '                }',
            '                isProcessing = false;',
        ].join('\n'),
    },
    {
        nombre: 'reconexión → un intento a la vez con espera creciente',
        // main.mjs no se usa (start:prod carga main.js) y está minificado con otros nombres
        archivos: [{ ruta: 'dist/main.js', obligatorio: true }],
        original: '![R.DisconnectReason.loggedOut,R.DisconnectReason.forbidden,402,406].includes(i)?await this.connectToWhatsapp(this.phoneNumber):(',
        parcheado: `![R.DisconnectReason.loggedOut,R.DisconnectReason.forbidden,402,406].includes(i)?${RECONEXION_NEGGO}:(`,
    },
    {
        nombre: 'reconexión → contador a cero al conectar',
        archivos: [{ ruta: 'dist/main.js', obligatorio: true }],
        original: 'if(t==="open"){this.instance.wuid=this.client.user.id.replace(',
        parcheado: 'if(t==="open"){this.neggoIntentos=0;this.instance.wuid=this.client.user.id.replace(',
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
