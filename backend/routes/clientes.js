// Rutas del CRM de clientes
// GET    /api/clientes?search=&city=&rubro=&health=&stage=&open=1&importancia=&sort=prioridad|importancia|facturacion|ultima|compras|nombre|accion&limit=&offset=
// GET    /api/clientes/resumen        — contadores por estado y etapa, facturación, ciudades, rubros y última actualización
// POST   /api/clientes/sync           — vuelve a calcular las métricas desde Odoo
// El listado también acepta cercanos=1: solo la lista de seguimiento cercano
// PUT    /api/clientes/cercanos/:partnerId — { cercano: true|false } suma o saca de esa lista
//
// Posibles clientes (D11)
// GET    /api/clientes/leads?search=&status=&stage=&city=&presentacion=sin|con&celular=1&sort=recientes|nombre|accion&limit=&offset=
// GET    /api/clientes/leads/resumen
// POST   /api/clientes/leads          — alta a mano { name, phone, email, city }
// POST   /api/clientes/leads/importar — { csv, dry_run } CSV de Google Contacts (solo admin)
// GET    /api/clientes/leads/bot      — lo que hace Grok Bot con los posibles clientes (tope del día, respuestas)
// POST   /api/clientes/leads/sumar-bot — { ids } los suma a la cola de Grok, primeros (tablero de WhatsApp)
// GET    /api/clientes/leads/:id
// POST   /api/clientes/leads/:id/asignar — { partner_id }: es otro contacto de ese cliente de Odoo
// GET    /api/clientes/leads/:id/whatsapp — chats del WhatsApp del negocio vinculados y candidatos para vincular a mano
// POST   /api/clientes/leads/:id/whatsapp — { chat }: este chat es de este posible cliente
// DELETE /api/clientes/leads/:id/whatsapp/:chat — saca el vínculo (no se vuelve a poner solo)
//
// Preguntas frecuentes y sus respuestas (066)
// GET    /api/clientes/respuestas
// POST   /api/clientes/respuestas            — { pregunta, respuesta?, informar_a_todos?, activa? }
// PUT    /api/clientes/respuestas/:id        — lo mismo, solo lo que cambia
// POST   /api/clientes/respuestas/:id/mover  — { direccion: -1 | 1 } sube o baja un lugar
// DELETE /api/clientes/respuestas/:id
//
// Ficha comercial del prospecto y pantalla Contactos (067)
// GET    /api/clientes/contactos?grupo=activos|abiertos|dormidos|sinchat&tipo=todos|prospecto|cliente&q=&solo_esperan=&limit=&offset=
// GET    /api/clientes/chats?filtro=todos|esperan|prospecto|cliente|dormidos&q=&limit=&offset= — lista estilo WhatsApp
// GET    /api/clientes/chats/:chat/mensajes       — conversación de los últimos 7 días (con los otros chats del contacto)
//
// Grupo de avisos de la comunidad (068, nota 228). Los chats traen grupo_avisos: { estado: miembro | salio | no_esta, desde, salio_at } | null
// GET    /api/clientes/grupo-avisos               — miembros, entradas y salidas, quiénes son
// POST   /api/clientes/grupo-avisos/actualizar    — saca la foto de miembros ahora (solo lee WhatsApp)
// GET    /api/clientes/leads/:id/ficha            — charla de 7 días, resumen, objetivos, lo que pidió y cotizaciones
// PUT    /api/clientes/leads/:id/perfil           — { ciudad, tiene_local, rubro, intereses, …, resumen }
// PUT    /api/clientes/leads/:id/nombre           — { nombre } a mano; vacío = vuelve el de WhatsApp
// PUT    /api/clientes/leads/:id/informado/:respuestaId — { hecho } objetivo Informar a mano
// PUT    /api/clientes/leads/:id/presentacion     — { hecho } objetivo Presentar a mano (nota 233)
// POST   /api/clientes/leads/:id/pedido           — { texto, cantidad?, product_id?, chat?, mensaje_id? }
// PUT    /api/clientes/leads/:id/pedido/:itemId   — lo mismo, solo lo que cambia
// DELETE /api/clientes/leads/:id/pedido/:itemId
// GET    /api/clientes/productos-neggo?q=         — productos activos de Neggo para elegir el del pedido
// GET    /api/clientes/leads/:id/contactos-odoo   — contactos de Odoo parecidos (para no duplicar)
// POST   /api/clientes/leads/:id/cotizar          — { cliente_id | crear_contacto: true } cotización en borrador en Odoo
//
// Seguimiento (fase 2). :tipo = cliente | lead
// GET    /api/clientes/mi-dia?mias=1
// GET    /api/clientes/seguimiento/:tipo/:id           — etapa, acciones pendientes e historial
// PUT    /api/clientes/seguimiento/:tipo/:id/etapa     — { stage, reason }
// PUT    /api/clientes/seguimiento/:tipo/:id/importancia — { importance } de 0 a 5
// PUT    /api/clientes/importancia                     — { partner_ids, importance }: varios clientes juntos
// POST   /api/clientes/seguimiento/:tipo/:id/eventos   — { kind, text }
// POST   /api/clientes/seguimiento/:tipo/:id/presentacion — anota el mensaje de presentación mandado por WhatsApp
// POST   /api/clientes/seguimiento/:tipo/:id/acciones  — { type, due_date, note }
// PUT    /api/clientes/acciones/:actionId              — { type, due_date, note }
// POST   /api/clientes/acciones/:actionId/hecha        — { result? }
// POST   /api/clientes/eventos/:eventId/respuesta      — { response: respondio|no_interesa, text? }
//
// Bot de seguimiento (Grok Bot), solo lectura:
// GET    /api/clientes/bot?dias=7&refresh=1 — cola de hoy, actividad, contactos, rechazos y feedback
//
// GET    /api/clientes/:partnerId     — ficha: métricas, cotizaciones recientes y últimos tickets
// PUT    /api/clientes/:partnerId/contacto — { phone, city }: los escribe en el contacto de Odoo

const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const clientes = require('../services/clientMetricsService');
const followups = require('../services/crmFollowupService');
const leads = require('../services/crmLeadService');
const botMonitor = require('../services/agenteMonitorService');
const botLeads = require('../services/agenteLeadsService');
const waLeads = require('../services/whatsappLeadsService');
const respuestas = require('../services/crmRespuestasService');
const fichaService = require('../services/crmFichaService');
const grupoAvisos = require('../services/grupoAvisosService');

const ROLES = ['admin', 'vendedor'];
const auth = [authenticate, requireRole(...ROLES)];

// Errores de validación (FollowupError) van con su mensaje; el resto, genérico
function handle(res, err, generic) {
    if (err instanceof followups.FollowupError) return fail(res, err.message, err.status);
    console.error(`❌ ${generic}:`, err.message);
    return fail(res, generic, 500);
}

router.get('/', ...auth, async (req, res) => {
    try {
        await clientes.refreshIfStale();
        const { rows, total, limit, offset } = await clientes.listClients({
            search: req.query.search,
            city: req.query.city,
            rubro: req.query.rubro,
            health: req.query.health,
            stage: req.query.stage,
            open: req.query.open === '1' || req.query.open === 'true',
            cercanos: req.query.cercanos === '1' || req.query.cercanos === 'true',
            importancia: req.query.importancia,
            sort: req.query.sort,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la lista de clientes');
    }
});

router.get('/resumen', ...auth, async (req, res) => {
    try {
        return ok(res, await clientes.summary());
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el resumen de clientes');
    }
});

router.post('/sync', ...auth, async (req, res) => {
    try {
        const result = await clientes.syncClientMetrics();
        console.log(`✅ CRM: sync pedido por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error en el sync de clientes:', err.message);
        return fail(res, `No se pudieron actualizar los clientes desde Odoo: ${err.message}`, 502);
    }
});

// ── Posibles clientes ────────────────────────────────────────────

router.get('/leads', ...auth, async (req, res) => {
    try {
        const { rows, total, limit, offset } = await leads.listLeads({
            search: req.query.search,
            status: req.query.status,
            stage: req.query.stage,
            city: req.query.city,
            presentacion: req.query.presentacion,
            celular: req.query.celular === '1' || req.query.celular === 'true',
            whatsapp: req.query.whatsapp,
            sort: req.query.sort,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return paginated(res, rows, total, limit, offset);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la lista de posibles clientes');
    }
});

// Posibles clientes con chat de WhatsApp, cada uno con su etapa (embudo)
router.get('/leads/whatsapp-embudo', ...auth, async (req, res) => {
    try {
        const data = await waLeads.embudo();
        // Cada tarjeta dice si se puede sumar al bot de leads (nota 249)
        const ids = data.etapas.flatMap((g) => g.items.map((i) => i.id));
        const bot = await botLeads.estadosBot(ids);
        for (const g of data.etapas) for (const i of g.items) i.bot = bot.get(i.id) || null;
        return ok(res, data);
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudo armar el embudo de WhatsApp');
    }
});

// Suma prospectos del tablero al bot de leads (Grok): quedan primeros en su cola. { ids: [] }
router.post('/leads/sumar-bot', ...auth, async (req, res) => {
    try {
        const r = await botLeads.sumarAlBot((req.body || {}).ids, { userId: req.user.id });
        console.log(`✅ CRM: ${r.sumados.length} prospectos sumados al bot por usuario ${req.user.id} (${r.omitidos.length} omitidos)`);
        return ok(res, r);
    } catch (err) {
        if (err instanceof botLeads.AgenteError) return fail(res, err.message, err.status);
        console.error('❌ No se pudieron sumar al bot:', err.message);
        return fail(res, 'No se pudieron sumar al bot', 500);
    }
});

// Chats ocultos como proveedores y marca a mano { es: true|false }
router.get('/leads/whatsapp-proveedores', ...auth, async (req, res) => {
    try {
        return ok(res, await waLeads.chatsProveedores());
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudieron leer los proveedores de WhatsApp');
    }
});

router.put('/whatsapp/chats/:chat/proveedor', ...auth, async (req, res) => {
    try {
        const { es } = req.body || {};
        const result = await waLeads.marcarProveedorManual(req.params.chat, es !== false);
        fichaService.olvidarChats();
        return ok(res, result);
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudo marcar el chat');
    }
});

router.put('/leads/:id/etapa-whatsapp', ...auth, async (req, res) => {
    try {
        const { etapa, motivo } = req.body || {};
        return ok(res, await waLeads.marcarEtapa(req.params.id, etapa ?? null, { motivo, userId: req.user.id }));
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudo cambiar la etapa');
    }
});

router.get('/leads/resumen', ...auth, async (req, res) => {
    try {
        return ok(res, await leads.leadsSummary());
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el resumen de posibles clientes');
    }
});

router.post('/leads', ...auth, async (req, res) => {
    try {
        const { name, phone, email, city } = req.body || {};
        const result = await leads.createLead({ name, phone, email, city, userId: req.user.id });
        return ok(res, result, 201);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el posible cliente');
    }
});

router.post('/leads/importar', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { csv, dry_run: dryRun } = req.body || {};
        if (!csv) return fail(res, 'Falta el CSV', 400);
        return ok(res, await leads.importGoogleContacts(csv, { userId: req.user.id, dryRun: Boolean(dryRun) }));
    } catch (err) {
        return handle(res, err, 'No se pudieron importar los contactos');
    }
});

router.get('/leads/bot', ...auth, async (req, res) => {
    try {
        return ok(res, await botLeads.resumenBot());
    } catch (err) {
        return handle(res, err, 'No se pudo leer la actividad del bot con posibles clientes');
    }
});

router.get('/leads/:id', ...auth, async (req, res) => {
    try {
        const lead = await leads.getLead(req.params.id);
        if (!lead) return fail(res, 'No encontré ese posible cliente', 404);
        return ok(res, lead);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el posible cliente');
    }
});

router.post('/leads/:id/asignar', ...auth, async (req, res) => {
    try {
        const { partner_id: partnerId } = req.body || {};
        const result = await followups.assignLead(req.params.id, partnerId, req.user.id);
        fichaService.olvidarChats();
        return ok(res, result);
    } catch (err) {
        return handle(res, err, 'No se pudo asignar el posible cliente');
    }
});

// ── Chats del WhatsApp del negocio (CRM WhatsApp, L1) ────────────

// Preguntas frecuentes y sus respuestas (066)
function handleRespuesta(res, err, generic) {
    if (err instanceof respuestas.RespuestaError) {
        return res.status(err.status).json({ success: false, error: err.message, errors: err.errors || undefined });
    }
    return handle(res, err, generic);
}

function idDe(req) {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/respuestas', ...auth, async (req, res) => {
    try {
        return ok(res, await respuestas.listar());
    } catch (err) {
        return handleRespuesta(res, err, 'No se pudieron cargar las preguntas frecuentes');
    }
});

router.post('/respuestas', ...auth, async (req, res) => {
    try {
        return ok(res, await respuestas.crear(req.body, req.user.id), 201);
    } catch (err) {
        return handleRespuesta(res, err, 'No se pudo guardar la pregunta');
    }
});

router.put('/respuestas/:id', ...auth, async (req, res) => {
    const id = idDe(req);
    if (!id) return fail(res, 'Id inválido', 422);
    try {
        return ok(res, await respuestas.editar(id, req.body, req.user.id));
    } catch (err) {
        return handleRespuesta(res, err, 'No se pudo guardar la pregunta');
    }
});

router.post('/respuestas/:id/mover', ...auth, async (req, res) => {
    const id = idDe(req);
    if (!id) return fail(res, 'Id inválido', 422);
    try {
        return ok(res, await respuestas.mover(id, Number((req.body || {}).direccion)));
    } catch (err) {
        return handleRespuesta(res, err, 'No se pudo mover la pregunta');
    }
});

router.delete('/respuestas/:id', ...auth, async (req, res) => {
    const id = idDe(req);
    if (!id) return fail(res, 'Id inválido', 422);
    try {
        return ok(res, await respuestas.borrar(id));
    } catch (err) {
        return handleRespuesta(res, err, 'No se pudo borrar la pregunta');
    }
});

// Ficha comercial del prospecto y pantalla Contactos (067)
function handleFicha(res, err, generic) {
    if (err instanceof fichaService.FichaError) {
        return res.status(err.status).json({ success: false, error: err.message, errors: err.errors || undefined });
    }
    return handle(res, err, generic);
}

router.get('/contactos', ...auth, async (req, res) => {
    try {
        const { tipo, grupo, q, solo_esperan: soloEsperan, limit, offset } = req.query;
        return ok(res, await fichaService.contactos({ tipo, grupo, q, solo_esperan: soloEsperan === 'true' || soloEsperan === '1', limit, offset }));
    } catch (err) {
        return handleFicha(res, err, 'No se pudieron cargar los contactos');
    }
});

router.get('/chats', ...auth, async (req, res) => {
    try {
        const { filtro, q, limit, offset } = req.query;
        const datos = await fichaService.chats({ filtro, q, limit, offset });
        // El grupo de avisos es un extra: si falla, la lista sale igual
        try {
            datos.items = await grupoAvisos.marcarChats(datos.items);
        } catch (err) {
            console.warn('⚠️ No se pudo marcar el grupo de avisos en los chats:', err.message);
        }
        return ok(res, datos);
    } catch (err) {
        return handleFicha(res, err, 'No se pudieron cargar los chats');
    }
});

router.get('/chats/:chat/mensajes', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.mensajesDelChat(req.params.chat));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo cargar la conversación');
    }
});

router.get('/grupo-avisos', ...auth, async (req, res) => {
    try {
        return ok(res, await grupoAvisos.estadisticas());
    } catch (err) {
        return handle(res, err, 'No se pudieron cargar los números del grupo de avisos');
    }
});

router.post('/grupo-avisos/actualizar', ...auth, async (req, res) => {
    try {
        const r = await grupoAvisos.tomarFoto({ origen: 'manual' });
        console.log(`📦 Grupo de avisos (a mano): ${r.total} miembros, ${r.entraron} entraron, ${r.salieron} se fueron`);
        return ok(res, r);
    } catch (err) {
        if (err instanceof grupoAvisos.GrupoAvisosError) return fail(res, err.message, err.status);
        return handle(res, err, 'No se pudo actualizar el grupo de avisos');
    }
});

router.get('/productos-neggo', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.buscarProductos(req.query.q));
    } catch (err) {
        return handleFicha(res, err, 'No se pudieron buscar los productos');
    }
});

router.get('/leads/:id/ficha', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.ficha(req.params.id));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo cargar la ficha');
    }
});

router.put('/leads/:id/perfil', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.guardarPerfil(req.params.id, req.body, req.user.id));
    } catch (err) {
        return handleFicha(res, err, 'No se pudieron guardar los datos');
    }
});

router.put('/leads/:id/nombre', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.renombrar(req.params.id, (req.body || {}).nombre));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo cambiar el nombre');
    }
});

router.put('/leads/:id/informado/:respuestaId', ...auth, async (req, res) => {
    try {
        const hecho = (req.body || {}).hecho !== false;
        return ok(res, await fichaService.marcarInformado(req.params.id, req.params.respuestaId, hecho, req.user.id));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo marcar el objetivo');
    }
});

router.put('/leads/:id/presentacion', ...auth, async (req, res) => {
    try {
        const hecho = (req.body || {}).hecho !== false;
        return ok(res, await fichaService.marcarPresentacion(req.params.id, hecho, req.user.id));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo marcar la presentación');
    }
});

router.post('/leads/:id/pedido', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.crearItem(req.params.id, req.body, req.user.id), 201);
    } catch (err) {
        return handleFicha(res, err, 'No se pudo anotar el pedido');
    }
});

router.put('/leads/:id/pedido/:itemId', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.editarItem(req.params.id, req.params.itemId, req.body));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo cambiar el pedido');
    }
});

router.delete('/leads/:id/pedido/:itemId', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.borrarItem(req.params.id, req.params.itemId));
    } catch (err) {
        return handleFicha(res, err, 'No se pudo borrar el pedido');
    }
});

router.get('/leads/:id/contactos-odoo', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.contactosParecidos(req.params.id));
    } catch (err) {
        return handleFicha(res, err, 'No se pudieron buscar los contactos de Odoo');
    }
});

router.post('/leads/:id/cotizar', ...auth, async (req, res) => {
    try {
        return ok(res, await fichaService.cotizar(req.params.id, req.body, req.user.id), 201);
    } catch (err) {
        return handleFicha(res, err, 'No se pudo crear la cotización en Odoo');
    }
});

function handleWhatsapp(res, err, generic) {
    if (err instanceof waLeads.WhatsappLeadError) return fail(res, err.message, err.status);
    // Sin el contenedor del WhatsApp del negocio no existe evolution_negocio
    if (err.code === '3F000' || err.code === '42P01') return fail(res, 'El WhatsApp del negocio no está disponible', 503);
    return handle(res, err, generic);
}

router.get('/leads/:id/whatsapp', ...auth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const vinculados = await waLeads.chatsDeLead(id);
        const candidatos = await waLeads.candidatosParaLead(id);
        if (!candidatos) return fail(res, 'No encontré ese posible cliente', 404);
        const etapa = vinculados.length ? await waLeads.etapaDeLead(id) : null;
        return ok(res, { vinculados, candidatos, etapa });
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudieron leer los chats de WhatsApp');
    }
});

router.post('/leads/:id/whatsapp', ...auth, async (req, res) => {
    try {
        const { chat } = req.body || {};
        return ok(res, await waLeads.vincularChat(parseInt(req.params.id, 10), chat, req.user.id));
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudo vincular el chat');
    }
});

router.delete('/leads/:id/whatsapp/:chat', ...auth, async (req, res) => {
    try {
        return ok(res, await waLeads.desvincularChat(req.params.id, req.params.chat));
    } catch (err) {
        return handleWhatsapp(res, err, 'No se pudo desvincular el chat');
    }
});

// ── Seguimiento ──────────────────────────────────────────────────

router.get('/mi-dia', ...auth, async (req, res) => {
    try {
        const mine = req.query.mias === '1' || req.query.mias === 'true';
        return ok(res, await followups.myDay({ userId: req.user.id, mine }));
    } catch (err) {
        return handle(res, err, 'No se pudo cargar Mi día');
    }
});

router.get('/seguimiento/:tipo/:id', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        return ok(res, await followups.getFollowup(target));
    } catch (err) {
        return handle(res, err, 'No se pudo cargar el seguimiento');
    }
});

router.put('/seguimiento/:tipo/:id/etapa', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { stage, reason } = req.body || {};
        return ok(res, await followups.setStage(target, { stage, reason, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la etapa');
    }
});

router.put('/seguimiento/:tipo/:id/importancia', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { importance } = req.body || {};
        return ok(res, await followups.setImportance(target, { importance, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la importancia');
    }
});

router.put('/importancia', ...auth, async (req, res) => {
    try {
        const { partner_ids: partnerIds, importance } = req.body || {};
        return ok(res, await followups.setImportanceMany(partnerIds, { importance, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la importancia');
    }
});

router.post('/seguimiento/:tipo/:id/eventos', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { kind, text } = req.body || {};
        return ok(res, await followups.addEvent(target, { kind, text, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo registrar el contacto');
    }
});

router.post('/seguimiento/:tipo/:id/presentacion', ...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        return ok(res, await followups.markPresentation(target, { userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo anotar la presentación');
    }
});

router.post('/seguimiento/:tipo/:id/acciones',...auth, async (req, res) => {
    try {
        const target = followups.toTarget(req.params.tipo, req.params.id);
        const { type, due_date: dueDate, note } = req.body || {};
        return ok(res, await followups.createAction(target, { type, dueDate, note, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo programar la acción');
    }
});

router.put('/acciones/:actionId', ...auth, async (req, res) => {
    try {
        const { type, due_date: dueDate, note } = req.body || {};
        return ok(res, await followups.updateAction(req.params.actionId, { type, dueDate, note }));
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la acción');
    }
});

router.post('/acciones/:actionId/hecha', ...auth, async (req, res) => {
    try {
        const { result } = req.body || {};
        return ok(res, await followups.completeAction(req.params.actionId, { result, userId: req.user.id }));
    } catch (err) {
        return handle(res, err, 'No se pudo marcar la acción como hecha');
    }
});

// ── Lista de seguimiento cercano ─────────────────────────────────

router.put('/cercanos/:partnerId', ...auth, async (req, res) => {
    try {
        const cercano = Boolean(req.body?.cercano);
        const result = await clientes.setCercano(req.params.partnerId, cercano, req.user.id);
        if (!result) return fail(res, 'No encontré ese cliente', 404);
        return ok(res, result);
    } catch (err) {
        return handle(res, err, 'No se pudo cambiar la lista de seguimiento cercano');
    }
});

router.post('/eventos/:eventId/respuesta', ...auth, async (req, res) => {
    try {
        const { response, text } = req.body || {};
        return ok(res, await followups.setResponse(req.params.eventId, { response, text, userId: req.user.id }), 201);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la respuesta');
    }
});

// ── Monitoreo del bot de seguimiento (Grok Bot) ──────────────────

router.get('/bot', ...auth, async (req, res) => {
    try {
        return ok(res, await botMonitor.monitor({
            dias: req.query.dias,
            refresh: req.query.refresh === '1' || req.query.refresh === 'true',
        }));
    } catch (err) {
        return handle(res, err, 'No se pudo leer la actividad del bot');
    }
});

// ── Ficha del cliente (al final: /:partnerId atrapa cualquier ruta) ──

router.get('/:partnerId', ...auth, async (req, res) => {
    const partnerId = parseInt(req.params.partnerId, 10);
    if (!partnerId) return fail(res, 'Cliente inválido', 400);
    try {
        const cliente = await clientes.getClient(partnerId);
        if (!cliente) return fail(res, 'No encontré ese cliente. Probá actualizar los datos desde Odoo.', 404);
        return ok(res, cliente);
    } catch (err) {
        return handle(res, err, 'No se pudo cargar la ficha del cliente');
    }
});

router.put('/:partnerId/contacto', ...auth, async (req, res) => {
    try {
        const { phone, city } = req.body || {};
        const result = await clientes.setContacto(req.params.partnerId, { phone, city });
        if (!result) return fail(res, 'No encontré ese cliente', 404);
        return ok(res, result);
    } catch (err) {
        return handle(res, err, 'No se pudo guardar el contacto en Odoo');
    }
});

module.exports = router;
