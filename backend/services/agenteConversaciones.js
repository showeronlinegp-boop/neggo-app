// API del agente (Grok Bot): conversaciones del WhatsApp del negocio de un día. Lógica pura, sin I/O.
// Los mensajes los guarda el contenedor neggo-evolution-negocio en el esquema evolution_negocio de la
// misma base (solo registra: ese número no manda nada). La lectura está en agenteService.js
// (listarConversaciones). Tests en agenteConversaciones.test.js.
// Retención: la depuración semanal (neggo-whatsapp-negocio/depurar.ps1) borra lo de más de 7 días.

const AR_OFFSET_MS = -3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const RETENCION_DIAS = 7;

// Mensajes que no son parte de la charla: borrados, reacciones, claves de cifrado de grupos
const TIPOS_IGNORADOS = ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];

const TIPOS = {
    conversation: 'texto',
    extendedTextMessage: 'texto',
    imageMessage: 'foto',
    audioMessage: 'audio',
    videoMessage: 'video',
    ptvMessage: 'video',
    documentMessage: 'documento',
    documentWithCaptionMessage: 'documento',
    stickerMessage: 'sticker',
    locationMessage: 'ubicacion',
    liveLocationMessage: 'ubicacion',
    contactMessage: 'contacto',
    contactsArrayMessage: 'contacto',
    albumMessage: 'album',
    pollCreationMessage: 'encuesta',
    pollCreationMessageV3: 'encuesta',
};

/** Fecha YYYY-MM-DD de Argentina para un instante. */
function fechaAr(ms) {
    return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Ayer en Argentina. */
function ayerAr(now = new Date()) {
    return fechaAr(now.getTime() - DIA_MS);
}

/** [desde, hasta) en segundos epoch para un día de Argentina (00:00 a 00:00 del día siguiente). */
function rangoDia(fecha) {
    const desde = Date.parse(`${fecha}T00:00:00-03:00`) / 1000;
    return { desde, hasta: desde + DIA_MS / 1000 };
}

/** Datetime ISO con offset de Argentina para un epoch en segundos. */
function isoAr(segundos) {
    return new Date(segundos * 1000 + AR_OFFSET_MS).toISOString().slice(0, 19) + '-03:00';
}

/** Número de un JID de WhatsApp (549...@s.whatsapp.net). Los @lid no traen número: null. */
function numeroDeJid(jid) {
    const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid || '');
    return m ? `+${m[1]}` : null;
}

/**
 * Lo que hay que poner en la lupa de WhatsApp Web para abrir un chat sin número: los dígitos antes
 * de "@lid" (189738854133918@lid → "189738854133918"). Para los que no son @lid: null.
 */
function buscarEnWhatsapp(jid) {
    const m = /^(\d+)@lid$/.exec(jid || '');
    return m ? m[1] : null;
}

/**
 * Cómo sale el chat en la API del agente: los @lid solo con el número (sin "@lid"); los demás, igual.
 */
function chatParaApi(jid) {
    return buscarEnWhatsapp(jid) || jid;
}

/** Nombre que se puso la persona en WhatsApp; los que son solo dígitos (el lid) no sirven. */
function nombreUtil(nombre) {
    const s = (nombre || '').trim();
    return s && !/^[\d\s+]+$/.test(s) ? s : null;
}

/** Texto de un mensaje de Baileys: el cuerpo, la leyenda de la foto o el nombre del archivo. */
function textoDe(message) {
    if (!message || typeof message !== 'object') return null;
    const t = message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || message.documentWithCaptionMessage?.message?.documentMessage?.caption
        || message.documentMessage?.fileName
        || message.documentWithCaptionMessage?.message?.documentMessage?.fileName
        || message.contactMessage?.displayName
        || message.locationMessage?.name
        || message.pollCreationMessageV3?.name
        || message.pollCreationMessage?.name
        || message.buttonsMessage?.contentText
        || message.interactiveMessage?.body?.text
        || null;
    return t && String(t).trim() ? String(t) : null;
}

/** El chat entra en la respuesta: nada de estados ni canales, y grupos solo si se piden. */
function chatValido(jid, incluirGrupos) {
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false;
    if (jid.endsWith('@g.us')) return incluirGrupos;
    return true;
}

/**
 * Agrupa los mensajes de un día por chat.
 * @param {object[]} filas filas de evolution_negocio."Message" con key, pushName, participant,
 *   messageType, message, contextInfo, messageTimestamp, y chat_nombre (de "Chat").
 * @param {{ incluirGrupos?: boolean }} opciones
 * @returns {object[]} un elemento por chat, del que tuvo el último mensaje más nuevo al más viejo
 */
function agruparConversaciones(filas, { incluirGrupos = false } = {}) {
    const chats = new Map();
    const vistos = new Set();
    for (const f of filas) {
        const key = f.key || {};
        const jid = key.remoteJid;
        if (TIPOS_IGNORADOS.includes(f.messageType) || !chatValido(jid, incluirGrupos)) continue;
        // Baileys a veces guarda dos veces el mismo mensaje (reintentos)
        const idUnico = `${jid}|${key.id}`;
        if (key.id && vistos.has(idUnico)) continue;
        vistos.add(idUnico);

        const texto = textoDe(f.message);
        const tipo = TIPOS[f.messageType] || 'otro';
        // Un texto vacío no dice nada (son los reintentos de Baileys que llegan como conversation: "")
        if (tipo === 'texto' && !texto) continue;

        const esGrupo = jid.endsWith('@g.us');
        const deNeggo = key.fromMe === true || key.fromMe === 'true';
        if (!chats.has(jid)) {
            chats.set(jid, {
                chat: jid,
                numero: numeroDeJid(jid) || numeroDeJid(key.remoteJidAlt),
                nombre: nombreUtil(f.chat_nombre),
                es_grupo: esGrupo,
                mensajes: [],
            });
        }
        const c = chats.get(jid);
        if (!c.numero) c.numero = numeroDeJid(key.remoteJidAlt);
        // En un chat privado, el nombre es el que se puso el cliente (no el de Neggo)
        if (!esGrupo && !deNeggo && !c.nombre) c.nombre = nombreUtil(f.pushName);

        const ts = Number(f.messageTimestamp);
        const mensaje = {
            id: key.id || null,
            fecha: isoAr(ts),
            de: deNeggo ? 'neggo' : 'cliente',
            tipo,
            texto,
            responde_a: f.contextInfo?.stanzaId || null,
            _ts: ts,
        };
        if (tipo === 'otro') mensaje.tipo_original = f.messageType || null;
        if (esGrupo && !deNeggo) {
            mensaje.autor = nombreUtil(f.pushName);
            mensaje.autor_numero = numeroDeJid(f.participant || key.participant || key.participantAlt);
        }
        c.mensajes.push(mensaje);
    }

    const out = [];
    for (const c of chats.values()) {
        c.mensajes.sort((a, b) => a._ts - b._ts);
        const ultimo = c.mensajes[c.mensajes.length - 1];
        out.push({
            chat: c.chat,
            numero: c.numero,
            nombre: c.nombre,
            es_grupo: c.es_grupo,
            cantidad_mensajes: c.mensajes.length,
            mensajes_cliente: c.mensajes.filter((m) => m.de === 'cliente').length,
            primer_mensaje: c.mensajes[0].fecha,
            ultimo_mensaje: ultimo.fecha,
            ultimo_de: ultimo.de,
            sin_respuesta: ultimo.de === 'cliente',
            mensajes: c.mensajes.map(({ _ts, ...m }) => m),
            _ts: ultimo._ts,
        });
    }
    out.sort((a, b) => b._ts - a._ts || (a.chat < b.chat ? -1 : 1));
    return out.map(({ _ts, ...c }) => c);
}

/**
 * Suma al chat lo que se sabe de quién es (whatsapp_chat_identidad) y el nombre de la agenda.
 * identificado_por = null cuando no se sabe.
 */
function conIdentidad(chat, identidad, nombreAgenda) {
    const { mensajes, ...resto } = chat;
    const numero = chat.numero || (identidad && identidad.numero) || null;
    return {
        ...resto,
        chat: chatParaApi(chat.chat),
        numero,
        buscar_en_whatsapp: numero ? null : buscarEnWhatsapp(chat.chat),
        nombre: (identidad && identidad.nombre) || nombreAgenda || chat.nombre,
        cliente_id: (identidad && identidad.cliente_id) || null,
        identificado_por: identidad ? { fuente: identidad.fuente, confianza: identidad.confianza } : null,
        mensajes,
    };
}

module.exports = {
    conIdentidad,
    RETENCION_DIAS,
    TIPOS_IGNORADOS,
    fechaAr,
    ayerAr,
    rangoDia,
    isoAr,
    numeroDeJid,
    buscarEnWhatsapp,
    chatParaApi,
    nombreUtil,
    textoDe,
    agruparConversaciones,
};
