// Rutas de la API del agente (Grok Bot). Auth con API key (AGENTE_API_KEY), sin usuarios de la app.
// GET    /api/agente/clientes/nuevos?dias=21&etapa=&no_contactar=false|true|todos&para_hoy=&page=&limit=&refresh=1
// GET    /api/agente/clientes/:id                — ficha en vivo, sin caché (chequear antes de mandar)
// GET    /api/agente/productos?rubro=&stock=&q=&orden=vendidos|nombre&excluir_compras_de=&solo_publicados=&page=&limit=
// POST   /api/agente/clientes/:id/envios         — { etapa, mensaje, id_externo, productos_recomendados } RESERVA el mensaje de la cadencia
// GET    /api/agente/envios/:idExterno           — estado del envío (reservado | enviado | cancelado | vencido)
// POST   /api/agente/envios/:idExterno/confirmar — el WhatsApp salió: avanza la etapa
// POST   /api/agente/envios/:idExterno/cancelar  — el WhatsApp no salió: libera la etapa
// POST   /api/agente/clientes/:id/revisado       — el agente leyó las respuestas del cliente
// PATCH  /api/agente/clientes/:id/seguimiento    — { etapa, ultimo_contacto, proxima_accion }
// POST   /api/agente/clientes/:id/interacciones  — { fecha, tipo, etapa, mensaje, id_externo }
// GET    /api/agente/clientes/:id/interacciones?page=&limit=
// PATCH  /api/agente/clientes/:id                — { no_contactar, contacto }
// POST   /api/agente/feedback                    — { tipo, endpoint, mensaje } lo que el agente quiere que cambie
// GET    /api/agente/feedback?page=&limit=
//
// Públicas (sin datos): GET /api/agente/openapi.json y GET /api/agente/docs (Swagger UI)

const express = require('express');
const path = require('path');
const router = express.Router();
const { agenteAuth } = require('../middleware/agenteAuth');
const agente = require('../services/agenteService');
const v = require('../services/agenteValidacion');

const SPEC_PATH = path.join(__dirname, '..', 'docs', 'agente-openapi.json');
const SWAGGER_VERSION = '5.17.14';

function sendPage(res, { data, total, page, limit, meta }, status = 200) {
    return res.status(status).json({
        success: true,
        data,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        ...(meta ? { meta } : {}),
    });
}

function invalid(res, errors) {
    return res.status(422).json({ success: false, error: 'Datos inválidos', codigo: 'datos_invalidos', details: errors });
}

function handle(res, err, generic) {
    if (err instanceof agente.AgenteError) {
        const body = { success: false, error: err.message, codigo: err.codigo || null };
        if (err.details) body.details = err.details;
        return res.status(err.status).json(body);
    }
    console.error(`❌ Agente: ${generic}:`, err.message);
    return res.status(500).json({ success: false, error: generic, codigo: 'error_interno' });
}

/** Valida :id y, si viene, el body. Devuelve null si ya respondió 422. */
function parse(req, res, validarBody) {
    const id = v.validarId(req.params.id);
    const body = validarBody ? validarBody(req.body) : { value: null, errors: [] };
    const errors = [...id.errors, ...body.errors];
    if (errors.length) {
        invalid(res, errors);
        return null;
    }
    return { id: id.value, value: body.value };
}

// ── Documentación (pública) ──────────────────────────────────

router.get('/openapi.json', (req, res) => res.sendFile(SPEC_PATH));

router.get('/docs', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API del agente — Neggo</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui.min.css">
</head>
<body style="margin:0">
<div id="swagger"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_VERSION}/swagger-ui-bundle.min.js"></script>
<script>
window.ui = SwaggerUIBundle({ url: 'openapi.json', dom_id: '#swagger', persistAuthorization: true });
</script>
</body>
</html>`);
});

// ── Datos (con API key) ──────────────────────────────────────

router.use(agenteAuth);

// El código de error de cada respuesta queda en el activity log: la pestaña del bot en Clientes
// muestra por qué se rechazó cada pedido
router.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
        if (body && body.codigo) res.locals.agenteCodigo = body.codigo;
        return json(body);
    };
    next();
});

router.get('/clientes/nuevos', async (req, res) => {
    const { value, errors } = v.validarQueryNuevos(req.query);
    if (errors.length) return invalid(res, errors);
    try {
        return sendPage(res, await agente.listarNuevos(value));
    } catch (err) {
        return handle(res, err, 'No se pudo armar la lista de clientes nuevos');
    }
});

router.get('/clientes/:id', async (req, res) => {
    const p = parse(req, res, null);
    if (!p) return undefined;
    try {
        const { data, meta } = await agente.obtenerCliente(p.id);
        return res.json({ success: true, data, meta });
    } catch (err) {
        return handle(res, err, 'No se pudo leer el cliente');
    }
});

router.get('/productos', async (req, res) => {
    const { value, errors } = v.validarQueryProductos(req.query);
    if (errors.length) return invalid(res, errors);
    try {
        return sendPage(res, await agente.listarProductos(value));
    } catch (err) {
        return handle(res, err, 'No se pudieron leer los productos');
    }
});

router.patch('/clientes/:id/seguimiento', async (req, res) => {
    const p = parse(req, res, (b) => v.validarSeguimiento(b));
    if (!p) return undefined;
    try {
        return res.json({ success: true, data: await agente.actualizarSeguimiento(p.id, p.value) });
    } catch (err) {
        return handle(res, err, 'No se pudo guardar el seguimiento');
    }
});

// Un reintento con el mismo id_externo devuelve lo ya guardado con 200 y repetido: true
router.post('/clientes/:id/envios', async (req, res) => {
    const p = parse(req, res, (b) => v.validarEnvio(b));
    if (!p) return undefined;
    try {
        const { data, repetida } = await agente.reservarEnvio(p.id, p.value);
        return res.status(repetida ? 200 : 201).json({ success: true, data, repetido: repetida });
    } catch (err) {
        return handle(res, err, 'No se pudo reservar el envío');
    }
});

function parseIdExterno(req, res) {
    const { value, errors } = v.validarIdExternoRuta(req.params.idExterno);
    if (errors.length) {
        invalid(res, errors);
        return null;
    }
    return value;
}

router.get('/envios/:idExterno', async (req, res) => {
    const idExterno = parseIdExterno(req, res);
    if (!idExterno) return undefined;
    try {
        return res.json({ success: true, data: await agente.estadoEnvio(idExterno) });
    } catch (err) {
        return handle(res, err, 'No se pudo leer el envío');
    }
});

for (const accion of ['confirmar', 'cancelar']) {
    router.post(`/envios/:idExterno/${accion}`, async (req, res) => {
        const idExterno = parseIdExterno(req, res);
        if (!idExterno) return undefined;
        try {
            const fn = accion === 'confirmar' ? agente.confirmarEnvio : agente.cancelarEnvio;
            const { data, repetida } = await fn(idExterno);
            return res.json({ success: true, data, repetido: repetida });
        } catch (err) {
            return handle(res, err, `No se pudo ${accion} el envío`);
        }
    });
}

router.post('/clientes/:id/revisado', async (req, res) => {
    const p = parse(req, res, null);
    if (!p) return undefined;
    try {
        return res.json({ success: true, data: await agente.marcarRevisado(p.id) });
    } catch (err) {
        return handle(res, err, 'No se pudo marcar como revisado');
    }
});

router.post('/clientes/:id/interacciones', async (req, res) => {
    const p = parse(req, res, (b) => v.validarInteraccion(b));
    if (!p) return undefined;
    try {
        const { data, repetida } = await agente.registrarInteraccion(p.id, p.value);
        return res.status(repetida ? 200 : 201).json({ success: true, data, repetido: repetida });
    } catch (err) {
        return handle(res, err, 'No se pudo guardar la interacción');
    }
});

router.get('/clientes/:id/interacciones', async (req, res) => {
    const p = parse(req, res, null);
    if (!p) return undefined;
    const pag = v.validarPaginacion(req.query);
    if (pag.errors.length) return invalid(res, pag.errors);
    try {
        return sendPage(res, await agente.listarInteracciones(p.id, pag.value));
    } catch (err) {
        return handle(res, err, 'No se pudieron leer las interacciones');
    }
});

router.patch('/clientes/:id', async (req, res) => {
    const p = parse(req, res, v.validarClientePatch);
    if (!p) return undefined;
    try {
        return res.json({ success: true, data: await agente.actualizarCliente(p.id, p.value) });
    } catch (err) {
        return handle(res, err, 'No se pudo actualizar el cliente');
    }
});

router.post('/feedback', async (req, res) => {
    const { value, errors } = v.validarFeedback(req.body);
    if (errors.length) return invalid(res, errors);
    try {
        return res.status(201).json({ success: true, data: await agente.registrarFeedback(value) });
    } catch (err) {
        return handle(res, err, 'No se pudo guardar el feedback');
    }
});

router.get('/feedback', async (req, res) => {
    const pag = v.validarPaginacion(req.query);
    if (pag.errors.length) return invalid(res, pag.errors);
    try {
        return sendPage(res, await agente.listarFeedback(pag.value));
    } catch (err) {
        return handle(res, err, 'No se pudo leer el feedback');
    }
});

// Ruta inexistente (con API key válida): 404 con código, como el resto de los errores
router.use((req, res) => res.status(404).json({
    success: false, error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`, codigo: 'no_encontrado',
}));

module.exports = router;
