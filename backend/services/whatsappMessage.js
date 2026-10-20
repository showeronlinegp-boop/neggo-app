// Validación de un mensaje de WhatsApp antes de mandarlo: nunca sale sin texto o sin foto.

const MIN_IMAGE_BYTES = 200;

class EmptyMessageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EmptyMessageError';
    }
}

// Tipo real de la foto por sus primeros bytes. Odoo puede devolver JPEG, PNG, WEBP o GIF.
function detectMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
    return null;
}

/**
 * Devuelve { caption, base64, mimetype } listos para mandar, o tira EmptyMessageError.
 * @param {{ caption: string, base64: string }} msg
 */
function assertSendable({ caption, base64 }) {
    const text = String(caption ?? '').trim();
    if (!/[\p{L}\p{N}]/u.test(text)) {
        throw new EmptyMessageError('Mensaje sin texto: no se manda');
    }
    const raw = String(base64 ?? '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        throw new EmptyMessageError('Mensaje sin foto: no se manda');
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < MIN_IMAGE_BYTES) {
        throw new EmptyMessageError('La foto está vacía o rota: no se manda');
    }
    const mimetype = detectMime(buf);
    if (!mimetype) {
        throw new EmptyMessageError('Lo que vino de Odoo no es una foto: no se manda');
    }
    return { caption: text, base64: raw, mimetype };
}

// Link a la ficha del producto en la web. base: ODOO_URL (o WHATSAPP_SHOP_URL si se define).
function productLink(websiteUrl, base = process.env.WHATSAPP_SHOP_URL || process.env.ODOO_URL) {
    const path = String(websiteUrl || '').trim();
    const root = String(base || '').trim().replace(/\/+$/, '');
    if (!path || !root || !path.startsWith('/')) return null;
    return `${root}${path}`;
}

function withLink(caption, link) {
    return link ? `${caption}\n${link}` : caption;
}

module.exports = { EmptyMessageError, assertSendable, detectMime, productLink, withLink, MIN_IMAGE_BYTES };
