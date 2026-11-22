// CRM WhatsApp: carga al tablero los chats privados del historial del WhatsApp del negocio (exports
// JSONL de depurar.ps1). De cada chat guarda solo número (si WhatsApp lo mandó), el nombre que puso en
// WhatsApp y las fechas del primer y último mensaje de cada lado: nunca el texto. Las cotizaciones
// nombradas en la charla se usan para reconocer a los clientes de Odoo.
// Después corre el cruce: proveedores por nombre, clientes por teléfono y prospectos nuevos.
//
// Uso: node scripts/importarHistorialWhatsapp.js export1.jsonl [export2.jsonl ...]
// Solo lee los exports, Odoo y evolution_negocio; escribe en whatsapp_chat_identidad y crm_leads.

const fs = require('fs');
const readline = require('readline');
const pool = require('../config/database');
const identidad = require('../services/whatsappIdentidadService');
const waLeads = require('../services/whatsappLeadsService');
const reglas = require('../services/whatsappLeads');

// Las fechas del export están en hora de Argentina, sin offset
function fechaAR(s) {
    const d = new Date(`${s}-03:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function mayor(a, b) { return !a ? b : (!b ? a : (b > a ? b : a)); }
function menor(a, b) { return !a ? b : (!b ? a : (b < a ? b : a)); }

async function leer(archivo, chats, refs) {
    const rl = readline.createInterface({ input: fs.createReadStream(archivo, 'utf8'), crlfDelay: Infinity });
    let n = 0;
    for await (const linea of rl) {
        if (!linea.trim()) continue;
        let m;
        try { m = JSON.parse(linea); } catch { continue; }
        if (m.es_grupo || !m.chat || !/@(lid|s\.whatsapp\.net)$/.test(m.chat)) continue;
        const fecha = fechaAR(m.fecha);
        if (!fecha) continue;
        n += 1;
        let c = chats.get(m.chat);
        if (!c) {
            c = { chat: m.chat, numero: null, nombre: null, primero: null, ultimo: null, ultimo_de_ellos: null, ultimo_nuestro: null };
            chats.set(m.chat, c);
        }
        if (!c.numero) c.numero = reglas.mapeosDeChats([{ chat: m.chat, alt: m.chat_alt }])[0]?.numero || null;
        if (!m.de_neggo && m.nombre && m.nombre !== '$$') c.nombre = m.nombre;
        c.primero = menor(c.primero, fecha);
        c.ultimo = mayor(c.ultimo, fecha);
        if (m.de_neggo) c.ultimo_nuestro = mayor(c.ultimo_nuestro, fecha);
        else c.ultimo_de_ellos = mayor(c.ultimo_de_ellos, fecha);
        identidad.agregarReferencias(refs, m.chat, m.texto);
    }
    return n;
}

async function main() {
    const archivos = process.argv.slice(2);
    if (!archivos.length) throw new Error('Pasá al menos un export JSONL');
    await pool.query("SET statement_timeout = '120s'");
    const chats = new Map();
    const refs = new Map();
    for (const a of archivos) console.log(`📦 ${a}: ${await leer(a, chats, refs)} mensajes de chats privados`);
    console.log(`📦 ${chats.size} chats privados, ${[...chats.values()].filter((c) => c.numero).length} con número, ${refs.size} con cotizaciones nombradas`);

    console.log('✅ Chats registrados:', JSON.stringify(await waLeads.registrarChats([...chats.values()])));
    // Las cotizaciones de la memoria reciente también, así se reevalúan todos juntos
    const recientes = await identidad.referenciasEnBase(0);
    for (const [chat, set] of recientes) for (const r of set) identidad.agregarReferencias(refs, chat, r);
    console.log('✅ Clientes por cotizaciones:', JSON.stringify(await identidad.identificarPorCotizaciones({ refsPorChat: refs })));
    console.log('✅ Cruce:', JSON.stringify(await waLeads.vincular()));
}

main()
    .catch((err) => {
        console.error('❌ Importación cancelada:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
