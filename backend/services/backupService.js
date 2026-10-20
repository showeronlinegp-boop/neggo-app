// Backup de la base: estado y pedido manual desde la app.
// El backup lo hace el contenedor db-backup (backup/). Este servicio solo lee y escribe
// archivos en la carpeta compartida (volumes/backups):
//   .estado          → lo escribe db-backup cada pocos segundos (vivo, Drive, próximo)
//   .manual-request  → lo escribe la app al tocar "Hacer backup ahora"
//   .manual-running  → db-backup tomó el pedido y está corriendo
//   .manual-status   → resultado del último pedido manual
//   .last-success    → fecha del último backup subido a Drive
// No toca la base ni Drive.

const fs = require('fs/promises');
const path = require('path');

// Si .estado no se actualiza en este tiempo, el servicio db-backup no está corriendo
const SERVICIO_VIVO_SEG = 120;
const DUMP_RE = /^neggo_app_\d{4}-\d{2}-\d{2}\.dump$/;

function backupDir() {
    return process.env.BACKUP_DIR || '/app/backups';
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function isoDesdeEpoch(seg) {
    const n = Number(seg);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

async function leerJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return null;
    }
}

async function mtime(file) {
    try {
        return (await fs.stat(file)).mtime;
    } catch {
        return null;
    }
}

async function listarDumps(dir) {
    let nombres;
    try {
        nombres = (await fs.readdir(dir)).filter(n => DUMP_RE.test(n));
    } catch {
        return [];
    }
    const dumps = await Promise.all(nombres.map(async nombre => {
        const st = await fs.stat(path.join(dir, nombre));
        return { nombre, bytes: st.size, fecha: st.mtime.toISOString() };
    }));
    // La fecha ISO del nombre ordena igual que el calendario
    return dumps.sort((a, b) => b.nombre.localeCompare(a.nombre));
}

/**
 * Estado del backup para la pantalla de Admin.
 */
async function estado({ dir = backupDir(), now = Date.now() } = {}) {
    const [servicio, manual, pedido, corriendo, ultimoOk, backups] = await Promise.all([
        leerJson(path.join(dir, '.estado')),
        leerJson(path.join(dir, '.manual-status')),
        mtime(path.join(dir, '.manual-request')),
        mtime(path.join(dir, '.manual-running')),
        mtime(path.join(dir, '.last-success')),
        listarDumps(dir),
    ]);

    const servicioActivo = Boolean(servicio && now / 1000 - Number(servicio.visto) <= SERVICIO_VIVO_SEG);

    return {
        servicio_activo: servicioActivo,
        drive_configurado: servicio ? servicio.drive_configurado === true : null,
        proximo_auto: servicio ? isoDesdeEpoch(servicio.proximo) : null,
        ultimo_ok: ultimoOk ? ultimoOk.toISOString() : null,
        pedido_pendiente: Boolean(pedido),
        // Un "corriendo" de un servicio caído no está corriendo: al volver lo marca como cortado
        en_curso: servicioActivo && Boolean(corriendo || (manual && manual.estado === 'corriendo')),
        ultimo_manual: manual ? {
            estado: manual.estado,
            inicio: isoDesdeEpoch(manual.inicio),
            fin: isoDesdeEpoch(manual.fin),
            mensaje: manual.mensaje || '',
        } : null,
        backups,
    };
}

/**
 * Deja el pedido para que db-backup haga un backup ahora.
 */
async function pedirBackup(usuario, { dir = backupDir(), now = Date.now() } = {}) {
    const actual = await estado({ dir, now });
    if (!actual.servicio_activo) {
        throw httpError('El servicio de backup no está corriendo. Levantalo con: docker compose up -d db-backup', 409);
    }
    if (actual.pedido_pendiente || actual.en_curso) {
        throw httpError('Ya hay un backup en curso. Esperá a que termine.', 409);
    }
    try {
        // wx: si dos admins tocan a la vez, el segundo recibe EEXIST
        await fs.writeFile(
            path.join(dir, '.manual-request'),
            JSON.stringify({ pedido_at: new Date(now).toISOString(), usuario }),
            { flag: 'wx' }
        );
    } catch (err) {
        if (err.code === 'EEXIST') throw httpError('Ya hay un backup en curso. Esperá a que termine.', 409);
        throw err;
    }
    return estado({ dir, now });
}

module.exports = { estado, pedirBackup, SERVICIO_VIVO_SEG };
