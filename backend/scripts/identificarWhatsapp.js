// Recorrida para identificar los chats del WhatsApp del negocio (whatsapp_chat_identidad).
// Lee las cotizaciones nombradas en la base (lo que queda tras la depuración) y, si se pasan, en los
// exports JSONL de depurar.ps1; y los números que WhatsApp relacionó (lid_a_numero.txt).
// Solo lee Odoo y evolution_negocio; escribe solo en whatsapp_chat_identidad.
//
// Uso: node scripts/identificarWhatsapp.js [--jsonl export.jsonl ...] [--lids lid_a_numero.txt]

const fs = require('fs');
const readline = require('readline');
const pool = require('../config/database');
const servicio = require('../services/whatsappIdentidadService');
const { parsearMapeoLid } = require('../services/whatsappIdentidad');

function argumentos(argv) {
    const out = { jsonl: [], lids: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--jsonl') out.jsonl.push(argv[++i]);
        else if (argv[i] === '--lids') out.lids = argv[++i];
        else throw new Error(`Argumento desconocido: ${argv[i]}`);
    }
    return out;
}

async function leerJsonl(archivo, refsPorChat) {
    const rl = readline.createInterface({ input: fs.createReadStream(archivo, 'utf8'), crlfDelay: Infinity });
    let n = 0;
    for await (const linea of rl) {
        if (!linea.trim()) continue;
        const m = JSON.parse(linea);
        n += 1;
        if (!m.es_grupo) servicio.agregarReferencias(refsPorChat, m.chat, m.texto);
    }
    return n;
}

async function main() {
    const args = argumentos(process.argv.slice(2));
    const refsPorChat = await servicio.referenciasEnBase(0);
    console.log(`📦 Base: ${refsPorChat.size} chats con cotizaciones nombradas`);
    for (const archivo of args.jsonl) {
        const n = await leerJsonl(archivo, refsPorChat);
        console.log(`📦 ${archivo}: ${n} mensajes leídos; ${refsPorChat.size} chats con cotizaciones en total`);
    }
    const r = await servicio.identificarPorCotizaciones({ refsPorChat });
    console.log('✅ Por cotizaciones:', JSON.stringify(r));
    if (args.lids) {
        const mapeos = parsearMapeoLid(fs.readFileSync(args.lids, 'utf8'));
        console.log('✅ Por número de WhatsApp:', JSON.stringify(await servicio.identificarPorMapeo(mapeos)));
    }
}

main()
    .catch((err) => {
        console.error('❌ Recorrida cancelada:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
