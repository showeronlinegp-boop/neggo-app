// Un envío por vez. El intervalo (default 90 s) lo controla la cola en Postgres.

const evolution = require('../services/evolutionClient');
const { tick } = require('../services/whatsappQueue');

const POLL_MS = 5000;
let timer = null;
let busy = false;

async function loadOdooImage(message) {
    const { callOdoo, getCompanyIds } = require('../config/odoo');
    const ids = await getCompanyIds();
    const companyId = ids[message.company];
    if (!companyId || !message.image_template_id) {
        throw new Error('El producto no tiene foto en Odoo');
    }
    const data = await callOdoo(
        'product.template',
        'read',
        [[message.image_template_id]],
        {
            fields: ['image_512', 'image_128'],
            context: { allowed_company_ids: [companyId] },
        }
    );
    const base64 = data?.[0]?.image_512 || data?.[0]?.image_128;
    if (!base64) throw new Error('Odoo no devolvió la foto');
    return { base64, mimetype: 'image/jpeg' };
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
