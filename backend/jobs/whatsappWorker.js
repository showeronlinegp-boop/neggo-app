// Un envío por vez. El intervalo (default 90 s) lo controla la cola en Postgres.
// Al arrancar espera a que Evolution tenga WhatsApp abierto: si manda antes,
// Evolution encola mal y WhatsApp suelta mensajes vacíos en ráfaga.

const evolution = require('../services/evolutionClient');
const { tick } = require('../services/whatsappQueue');

const POLL_MS = 5000;
// Después de prender el backend, no toca la cola hasta que pase esto.
// Evolution y Baileys terminan de vincular la sesión en ese rato.
const BOOT_GRACE_MS = Number(process.env.WHATSAPP_BOOT_GRACE_MS) || 30_000;
// Techo duro en este proceso: aunque la base diga que ya toca, no salen dos
// mensajes más cerca que esto. Evita ráfagas si algo raro pasa con los gaps.
const MIN_PROCESS_GAP_MS = Number(process.env.WHATSAPP_MIN_PROCESS_GAP_MS) || 10_000;

function sendingEnabled() {
    const raw = String(process.env.WHATSAPP_SENDING_ENABLED ?? '1').trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

let timer = null;
let busy = false;
let startedAt = 0;
let lastSendAt = 0;
let bootLogged = false;
let disabledLogged = false;

async function loadOdooImage(message) {
    if (!message.image_template_id) {
        throw new Error('El producto no tiene foto en Odoo');
    }
    const { getOdooImage } = require('../services/odooImageService');
    const img = await getOdooImage({
        kind: 'template',
        company: message.company === 'preventas' ? 'preventas' : 'neggo',
        id: message.image_template_id,
        size: '512',
    });
    if (!img?.buffer) throw new Error('Odoo no devolvió la foto');
    return { base64: img.buffer.toString('base64'), mimetype: img.contentType || 'image/jpeg' };
}

function startWhatsappWorker(pool) {
    if (timer) return;
    startedAt = Date.now();
    lastSendAt = 0;
    bootLogged = false;
    console.log(
        `📦 Cola de WhatsApp activa (gracia al arrancar ${Math.round(BOOT_GRACE_MS / 1000)} s, `
        + `mínimo ${Math.round(MIN_PROCESS_GAP_MS / 1000)} s entre envíos en este proceso)`
    );
    timer = setInterval(() => {
        if (busy) return;
        if (!sendingEnabled()) {
            if (!disabledLogged) {
                disabledLogged = true;
                console.warn('⏸️ WhatsApp: envíos cortados (WHATSAPP_SENDING_ENABLED=0)');
            }
            return;
        }
        const sinceBoot = Date.now() - startedAt;
        if (sinceBoot < BOOT_GRACE_MS) {
            if (!bootLogged) {
                bootLogged = true;
                console.log(
                    `⏳ WhatsApp: esperando ${Math.round((BOOT_GRACE_MS - sinceBoot) / 1000)} s `
                    + 'para que Evolution termine de conectar antes del primer envío'
                );
            }
            return;
        }
        if (lastSendAt && Date.now() - lastSendAt < MIN_PROCESS_GAP_MS) return;
        busy = true;
        tick(pool, {
            loadImage: loadOdooImage,
            sendImage: evolution.sendImage,
            sendStatus: evolution.sendStatus,
        })
            .then((result) => {
                if (result.action === 'enviado') {
                    lastSendAt = Date.now();
                    console.log(`✅ WhatsApp: mensaje ${result.id} enviado`);
                } else if (result.action === 'error') {
                    console.error(`❌ WhatsApp: mensaje ${result.id} falló: ${result.error}`);
                } else if (result.reason === 'evolution_no_lista') {
                    console.warn(`⏳ WhatsApp: Evolution no listo, mensaje ${result.id} vuelve a la cola`);
                }
            })
            .catch((err) => console.error('❌ WhatsApp worker:', err.message))
            .finally(() => { busy = false; });
    }, POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

function stopWhatsappWorker() {
    if (timer) clearInterval(timer);
    timer = null;
    busy = false;
}

module.exports = {
    startWhatsappWorker,
    stopWhatsappWorker,
    loadOdooImage,
    sendingEnabled,
    BOOT_GRACE_MS,
    MIN_PROCESS_GAP_MS,
};
