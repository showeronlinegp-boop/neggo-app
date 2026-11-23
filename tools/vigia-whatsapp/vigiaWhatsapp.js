// Vigía de WhatsApp (nota 247). Corre en su propio contenedor con el socket de Docker y cada
// 30 s lee el log del Evolution del negocio. Cuenta el tráfico hacia WhatsApp (conexiones,
// cierres, rate-overlimit, consultas de grupos, desvinculación) en una ventana de 5 minutos:
//   - pasa la mitad de un tope → aviso en el log del vigía
//   - llega al tope → FRENA el contenedor (corta todo contacto con WhatsApp), guarda un reporte,
//     crea una nota de prueba y deja su número en abrir-nota.txt para que el vigía de Windows
//     (tools/claude-link/vigia-bot.ps1) abra Claude a investigar.
// Nunca lo vuelve a prender: eso lo decide una persona (docker start neggo-evolution-negocio).
// Reglas y topes en reglasVigia.js.

const fs = require('fs');
const http = require('http');
const path = require('path');
const r = require('./reglasVigia');

const CONTENEDOR = process.env.VIGIA_CONTENEDOR || 'neggo-evolution-negocio';
const DIR = process.env.VIGIA_DIR || '/vigia';
const DIR_HOST = process.env.VIGIA_DIR_HOST || DIR;
const INTERVALO_MS = Number(process.env.VIGIA_INTERVALO_S || 30) * 1000;
const ESTADO = path.join(DIR, 'estado.json');
const LOG = path.join(DIR, 'vigia.log');

function log(msg) {
    const linea = `${new Date().toISOString()}  ${msg}`;
    console.log(linea);
    try { fs.appendFileSync(LOG, `${linea}\n`); } catch { /* la carpeta puede no estar montada */ }
}

function leerEstado() {
    try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; }
}
function guardarEstado(e) {
    fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2));
}

/** Pedido a la API de Docker por el socket. */
function docker(method, ruta, body) {
    return new Promise((resolve, reject) => {
        const datos = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            socketPath: '/var/run/docker.sock', path: ruta, method,
            headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {},
            timeout: 60 * 1000,
        }, (res) => {
            const trozos = [];
            res.on('data', (c) => trozos.push(c));
            res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(trozos) }));
        });
        req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${ruta}`)));
        req.on('error', reject);
        if (datos) req.write(datos);
        req.end();
    });
}

async function inspeccionar(nombre) {
    const res = await docker('GET', `/containers/${encodeURIComponent(nombre)}/json`);
    if (res.status !== 200) return null;
    return JSON.parse(res.buffer.toString('utf8'));
}

async function leerLogs(nombre, desdeSeg) {
    const res = await docker('GET', `/containers/${encodeURIComponent(nombre)}/logs?stdout=1&stderr=1&timestamps=1&since=${desdeSeg}`);
    if (res.status !== 200) throw new Error(`logs HTTP ${res.status}`);
    const { texto } = r.desmultiplexar(res.buffer);
    return texto.split('\n').map(r.separarTimestamp).filter(Boolean);
}

/** Corre un comando en el backend (para crear la nota con scripts/notaPrueba.js). */
async function execEnBackend(cmd) {
    const filtro = encodeURIComponent(JSON.stringify({
        label: ['com.docker.compose.project=neggo-app', 'com.docker.compose.service=backend'],
        status: ['running'],
    }));
    const lista = JSON.parse((await docker('GET', `/containers/json?filters=${filtro}`)).buffer.toString('utf8'));
    if (!lista.length) throw new Error('el backend no está corriendo');
    const ex = await docker('POST', `/containers/${lista[0].Id}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd });
    const { Id } = JSON.parse(ex.buffer.toString('utf8'));
    const out = await docker('POST', `/exec/${Id}/start`, { Detach: false, Tty: false });
    return r.desmultiplexar(out.buffer).texto;
}

async function crearNota(texto) {
    // El texto va en base64: nunca pasa por la línea de comandos como texto suelto
    const b64 = Buffer.from(JSON.stringify({
        tipo: 'error', texto, ruta: '/clientes', pantalla: 'Vigía de WhatsApp',
    })).toString('base64');
    const salida = await execEnBackend(['sh', '-c', `echo ${b64} | base64 -d | node scripts/notaPrueba.js crear`]);
    const m = /Nota #(\d+) creada/.exec(salida);
    if (!m) throw new Error(`no se pudo crear la nota: ${salida.slice(0, 200)}`);
    return Number(m[1]);
}

function fechaArchivo(d) {
    return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
}

async function cortar(evaluacion, lineas, estado) {
    const ahora = new Date();
    log(`🛑 CORTE: ${evaluacion.motivos.join(' · ')} → frenando ${CONTENEDOR}`);
    const stop = await docker('POST', `/containers/${encodeURIComponent(CONTENEDOR)}/stop?t=5`);
    const frenado = stop.status === 204 || stop.status === 304;
    log(frenado ? `✅ ${CONTENEDOR} frenado` : `❌ No se pudo frenar ${CONTENEDOR} (HTTP ${stop.status})`);

    const nombre = `reporte-${fechaArchivo(ahora)}.md`;
    const reporte = [
        `# Vigía de WhatsApp — corte ${ahora.toISOString()}`,
        '',
        `Contenedor: ${CONTENEDOR} — ${frenado ? 'FRENADO' : 'NO SE PUDO FRENAR'}`,
        `Motivos (ventana de ${r.VENTANA_MS / 60000} min): ${evaluacion.motivos.join(' · ')}`,
        `Cuentas: ${JSON.stringify(evaluacion.cuentas)}`,
        `Topes: ${JSON.stringify(r.TOPES)}`,
        '',
        '## Últimas líneas del log (sin contenido de mensajes)',
        '',
        '```',
        ...r.lineasParaReporte(lineas),
        '```',
    ].join('\n');
    fs.writeFileSync(path.join(DIR, nombre), reporte);
    log(`📦 Reporte: ${nombre}`);

    let notaId = null;
    try {
        notaId = await crearNota([
            `El vigía de WhatsApp ${frenado ? 'FRENÓ' : 'intentó frenar'} el WhatsApp del negocio (${CONTENEDOR}) el ${ahora.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.`,
            `Motivo: ${evaluacion.motivos.join(' · ')} en ${r.VENTANA_MS / 60000} minutos.`,
            `Reporte con el log: ${DIR_HOST}\\${nombre}`,
            '',
            'Averiguar qué disparó el tráfico hacia WhatsApp y corregirlo. Evolution queda frenado: no volver a prenderlo sin el OK del usuario.',
        ].join('\n'));
        fs.writeFileSync(path.join(DIR, 'abrir-nota.txt'), String(notaId));
        log(`📦 Nota #${notaId} creada; el vigía de Windows abre Claude`);
    } catch (err) {
        log(`❌ ${err.message}`);
    }
    guardarEstado({ ...estado, cortadoAt: ahora.toISOString(), notaId, motivos: evaluacion.motivos, ventana: [] });
}

let ventana = [];
let ultimoAviso = 0;

async function vuelta() {
    const estado = leerEstado();
    const info = await inspeccionar(CONTENEDOR);
    if (!info) return;
    if (!info.State.Running) return;

    // Si alguien lo volvió a prender después del corte, se retoma la vigilancia
    if (estado.cortadoAt) {
        if (new Date(info.State.StartedAt) <= new Date(estado.cortadoAt)) return;
        log(`✅ ${CONTENEDOR} se volvió a prender: retomo la vigilancia`);
        delete estado.cortadoAt;
        ventana = [];
        estado.ultimoTs = r.normalizarTs(info.State.StartedAt);
    }

    const ahora = Date.now();
    const ultimoTs = r.normalizarTs(estado.ultimoTs || new Date(ahora - r.VENTANA_MS).toISOString());
    const desde = Math.floor(Date.parse(ultimoTs) / 1000);
    const lineas = (await leerLogs(CONTENEDOR, desde)).filter((l) => l.ts > ultimoTs);
    if (lineas.length) estado.ultimoTs = lineas[lineas.length - 1].ts;

    ventana = r.acumular(ventana, lineas, ahora);
    const ev = r.evaluar(ventana);
    if (ev.nivel === 'cortar') {
        // Para el reporte, el log completo de la ventana
        const todo = await leerLogs(CONTENEDOR, Math.floor((ahora - r.VENTANA_MS) / 1000)).catch(() => lineas);
        await cortar(ev, todo, estado);
        ventana = [];
        return;
    }
    if (ev.nivel === 'aviso' && ahora - ultimoAviso > r.VENTANA_MS) {
        ultimoAviso = ahora;
        log(`⚠️ Se está por desmadrar: ${ev.motivos.join(' · ')}`);
    }
    guardarEstado(estado);
}

async function main() {
    log(`✅ Vigía de WhatsApp iniciado: ${CONTENEDOR}, cada ${INTERVALO_MS / 1000} s, topes ${JSON.stringify(r.TOPES)}`);
    let ultimoLatido = Date.now();
    for (;;) {
        try {
            await vuelta();
        } catch (err) {
            log(`❌ ${err.message}`);
        }
        if (Date.now() - ultimoLatido > 6 * 3600 * 1000) {
            ultimoLatido = Date.now();
            log(`📦 Sigo vigilando. Ventana actual: ${JSON.stringify(r.contar(ventana))}`);
        }
        await new Promise((res) => setTimeout(res, INTERVALO_MS));
    }
}

if (require.main === module) main();

module.exports = { vuelta };
