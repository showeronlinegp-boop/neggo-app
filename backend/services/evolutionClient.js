// Cliente HTTP de Evolution API v2. La clave va en el header apikey y nunca se loguea.

const { assertSendable } = require('./whatsappMessage');

const DEFAULT_TIMEOUT_MS = 20000;
const SEND_TIMEOUT_MS = 60000;

class EvolutionError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'EvolutionError';
        this.status = status;
    }
}

function readInstance(envName, fallback) {
    const instance = process.env[envName] || fallback;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(instance)) {
        throw new EvolutionError(`${envName} inválida`);
    }
    return instance;
}

function config(which = 'grupo') {
    const baseUrl = String(process.env.EVOLUTION_API_URL || 'http://evolution:8080').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY || '';
    const groups = readInstance('EVOLUTION_INSTANCE', 'neggo');
    const status = readInstance('EVOLUTION_STATUS_INSTANCE', 'neggo-estados');
    if (groups === status) {
        throw new EvolutionError('La instancia de estados tiene que ser distinta de la de grupos');
    }
    const destino = which === 'estado' ? 'estado' : 'grupo';
    return {
        baseUrl,
        apiKey,
        instance: destino === 'estado' ? status : groups,
        destino,
    };
}

function extractQr(payload) {
    const qr = payload?.qrcode && typeof payload.qrcode === 'object' ? payload.qrcode : payload;
    const base64 = qr?.base64 || payload?.base64 || null;
    return {
        base64,
        pairingCode: qr?.pairingCode || payload?.pairingCode || null,
        count: qr?.count ?? payload?.count ?? null,
    };
}

function connectionStateOf(payload) {
    return payload?.instance?.state || payload?.state || payload?.instance?.status || null;
}

function normalizeGroups(payload) {
    const list = Array.isArray(payload) ? payload : (payload?.groups || payload?.data || []);
    if (!Array.isArray(list)) return [];
    return list
        // La comunidad "madre" no acepta mensajes (WhatsApp responde 420): se publica en su grupo de avisos.
        .filter((g) => !g.isCommunity)
        .map((g) => ({
            jid: g.id || g.jid || g.remoteJid || null,
            subject: `${g.subject || g.name || g.id || 'Grupo'}${g.isCommunityAnnounce ? ' (avisos de la comunidad)' : ''}`,
            size: Number.isFinite(Number(g.size)) ? Number(g.size) : null,
        }))
        .filter((g) => typeof g.jid === 'string' && g.jid.endsWith('@g.us'));
}

async function request(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const { baseUrl, apiKey } = config();
    if (!apiKey) {
        throw new EvolutionError('Falta EVOLUTION_API_KEY en el entorno');
    }
    let response;
    try {
        response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                apikey: apiKey,
                'Content-Type': 'application/json',
            },
            body: body == null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new EvolutionError(`Evolution API no responde (${err.message})`);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 300) }; }
    }
    if (!response.ok) {
        const detail = payload?.message || payload?.error || payload?.response?.message || text.slice(0, 300);
        const msg = Array.isArray(detail) ? detail.join(', ') : String(detail || response.statusText);
        throw new EvolutionError(`Evolution API ${response.status}: ${msg}`, response.status);
    }
    return payload;
}

async function connectionState(which = 'grupo') {
    const { instance } = config(which);
    const payload = await request(`/instance/connectionState/${encodeURIComponent(instance)}`);
    return connectionStateOf(payload);
}

async function ensureInstance(which = 'grupo') {
    const { instance } = config(which);
    try {
        await connectionState(which);
        return { created: false, instance };
    } catch (err) {
        if (err.status && err.status !== 404) throw err;
    }
    await request('/instance/create', {
        method: 'POST',
        body: {
            instanceName: instance,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true,
            groupsIgnore: which === 'estado',
            readMessages: false,
            alwaysOnline: false,
        },
    });
    return { created: true, instance };
}

async function connectQr(which = 'grupo') {
    const { instance } = config(which);
    await ensureInstance(which);
    const state = await connectionState(which).catch(() => null);
    if (state === 'open') {
        return { connected: true, state, instance, base64: null, pairingCode: null };
    }
    const payload = await request(`/instance/connect/${encodeURIComponent(instance)}`);
    const qr = extractQr(payload);
    return { connected: false, state: state || 'connecting', instance, ...qr };
}

async function fetchGroups() {
    const { instance } = config();
    const payload = await request(
        `/group/fetchAllGroups/${encodeURIComponent(instance)}?getParticipants=false`,
        { timeoutMs: 45000 }
    );
    return normalizeGroups(payload);
}

async function sendImage({ number, caption, base64, fileName }) {
    const { instance } = config();
    if (!number) {
        throw new EvolutionError('Falta el destino para enviar');
    }
    // Último control antes de salir: texto con contenido y foto válida.
    const ready = assertSendable({ caption, base64 });
    const payload = await request(`/message/sendMedia/${encodeURIComponent(instance)}`, {
        method: 'POST',
        timeoutMs: SEND_TIMEOUT_MS,
        body: {
            number,
            mediatype: 'image',
            mimetype: ready.mimetype,
            caption: ready.caption,
            media: ready.base64,
            fileName: fileName || `producto.${ready.mimetype.split('/')[1]}`,
        },
    });
    return payload?.key?.id || payload?.id || null;
}

// Evolution arma el estado como { image: { url: content } }: un base64 suelto lo toma como
// ruta de archivo. Con prefijo data: lo decodifica.
function statusDataUri(base64, mimetype) {
    const raw = String(base64 || '');
    if (raw.startsWith('data:')) return raw;
    return `data:${mimetype || 'image/jpeg'};base64,${raw}`;
}

// allContacts necesita los contactos guardados en la base de Evolution
// (DATABASE_SAVE_DATA_CONTACTS=true). Si no hay, Evolution responde "Contacts not found".
async function sendStatus({ caption, base64, mimetype }) {
    const { instance } = config('estado');
    if (!caption || !base64) {
        throw new EvolutionError('Faltan texto o foto para el estado');
    }
    const payload = await request(`/message/sendStatus/${encodeURIComponent(instance)}`, {
        method: 'POST',
        timeoutMs: SEND_TIMEOUT_MS,
        body: {
            type: 'image',
            content: statusDataUri(base64, mimetype),
            caption,
            backgroundColor: '#1F3A68',
            font: 1,
            allContacts: true,
            statusJidList: [],
        },
    });
    return payload?.key?.id || payload?.id || null;
}

module.exports = {
    EvolutionError,
    config,
    instanceName: (which) => config(which).instance,
    extractQr,
    connectionStateOf,
    normalizeGroups,
    connectionState,
    ensureInstance,
    connectQr,
    fetchGroups,
    sendImage,
    sendStatus,
    statusDataUri,
};
