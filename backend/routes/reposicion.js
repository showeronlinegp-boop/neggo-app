// Rutas de reposición (solo empresa Neggo)
// GET    /api/reposicion?estado=pendiente|encargado|resueltos
// GET    /api/reposicion/buscar?q=
// GET    /api/reposicion/barcode?code=
// GET    /api/reposicion/proveedores
// GET    /api/reposicion/proveedor?nombre=           — catálogo + cola con métricas
// GET    /api/reposicion/ordenes?dias=7&refrescar=1  — ventas y POS de Neggo: pendientes y revisadas
// GET    /api/reposicion/cotizaciones?refrescar=1    — cotizaciones con etiqueta "Pendiente" (Neggo y Preventas)
// POST   /api/reposicion/ordenes/revisar             — { origen: venta|pos, odoo_order_id, order_name? }
// POST   /api/reposicion/ordenes/reabrir             — { origen, odoo_order_id }
// POST   /api/reposicion                             — { odoo_id, nota?, origen? }
// POST   /api/reposicion/archivar                    — { odoo_id } archiva en Odoo y encola
// POST   /api/reposicion/activar                     — { odoo_id } desarchiva y lo saca de la cola
// POST   /api/reposicion/resolver                    — { items, estado? } lote repuesto/descartado
// POST   /api/reposicion/sync-ventas                 — fuerza sync de ventas
// PATCH  /api/reposicion/:id                         — { estado, qty_decidida?, nota? }
// DELETE /api/reposicion/producto/:odooId            — saca de la cola un pendiente marcado por error
// POST   /api/reposicion/foto/:odooId                — multipart "image": carga la foto en Odoo (admin)

const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const reposicion = require('../services/reposicionService');
const ordenes = require('../services/reposicionOrdenesService');
const cotizaciones = require('../services/reposicionCotizacionesService');
const { detectMime } = require('../services/whatsappMessage');
const { writeOdooImage } = require('../services/odooImageService');

// Foto de producto — JPG, PNG o WEBP, máximo 5MB
const uploadImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('La foto tiene que ser JPG, PNG o WEBP'));
        }
        cb(null, true);
    }
});

router.use(authenticate, requireRole('admin', 'operador'));

router.get('/', async (req, res) => {
    try {
        const pedido = req.query.estado;
        const estado = pedido === 'resueltos' || pedido === 'encargado' ? pedido : 'pendiente';
        return ok(res, await reposicion.listar({ estado }));
    } catch (err) {
        console.error('❌ Error listando reposición:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/buscar', async (req, res) => {
    try {
        return ok(res, await reposicion.buscarProductos(req.query.q));
    } catch (err) {
        console.error('❌ Error buscando productos para reponer:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/barcode', async (req, res) => {
    try {
        const prod = await reposicion.buscarPorBarcode(req.query.code);
        if (!prod) return fail(res, 'No hay producto con ese código de barras en Neggo', 404);
        return ok(res, prod);
    } catch (err) {
        console.error('❌ Error buscando por barcode:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/proveedores', async (req, res) => {
    try {
        return ok(res, await reposicion.listarProveedores());
    } catch (err) {
        console.error('❌ Error listando proveedores de reposición:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/proveedor', async (req, res) => {
    const nombre = String(req.query.nombre || '').trim();
    if (!nombre) return fail(res, 'nombre es requerido', 400);
    try {
        return ok(res, await reposicion.detalleProveedor(nombre));
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error detalle proveedor reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.get('/ordenes', async (req, res) => {
    try {
        return ok(res, await ordenes.listar({ dias: req.query.dias, refrescar: req.query.refrescar === '1' }));
    } catch (err) {
        console.error('❌ Error listando órdenes para reposición:', err.message);
        return fail(res, err.message, 500);
    }
});

router.get('/cotizaciones', async (req, res) => {
    try {
        return ok(res, await cotizaciones.listar({ refrescar: req.query.refrescar === '1' }));
    } catch (err) {
        console.error('❌ Error listando cotizaciones pendientes:', err.message);
        return fail(res, err.message, 500);
    }
});

router.post('/ordenes/revisar', async (req, res) => {
    try {
        const data = await ordenes.marcarRevisada({
            origen: req.body.origen,
            odooOrderId: req.body.odoo_order_id,
            orderName: req.body.order_name,
        }, req.user.id);
        console.log(`✅ Reposición: orden ${req.body.order_name || data.odoo_order_id} (${data.origen}) revisada por usuario ${req.user.id}`);
        return ok(res, data);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error terminando orden de reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/ordenes/reabrir', async (req, res) => {
    try {
        return ok(res, await ordenes.reabrir({ origen: req.body.origen, odooOrderId: req.body.odoo_order_id }));
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error reabriendo orden de reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/', async (req, res) => {
    const odooId = parseInt(req.body.odoo_id, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id es requerido', 400);
    try {
        const origen = req.body.origen === 'recorrida' ? 'recorrida' : 'reponer';
        const item = await reposicion.agregarReponer(odooId, req.user.id, req.body.nota, origen);
        console.log(`✅ Reposición: "${item.name}" marcado (${item.origen}) por usuario ${req.user.id}`);
        return ok(res, item, 201);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error marcando para reponer:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/archivar', async (req, res) => {
    const odooId = parseInt(req.body.odoo_id, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id es requerido', 400);
    try {
        const item = await reposicion.archivarYEncolar(odooId, req.user.id);
        console.log(`✅ Reposición: "${item.name}" archivado en Odoo y encolado por usuario ${req.user.id}`);
        return ok(res, item);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error archivando para reponer:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/activar', async (req, res) => {
    const odooId = parseInt(req.body.odoo_id, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id es requerido', 400);
    try {
        const item = await reposicion.activarYResolver(odooId);
        console.log(`✅ Reposición: "${item.name}" activado en Odoo por usuario ${req.user.id}`);
        return ok(res, item);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error activando producto:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.delete('/producto/:odooId', async (req, res) => {
    const odooId = parseInt(req.params.odooId, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id inválido', 400);
    try {
        const item = await reposicion.quitarDeCola(odooId);
        console.log(`✅ Reposición: "${item.name}" quitado de la cola por usuario ${req.user.id}`);
        return ok(res, item);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error quitando de la cola:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

// Foto para un producto que no tiene (multipart, campo "image"). Escribe en Odoo: solo admin.
router.post('/foto/:odooId', requireRole('admin'), (req, res, next) => {
    uploadImage.single('image')(req, res, (err) => {
        if (err) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 'La foto no puede pesar más de 5MB' : err.message, 400);
        next();
    });
}, async (req, res) => {
    const odooId = parseInt(req.params.odooId, 10);
    if (!Number.isInteger(odooId)) return fail(res, 'odoo_id inválido', 400);
    try {
        if (!req.file) return fail(res, 'Elegí una foto', 400);
        // El tipo real se mira por los primeros bytes, no por la extensión
        if (!detectMime(req.file.buffer)) return fail(res, 'El archivo no es una foto válida', 400);

        const { rows } = await pool.query(
            `SELECT name FROM odoo_products_cache WHERE odoo_id = $1 AND company = 'neggo'`,
            [odooId]
        );
        if (rows.length === 0) return fail(res, 'Producto no encontrado en Neggo', 404);

        const result = await writeOdooImage(odooId, req.file.buffer.toString('base64'));
        console.log(`✅ Reposición: foto cargada en Odoo para "${rows[0].name}" (${odooId}) por usuario ${req.user.id}`);
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error cargando foto desde reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/resolver', async (req, res) => {
    try {
        const result = await reposicion.resolverLote({
            items: req.body.items,
            estado: req.body.estado || 'repuesto',
        }, req.user.id);
        return ok(res, result);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error resolviendo lote de reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

router.post('/sync-ventas', async (req, res) => {
    try {
        const { syncSalesWeekly } = require('../jobs/salesWeeklySync');
        const result = await syncSalesWeekly();
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error sincronizando ventas de reposición:', err.message);
        return fail(res, err.message, 500);
    }
});

router.patch('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return fail(res, 'id inválido', 400);
    try {
        const item = await reposicion.cambiarEstado(id, {
            estado:      req.body.estado,
            qtyDecidida: req.body.qty_decidida,
            nota:        req.body.nota,
        }, req.user.id);
        return ok(res, item);
    } catch (err) {
        if (!err.statusCode) console.error('❌ Error actualizando reposición:', err.message);
        return fail(res, err.message, err.statusCode || 500);
    }
});

module.exports = router;
