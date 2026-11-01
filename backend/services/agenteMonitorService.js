// Monitoreo de la API del agente (Grok Bot) para el equipo: pestaña "Bot de seguimiento" en Clientes.
// Solo lectura: qué salió, qué no salió y por qué, qué contestaron los clientes, qué registró el bot
// de cada contacto y qué pedidos le rechazó la API. La lógica pura (motivos y resumen) está testeada
// en agenteMonitor.test.js.

const pool = require('../config/database');
const { callOdoo } = require('../config/odoo');
const { ensureSchema } = require('./crmSchema');
const agente = require('./agenteService');
const nuevos = require('./agenteNuevos');
const health = require('./clientHealth');

const COMPANY = 'neggo';
const DIAS_DEFAULT = 7;
const DIAS_MAX = 90;
const MAX_FILAS = 300;
const COLA_LIMIT = 1000;

// Por qué un cliente al que le toca mensaje hoy todavía no lo recibió (en el orden en que se chequea)
const MOTIVOS = {
    reservado: 'Reservado: el bot lo está mandando',
    no_contactar: 'Pidió que no le escriban',
    sin_telefono: 'No tiene un celular válido en Odoo',
    respuesta_pendiente: 'Contestó y el bot todavía no leyó la respuesta',
    fuera_de_horario: 'Fuera del horario de envío',
    pendiente: 'El bot todavía no lo mandó',
};

// Qué significa cada código de rechazo de la API, para el equipo
const CODIGOS = {
    datos_invalidos: 'Datos inválidos',
    no_encontrado: 'Cliente o envío inexistente',
    no_contactar: 'El cliente pidió que no le escriban',
    transicion_invalida: 'Cambio de etapa no permitido',
    id_externo_usado: 'Identificador repetido con otro cliente',
    id_externo_distinto: 'Identificador repetido con otro mensaje',
    reserva_cancelada: 'La reserva ya estaba cancelada',
    reserva_vencida: 'La reserva venció',
    fuera_de_horario: 'Fuera del horario de envío',
    sin_telefono: 'Sin celular válido en Odoo',
    ya_enviado: 'Esa etapa ya se había mandado',
    etapa_reservada: 'Esa etapa ya estaba reservada',
    respuesta_pendiente: 'El cliente contestó y falta leer la respuesta',
    etapa_no_corresponde: 'No le tocaba ese mensaje hoy',
    odoo_caido: 'No se pudo leer Odoo',
    error_interno: 'Error del servidor',
};

function validarDias(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) return DIAS_DEFAULT;
    return Math.min(n, DIAS_MAX);
}

/**
 * Estado de hoy de un cliente de la cadencia (formato de agente.listarNuevos):
 * { estado: 'toca' | 'al_dia' | 'cerrado', motivo: clave de MOTIVOS o null }.
 */
function estadoCola(c, ventanaAbierta) {
    if (c.no_contactar) return { estado: 'cerrado', motivo: 'no_contactar' };
    if (c.seguimiento && c.seguimiento.etapa === 'finalizado') return { estado: 'cerrado', motivo: null };
    if (!c.toca_hoy) return { estado: 'al_dia', motivo: null };
    if (c.reserva_activa) return { estado: 'toca', motivo: 'reservado' };
    if (!c.telefono) return { estado: 'toca', motivo: 'sin_telefono' };
    if (c.respuesta_pendiente) return { estado: 'toca', motivo: 'respuesta_pendiente' };
    if (!ventanaAbierta) return { estado: 'toca', motivo: 'fuera_de_horario' };
    return { estado: 'toca', motivo: 'pendiente' };
}

/** Contadores del período a partir de las interacciones y los rechazos ya leídos. */
function resumir({ interacciones, rechazos, cola }) {
    const r = {
        enviados: 0, cancelados: 0, vencidos: 0, reservados: 0, recibidos: 0, notas: 0,
        rechazos: rechazos.length,
        toca_hoy: null, sin_enviar_hoy: null, en_cadencia: null,
    };
    for (const i of interacciones) {
        if (i.tipo === 'recibido') r.recibidos += 1;
        else if (!i.envio_etapa) r.notas += 1;
        else if (i.estado === 'enviado') r.enviados += 1;
        else if (i.estado === 'cancelado') r.cancelados += 1;
        else if (i.estado === 'vencido') r.vencidos += 1;
        else if (i.estado === 'reservado') r.reservados += 1;
    }
    if (cola) {
        r.en_cadencia = cola.filter((c) => c.estado !== 'cerrado').length;
        r.toca_hoy = cola.filter((c) => c.estado === 'toca').length;
        r.sin_enviar_hoy = cola.filter((c) => c.estado === 'toca' && c.motivo !== 'reservado').length;
    }
    return r;
}

/** Cliente al que apunta un path de la API (/clientes/123/envios → 123), o null. */
function clienteDePath(path) {
    const m = /^\/clientes\/(\d+)/.exec(path || '');
    return m ? parseInt(m[1], 10) : null;
}

/** Envío al que apunta un path (/envios/grok-1595-dia_1/confirmar → grok-1595-dia_1), o null. */
function envioDePath(path) {
    const m = /^\/envios\/([^/]+)/.exec(path || '');
    return m ? decodeURIComponent(m[1]) : null;
}

/** Qué intentó hacer el bot con ese pedido, en palabras del equipo. */
function accionDePath(method, path) {
    const p = path || '';
    if (/\/envios\/[^/]+\/confirmar$/.test(p)) return 'Confirmar envío';
    if (/\/envios\/[^/]+\/cancelar$/.test(p)) return 'Cancelar envío';
    if (/^\/clientes\/\d+\/envios$/.test(p)) return 'Reservar envío';
    if (/^\/clientes\/\d+\/interacciones$/.test(p)) return 'Registrar mensaje';
    if (/^\/clientes\/\d+\/revisado$/.test(p)) return 'Marcar respuestas leídas';
    if (/^\/clientes\/\d+\/seguimiento$/.test(p)) return 'Cambiar seguimiento';
    if (/^\/clientes\/\d+$/.test(p) && method === 'PATCH') return 'Actualizar contacto';
    if (p === '/feedback') return 'Dejar feedback';
    return `${method} ${p}`;
}

// =============================================
// Lectura
// =============================================

async function nombres(ids) {
    if (!ids.length) return new Map();
    const { rows } = await pool.query(
        'SELECT odoo_partner_id, partner_name, phone FROM client_metrics_cache WHERE company = $1 AND odoo_partner_id = ANY($2::int[])',
        [COMPANY, ids]);
    return new Map(rows.map((r) => [r.odoo_partner_id, { nombre: r.partner_name, telefono: r.phone }]));
}

/** Nombre de los productos recomendados (product.product). Si Odoo falla, quedan solo los ids. */
async function nombresProductos(ids) {
    if (!ids.length) return new Map();
    try {
        const rows = await callOdoo('product.product', 'read', [ids.slice(0, 500)], { fields: ['display_name', 'default_code'] });
        return new Map(rows.map((r) => [r.id, { nombre: r.display_name, sku: r.default_code || null }]));
    } catch (err) {
        console.error('⚠️ Monitor del bot: no se pudieron leer los productos de Odoo:', err.message);
        return new Map();
    }
}

async function leerInteracciones(desde) {
    const { rows } = await pool.query(
        `SELECT id, odoo_partner_id, fecha, tipo, etapa, mensaje, envio_etapa, estado, motivo_cancelacion,
                productos_recomendados, id_externo, created_at
         FROM crm_bot_interacciones
         WHERE fecha >= $1 OR created_at >= $1
         ORDER BY fecha DESC, id DESC
         LIMIT $2`, [desde, MAX_FILAS]);
    return rows;
}

async function leerRechazos(desde) {
    const { rows } = await pool.query(
        `SELECT id, action, metadata, created_at
         FROM activity_log
         WHERE module = 'agente' AND created_at >= $1 AND (metadata->>'status')::int >= 400
         ORDER BY created_at DESC, id DESC
         LIMIT $2`, [desde, MAX_FILAS]);
    return rows.map((r) => {
        const m = r.metadata || {};
        return {
            id: r.id,
            fecha: nuevos.toArIso(r.created_at),
            accion: accionDePath(r.action, m.path),
            cliente_id: clienteDePath(m.path),
            id_externo: envioDePath(m.path),
            status: Number(m.status),
            codigo: m.codigo || null,
            motivo: (m.codigo && CODIGOS[m.codigo]) || (Number(m.status) >= 500 ? 'Error del servidor' : 'Pedido rechazado'),
        };
    });
}

/** Lo que el bot registró de cada contacto: persona de contacto, no contactar, etapa y última respuesta. */
async function leerContactos() {
    const { rows } = await pool.query(
        `SELECT s.odoo_partner_id, s.etapa, s.contacto, s.no_contactar, s.no_contactar_at, s.ultimo_contacto,
                s.proxima_accion::text AS proxima_accion, s.revisado_hasta, s.updated_at,
                r.mensaje AS ultima_respuesta, r.fecha AS ultima_respuesta_fecha,
                (SELECT COUNT(*)::int FROM crm_bot_interacciones e
                 WHERE e.odoo_partner_id = s.odoo_partner_id AND e.tipo = 'enviado' AND e.estado = 'enviado') AS enviados
         FROM crm_bot_seguimiento s
         LEFT JOIN LATERAL (
             SELECT mensaje, fecha FROM crm_bot_interacciones i
             WHERE i.odoo_partner_id = s.odoo_partner_id AND i.tipo = 'recibido'
             ORDER BY fecha DESC, id DESC LIMIT 1
         ) r ON true
         ORDER BY s.updated_at DESC NULLS LAST
         LIMIT $1`, [MAX_FILAS]);
    return rows;
}

async function leerFeedback() {
    const { rows } = await pool.query(
        'SELECT id, tipo, endpoint, mensaje, created_at FROM crm_bot_feedback ORDER BY created_at DESC, id DESC LIMIT 50');
    return rows.map((r) => ({ id: r.id, tipo: r.tipo, endpoint: r.endpoint, mensaje: r.mensaje, fecha: nuevos.toArIso(r.created_at) }));
}

/** Clientes nuevos de la cadencia con su estado de hoy. Si Odoo no responde, null y el motivo. */
async function leerCola(refresh) {
    try {
        const { data, meta } = await agente.listarNuevos({
            dias: nuevos.DIAS_DEFAULT, no_contactar: null, page: 1, limit: COLA_LIMIT, offset: 0, refresh,
        });
        const cola = data.map((c) => {
            const { estado, motivo } = estadoCola(c, meta.ventana_abierta);
            return {
                id: c.id,
                nombre: c.nombre,
                telefono: c.telefono,
                ciudad: c.ciudad,
                contacto: c.contacto,
                fecha_primera_compra: c.fecha_primera_compra,
                dias_desde_compra: c.dias_desde_compra,
                etapa: c.seguimiento.etapa,
                ultimo_contacto: c.seguimiento.ultimo_contacto,
                toca_hoy: c.toca_hoy,
                vence: c.vence,
                reserva_activa: c.reserva_activa,
                ultimo_recibido: c.ultimo_recibido,
                estado,
                motivo,
                motivo_texto: motivo ? MOTIVOS[motivo] : null,
            };
        });
        return { cola, meta, error: null };
    } catch (err) {
        console.error('⚠️ Monitor del bot: no se pudo armar la cola de hoy:', err.message);
        return { cola: null, meta: null, error: err.message || 'No se pudo leer Odoo' };
    }
}

/**
 * GET /api/clientes/bot: todo lo de la pestaña en una sola respuesta.
 * dias = período de la actividad y los rechazos (1 = hoy). La cola de hoy siempre es la de la cadencia.
 */
async function monitor({ dias: rawDias, refresh = false } = {}) {
    await ensureSchema();
    const dias = validarDias(rawDias);
    const hoy = health.toArDate(new Date());
    const desdeFecha = nuevos.desdeVentana(hoy, dias);
    // 00:00 de Argentina del primer día, en UTC (las columnas sin zona guardan UTC)
    const desde = `${desdeFecha}T03:00:00Z`;

    const [interacciones, rechazos, contactosRows, feedback, colaRes] = await Promise.all([
        leerInteracciones(desde),
        leerRechazos(desde),
        leerContactos(),
        leerFeedback(),
        leerCola(refresh),
    ]);

    const ids = [...new Set([
        ...interacciones.map((i) => i.odoo_partner_id),
        ...contactosRows.map((c) => c.odoo_partner_id),
        ...rechazos.map((r) => r.cliente_id).filter(Boolean),
    ])];
    const porId = await nombres(ids);
    // Los clientes nuevos de la cola pueden no estar todavía en la caché del CRM
    for (const c of colaRes.cola || []) if (!porId.has(c.id)) porId.set(c.id, { nombre: c.nombre, telefono: c.telefono });
    const nombreDe = (id) => (porId.get(id) && porId.get(id).nombre) || `Cliente #${id}`;

    const prodIds = [...new Set(interacciones.flatMap((i) => i.productos_recomendados || []))];
    const productos = await nombresProductos(prodIds);

    return {
        periodo: { dias, desde: desdeFecha, hasta: hoy },
        meta: colaRes.meta,
        resumen: resumir({ interacciones, rechazos, cola: colaRes.cola }),
        cola: colaRes.cola,
        cola_error: colaRes.error,
        actividad: interacciones.map((i) => ({
            id: i.id,
            cliente_id: i.odoo_partner_id,
            cliente: nombreDe(i.odoo_partner_id),
            fecha: nuevos.toArIso(i.fecha),
            tipo: i.tipo,
            etapa: i.etapa,
            envio_de_etapa: i.envio_etapa,
            estado: i.envio_etapa ? i.estado : null,
            motivo_cancelacion: i.estado === 'cancelado' ? i.motivo_cancelacion || 'agente' : null,
            mensaje: i.mensaje,
            productos: (i.productos_recomendados || []).map((id) => ({ id, ...(productos.get(id) || { nombre: `Producto #${id}`, sku: null }) })),
            id_externo: i.id_externo,
        })),
        contactos: contactosRows.map((c) => ({
            cliente_id: c.odoo_partner_id,
            cliente: nombreDe(c.odoo_partner_id),
            telefono: porId.get(c.odoo_partner_id) ? porId.get(c.odoo_partner_id).telefono : null,
            etapa: c.etapa,
            contacto: c.contacto,
            no_contactar: c.no_contactar,
            no_contactar_at: c.no_contactar_at ? nuevos.toArIso(c.no_contactar_at) : null,
            ultimo_contacto: c.ultimo_contacto ? nuevos.toArIso(c.ultimo_contacto) : null,
            proxima_accion: c.proxima_accion,
            enviados: c.enviados,
            ultima_respuesta: c.ultima_respuesta,
            ultima_respuesta_fecha: c.ultima_respuesta_fecha ? nuevos.toArIso(c.ultima_respuesta_fecha) : null,
            actualizado: c.updated_at ? nuevos.toArIso(c.updated_at) : null,
        })),
        rechazos: rechazos.map((r) => ({ ...r, cliente: r.cliente_id ? nombreDe(r.cliente_id) : null })),
        feedback,
    };
}

module.exports = {
    monitor,
    estadoCola,
    resumir,
    clienteDePath,
    envioDePath,
    accionDePath,
    validarDias,
    MOTIVOS,
    CODIGOS,
};
