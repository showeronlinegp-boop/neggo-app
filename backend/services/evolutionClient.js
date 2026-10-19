// Cliente HTTP de Evolution API v2. La clave va en el header apikey y nunca se loguea.

const DEFAULT_TIMEOUT_MS = 20000;
const SEND_TIMEOUT_MS = 60000;

class EvolutionError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'EvolutionError';
        this.status = status;
    }
}

function config() {
    const baseUrl = String(process.env.EVOLUTION_API_URL || 'http://evolution:8080').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY || '';
    const instance = process.env.EVOLUTION_INSTANCE || 'neggo';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(instance)) {
        throw new EvolutionError('EVOLUTION_INSTANCE inválida');
    }
    return { baseUrl, apiKey, instance };
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
        .map((g) => ({
            jid: g.id || g.jid || g.remoteJid || null,
            subject: g.subject || g.name || g.id || 'Grupo',
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

async function connectionState() {
    const { instance } = config();
    const payload = await request(`/instance/connectionState/${encodeURIComponent(instance)}`);
    return connectionStateOf(payload);
}

async function ensureInstance() {
    const { instance } = config();
    try {
        await connectionState();
        return { created: false };
    } catch (err) {
        if (err.status && err.status !== 404) throw err;
    }
    await request('/instance/create', {
        method: 'POST',
        body: {
            instanceName: instance,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true,
            groupsIgnore: false,
            readMessages: false,
            alwaysOnline: false,
        },
    });
    return { created: true };
}

async function connectQr() {
    const { instance } = config();
    await ensureInstance();
    const state = await connectionState().catch(() => null);
    if (state === 'open') {
        return { connected: true, state, base64: null, pairingCode: null };
    }
    const payload = await request(`/instance/connect/${encodeURIComponent(instance)}`);
    const qr = extractQr(payload);
    return { connected: false, state: state || 'connecting', ...qr };
}

async function fetchGroups() {
    const { instance } = config();
    const payload = await request(
        `/group/fetchAllGroups/${encodeURIComponent(instance)}?getParticipants=false`,
        { timeoutMs: 45000 }
    );
    return normalizeGroups(payload);
}

async function sendImage({ number, caption, base64, fileName, mimetype }) {
    const { instance } = config();
    if (!number || !caption || !base64) {
        throw new EvolutionError('Faltan destino, texto o foto para enviar');
    }
    const payload = await request(`/message/sendMedia/${encodeURIComponent(instance)}`, {
        method: 'POST',
        timeoutMs: SEND_TIMEOUT_MS,
        body: {
            number,
            mediatype: 'image',
            mimetype: mimetype || 'image/jpeg',
            caption,
            media: base64,
            fileName: fileName || 'producto.jpg',
        },
    });
    return payload?.key?.id || payload?.id || null;
}

module.exports = {
    EvolutionError,
    config,
    extractQr,
    connectionStateOf,
    normalizeGroups,
    connectionState,
    ensureInstance,
    connectQr,
    fetchGroups,
    sendImage,
};
