// Un envío por vez. El intervalo (default 90 s) lo controla la cola en Postgres.

const evolution = require('../services/evolutionClient');
const { tick } = require('../services/whatsappQueue');

const POLL_MS = 5000;
let timer = null;
let busy = false;

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
    console.log('📦 Cola de WhatsApp activa (un mensaje por intervalo, default 90 s)');
    timer = setInterval(() => {
        if (busy) return;
        busy = true;
        tick(pool, {
            loadImage: loadOdooImage,
            sendImage: evolution.sendImage,
            sendStatus: evolution.sendStatus,
        })
            .then((result) => {
                if (result.action === 'enviado') {
                    console.log(`✅ WhatsApp: mensaje ${result.id} enviado`);
                } else if (result.action === 'error') {
                    console.error(`❌ WhatsApp: mensaje ${result.id} falló: ${result.error}`);
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
}

module.exports = { startWhatsappWorker, stopWhatsappWorker, loadOdooImage };
