// Rutas de ingreso de mercadería
// POST /api/ingreso/upload                        — parse -> match -> validate -> create preview
// GET  /api/ingreso/:ingresoId                    — preview completo
// PATCH /api/ingreso/:ingresoId/items/:itemId     — cambiar match, markup, flags apply_cost/apply_price
// POST /api/ingreso/:ingresoId/confirm            — aplicar cambios + crear purchase.order
// POST /api/ingreso/:ingresoId/items/:itemId/create-odoo — crear producto en Odoo
// GET  /api/ingreso                               — listar con filtros

const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/database');
const ingresoService = require('../services/ingresoService');
const odooService = require('../services/odooService');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { detectMime } = require('../services/whatsappMessage');
const { findByIds } = require('../services/whatsappRandom');
const whatsappQueue = require('../services/whatsappQueue');

// Primera línea de las publicaciones de WhatsApp que salen desde un ingreso
const WHATSAPP_INGRESO_HEADER = 'Ingreso...';

// Multer config — máximo 5MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.csv')) {
            return cb(new Error('Solo archivos CSV permitidos'));
        }
        cb(null, true);
    }
});

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

// =============================================
// POST /api/ingreso/upload
// =============================================

router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
    const { supplier_id, comprobante_tipo, comprobante_numero } = req.body;

    console.log(`📦 Ingreso upload iniciado por usuario ${req.user.id}`);

    try {
        if (!req.file) {
            return fail(res, 'No se subió archivo CSV', 400);
        }

        if (!comprobante_tipo) {
            return fail(res, 'Falta comprobante_tipo', 400);
        }

        if (!['factura', 'remito', 'nota'].includes(comprobante_tipo)) {
            return fail(res, 'comprobante_tipo inválido', 400);
        }

        const parseResult = await ingresoService.parseCSV(req.file.buffer);
        if (!parseResult.success && parseResult.data.length === 0) {
            return fail(res, parseResult.errors[0]?.error || 'Error al parsear CSV', 400);
        }

        console.log(`✅ CSV parseado: ${parseResult.data.length} items válidos, ${parseResult.errors.length} errores`);

        const matchedItems = await ingresoService.matchItems(
            parseResult.data,
            supplier_id ? parseInt(supplier_id, 10) : null
        );

        const validatedItems = await ingresoService.validateItems(matchedItems);

        const preview = await ingresoService.createIngresoPreview(
            validatedItems,
            supplier_id ? parseInt(supplier_id, 10) : null,
            comprobante_tipo,
            comprobante_numero,
            req.user.id
        );

        console.log(`✅ Ingreso preview creado: ${preview.ingresoId}`);

        return ok(res, {
            ingreso_id:   preview.ingresoId,
            preview:      preview.preview,
            parse_errors: parseResult.errors
        }, 201);
    } catch (err) {
        console.error('❌ Error en upload:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/ingreso/odoo-image/:odooId
// Proxy de imagen de producto Odoo (cached 24h en browser)
// MUST be before /:ingresoId to avoid param conflict
// =============================================

router.get('/odoo-image/:odooId', async (req, res) => {
    const odooId     = parseInt(req.params.odooId, 10);
    const companyKey = req.query.company === 'preventas' ? 'preventas' : 'neggo';
    if (isNaN(odooId)) return res.status(400).end();

    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds[companyKey];
        if (!companyId) return res.status(503).end();

        const [product] = await callOdoo(
            'product.product',
            'read',
            [[odooId], ['image_128']],
            { context: { allowed_company_ids: [companyId] } }
        );

        if (!product?.image_128) return res.status(404).end();

        const buffer = Buffer.from(product.image_128, 'base64');

        // Detectar formato por magic bytes
        let contentType = 'image/png';
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) contentType = 'image/jpeg';
        else if (buffer[0] === 0x47 && buffer[1] === 0x49) contentType = 'image/gif';

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (err) {
        console.error('❌ Error fetching Odoo image:', err.message);
        res.status(404).end();
    }
});

// =============================================
// GET /api/ingreso/:ingresoId
// =============================================

router.get('/:ingresoId', authenticate, async (req, res) => {
    try {
        const { ingresoId } = req.params;

        const ingresoResult = await pool.query(
            `SELECT im.*, s.name as supplier_name, s.prefix as supplier_prefix, s.default_discount,
                    COALESCE(s.markup_neggo, 0)     AS default_markup,
                    COALESCE(s.markup_preventas, 0) AS default_markup_preventas
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );

        if (ingresoResult.rows.length === 0) {
            return fail(res, 'Ingreso no encontrado', 404);
        }

        const ingreso = ingresoResult.rows[0];

        const itemsResult = await pool.query(
            `SELECT ii.*,
                    opc.barcode           AS odoo_barcode,
                    opc.internal_ref      AS odoo_internal_ref,
                    opc.list_price        AS odoo_list_price,
                    opc.active            AS odoo_active_current,
                    opc.odoo_id           AS odoo_cache_found,
                    opc.available_in_pos  AS odoo_available_in_pos,
                    opc.is_published      AS odoo_is_published,
                    opc.categ_id_odoo     AS odoo_categ_id,
                    opc.categ_name        AS odoo_categ_name,
                    opc.web_categ_id      AS odoo_web_categ_id,
                    opc.web_categ_name    AS odoo_web_categ_name,
                    opc.vendor_name       AS odoo_vendor_name,
                    opc.template_id       AS odoo_template_id,
                    opc.has_image         AS odoo_has_image,
                    sp.image_url          AS supplier_image_url,
                    sp.name               AS supplier_product_name_matched,
                    sp.sku                AS supplier_sku
             FROM ingreso_items ii
             LEFT JOIN odoo_products_cache opc
                    ON opc.odoo_id  = ii.odoo_product_id
                   AND opc.company  = COALESCE(ii.odoo_company, 'neggo')
             LEFT JOIN supplier_products sp
                    ON sp.id = ii.supplier_product_id
             WHERE ii.ingreso_id = $1
             ORDER BY ii.id`,
            [ingresoId]
        );

        // Productos enlazados en items pero no en cache — solo aplica a productos de Neggo.
        // Los de Preventas se ignoran acá (tienen su propio cache con company='preventas').
        const idsNoEnCache = itemsResult.rows
            .filter(r => r.estado_item === 'matched' && r.odoo_product_id && r.odoo_cache_found == null
                && (r.odoo_company || 'neggo') === 'neggo')
            .map(r => r.odoo_product_id);

        if (idsNoEnCache.length > 0) {
            try {
                const { callOdoo, getCompanyIds } = require('../config/odoo');
                const companyIds = await getCompanyIds();
                const companyId  = companyIds.neggo;

                const odooProds = await callOdoo(
                    'product.product', 'read',
                    [idsNoEnCache, ['id', 'name', 'default_code', 'standard_price', 'list_price', 'barcode', 'active']],
                    { context: { allowed_company_ids: [companyId] } }
                );

                const fetchedIds = new Set();
                for (const p of odooProds) {
                    await pool.query(
                        `INSERT INTO odoo_products_cache
                         (odoo_id, name, internal_ref, barcode, standard_price, list_price, active, company)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'neggo')
                         ON CONFLICT (odoo_id, company) DO UPDATE SET
                             name           = EXCLUDED.name,
                             internal_ref   = EXCLUDED.internal_ref,
                             barcode        = EXCLUDED.barcode,
                             standard_price = EXCLUDED.standard_price,
                             list_price     = EXCLUDED.list_price,
                             active         = EXCLUDED.active`,
                        [p.id, p.name, p.default_code || null, p.barcode || null,
                         p.standard_price || 0, p.list_price || 0, p.active !== false]
                    );
                    fetchedIds.add(p.id);
                }

                // Parchear en memoria para que el check de "rotos" los reconozca
                for (const row of itemsResult.rows) {
                    if (fetchedIds.has(row.odoo_product_id)) {
                        row.odoo_cache_found = row.odoo_product_id;
                        row.odoo_active_current = odooProds.find(p => p.id === row.odoo_product_id)?.active !== false;
                    }
                }

                if (fetchedIds.size > 0)
                    console.log(`🔄 Ingreso ${ingresoId}: ${fetchedIds.size} producto(s) sin cache recuperados de Odoo y registrados`);
            } catch (cacheErr) {
                console.warn('⚠️ No se pudieron recuperar productos faltantes de Odoo:', cacheErr.message);
            }
        }

        // Códigos sin sentido que nunca deben ser clave de un match persistente
        const CODIGOS_SIN_SENTIDO = new Set([
            '', '-', '--', '---', 'n/a', 'na', 's/cod',
            'sin codigo', 'sin cod', 'sc', '0', 'none', 'null'
        ]);
        const codigoEsMeaningless = (codigo) => {
            if (!codigo) return true;
            const c = String(codigo).trim().toLowerCase();
            return CODIGOS_SIN_SENTIDO.has(c) || !/[a-zA-Z0-9]/.test(c);
        };

        // Romper relaciones inválidas:
        // Ítems matcheados con relación inválida: producto eliminado/movido, código sin sentido,
        // o matcheados a Preventas (solo Neggo aplica para las tabs activos/inactivos/nuevos).
        // Los productos INACTIVOS en Neggo NO se resetean — van a "Inactivos" para reactivar.
        const rotos = itemsResult.rows.filter(row => {
            if (row.estado_item !== 'matched' || !row.odoo_product_id) return false;
            // Vinculaciones manuales y productos creados siempre son intencionales — nunca resetear
            if (row.match_level === 'manual' || row.match_level === 'created') return false;
            if (row.odoo_company === 'preventas')  return true; // match a Preventas ya no es válido en ingreso
            if (row.odoo_cache_found == null)       return true; // producto eliminado o movido de empresa
            if (codigoEsMeaningless(row.codigo))    return true; // código sin sentido = falso positivo
            return false;
        });

        if (rotos.length > 0) {
            const getReason = (row) => {
                if (row.odoo_company === 'preventas') return 'Producto de Preventas — el ingreso solo matchea contra Neggo';
                if (row.odoo_cache_found == null) return 'Producto eliminado o movido de empresa en Odoo';
                return 'Match inválido — código sin identificador real';
            };
            // Actualizar uno a uno para guardar el motivo correcto
            for (const row of rotos) {
                await pool.query(
                    `UPDATE ingreso_items
                     SET estado_item       = 'pending',
                         odoo_product_id   = NULL,
                         odoo_product_name = NULL,
                         odoo_active       = NULL,
                         error_match       = $1
                     WHERE id = $2`,
                    [getReason(row), row.id]
                );
            }
            console.log(`🧹 Ingreso ${ingresoId}: ${rotos.length} relación(es) inválidas → reseteadas a pending`);
        }

        // Re-fetch items ya corregidos
        const itemsFinal = await pool.query(
            `SELECT ii.*,
                    opc.barcode           AS odoo_barcode,
                    opc.internal_ref      AS odoo_internal_ref,
                    opc.list_price        AS odoo_list_price,
                    opc.active            AS odoo_active_current,
                    opc.available_in_pos  AS odoo_available_in_pos,
                    opc.is_published      AS odoo_is_published,
                    opc.categ_id_odoo     AS odoo_categ_id,
                    opc.categ_name        AS odoo_categ_name,
                    opc.web_categ_id      AS odoo_web_categ_id,
                    opc.web_categ_name    AS odoo_web_categ_name,
                    opc.vendor_name       AS odoo_vendor_name,
                    opc.template_id       AS odoo_template_id,
                    opc.has_image         AS odoo_has_image,
                    sp.image_url          AS supplier_image_url,
                    sp.name               AS supplier_product_name_matched,
                    sp.sku                AS supplier_sku
             FROM ingreso_items ii
             LEFT JOIN odoo_products_cache opc
                    ON opc.odoo_id = ii.odoo_product_id AND opc.company = COALESCE(ii.odoo_company, 'neggo')
             LEFT JOIN supplier_products sp
                    ON sp.id = ii.supplier_product_id
             WHERE ii.ingreso_id = $1
             ORDER BY ii.id`,
            [ingresoId]
        );

        const items = itemsFinal.rows.map(row => ({
            ...row,
            odoo_active: row.odoo_active_current ?? row.odoo_active,
        }));

        // Separar en 3 categorías para los tabs del frontend
        const activos   = items.filter(i => i.estado_item === 'matched' && i.odoo_active !== false);
        const inactivos = items.filter(i => i.estado_item === 'matched' && i.odoo_active === false);
        const nuevos    = items.filter(i => i.estado_item === 'pending' || i.estado_item === 'no_match');
        const rechazados = items.filter(i => i.estado_item === 'rejected');

        return ok(res, {
            ingreso: {
                id:                      ingreso.id,
                comprobante_numero:      ingreso.comprobante_numero,
                comprobante_tipo:        ingreso.comprobante_tipo,
                supplier_id:             ingreso.supplier_id,
                supplier_name:           ingreso.supplier_name,
                supplier_prefix:         ingreso.supplier_prefix || null,
                default_discount:        parseFloat(ingreso.default_discount || 0),
                default_markup:          parseFloat(ingreso.default_markup   || 0),
                estado:                  ingreso.estado,
                total_monto:             ingreso.total_monto,
                items_count:             ingreso.items_count,
                costo_envio:             parseFloat(ingreso.costo_envio || 0),
                odoo_purchase_order_id:  ingreso.odoo_purchase_order_id,
                created_at:              ingreso.created_at,
                confirmed_at:            ingreso.confirmed_at
            },
            summary: {
                activos:    activos.length,
                inactivos:  inactivos.length,
                nuevos:     nuevos.length,
                rechazados: rechazados.length,
                total:      items.length
            },
            items
        });
    } catch (err) {
        console.error('❌ Error en GET ingreso:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// PATCH /api/ingreso/:ingresoId
// Actualizar campos del encabezado (costo_envio, etc.)
// =============================================

router.patch('/:ingresoId', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    const { costo_envio } = req.body;

    try {
        const ingresoCheck = await pool.query(
            `SELECT id, estado FROM ingreso_mercaderia WHERE id = $1`,
            [ingresoId]
        );
        if (ingresoCheck.rows.length === 0) return fail(res, 'Ingreso no encontrado', 404);
        if (ingresoCheck.rows[0].estado !== 'pending') return fail(res, 'Solo se puede editar un ingreso pendiente', 400);

        if (costo_envio !== undefined) {
            const envio = Math.max(0, parseFloat(costo_envio) || 0);
            await pool.query(
                `UPDATE ingreso_mercaderia SET costo_envio = $1 WHERE id = $2`,
                [envio, ingresoId]
            );
        }

        return ok(res, { costo_envio: Math.max(0, parseFloat(costo_envio) || 0) });
    } catch (err) {
        console.error('❌ Error en PATCH ingreso:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// PATCH /api/ingreso/:ingresoId/items/:itemId
// Actualizar match manual, markup, flags de apply
// =============================================

router.patch('/:ingresoId/items/:itemId', authenticate, async (req, res) => {
    const { ingresoId, itemId } = req.params;
    const {
        odoo_product_id, estado_item, motivo_rechazo,
        markup_override, discount_override,
        apply_cost, apply_price,
        checked, received_qty, pack_size,
        supplier_product_id, preventa_qty_confirmed
    } = req.body;

    try {
        const itemResult = await pool.query(
            `SELECT * FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
            [itemId, ingresoId]
        );

        if (itemResult.rows.length === 0) {
            return fail(res, 'Item no encontrado', 404);
        }

        // Cambiar match
        if (odoo_product_id !== undefined) {
            if (odoo_product_id) {
                const productCheck = await pool.query(
                    `SELECT name, active, standard_price, list_price
                     FROM odoo_products_cache WHERE odoo_id = $1 AND company = 'neggo' LIMIT 1`,
                    [odoo_product_id]
                );

                if (productCheck.rows.length === 0) {
                    return fail(res, `Producto ${odoo_product_id} no existe en cache Odoo`, 400);
                }

                const p = productCheck.rows[0];
                const currentItem = itemResult.rows[0];
                const precioUnitario = parseFloat(currentItem.precio_unitario || 0);
                const precioAnterior = parseFloat(p.standard_price || 0);
                const alertaPrecio   = precioAnterior > 0
                    ? Math.abs(precioUnitario - precioAnterior) / precioAnterior > 0.01
                    : false;

                await pool.query(
                    `UPDATE ingreso_items
                     SET odoo_product_id = $1, odoo_product_name = $2, estado_item = 'matched',
                         error_match = NULL,
                         odoo_active = $3,
                         precio_odoo_anterior = $4,
                         precio_odoo_lista = $5,
                         precio_odoo_nuevo = $6,
                         alerta_precio_diferente = $7,
                         match_level = 'manual'
                     WHERE id = $8`,
                    [odoo_product_id, p.name, p.active !== false,
                     precioAnterior, parseFloat(p.list_price || 0),
                     precioUnitario, alertaPrecio, itemId]
                );

                // Guardar vinculación persistente solo si el código es un identificador real
                // Códigos vacíos, guiones y similares no se persisten — no son identificadores únicos
                const codigoParaMapping = (currentItem.codigo || '').trim();
                const CODIGOS_SIN_SENTIDO = new Set(['-','--','---','n/a','na','s/cod','sin codigo','sin cod','sc','0','none','null']);
                const codigoEsReal = codigoParaMapping.length > 0
                    && !CODIGOS_SIN_SENTIDO.has(codigoParaMapping.toLowerCase())
                    && /[a-zA-Z0-9]/.test(codigoParaMapping);

                if (codigoEsReal) {
                    const ingresoCheck = await pool.query(
                        `SELECT supplier_id FROM ingreso_mercaderia WHERE id = $1`,
                        [ingresoId]
                    );
                    const supplierId = ingresoCheck.rows[0]?.supplier_id;

                    if (supplierId) {
                        await pool.query(
                            `INSERT INTO invoice_code_mappings
                                 (supplier_id, raw_code, odoo_product_id, odoo_product_name, odoo_company, created_by)
                             VALUES ($1, $2, $3, $4, 'neggo', $5)
                             ON CONFLICT (supplier_id, raw_code)
                             DO UPDATE SET
                                 odoo_product_id   = EXCLUDED.odoo_product_id,
                                 odoo_product_name = EXCLUDED.odoo_product_name,
                                 created_by        = EXCLUDED.created_by`,
                            [supplierId, codigoParaMapping, odoo_product_id, p.name, req.user.id]
                        );
                        console.log(`✅ Vinculación persistente guardada: proveedor ${supplierId}, código "${codigoParaMapping}" → producto Odoo ${odoo_product_id}`);
                    }
                } else if (codigoParaMapping) {
                    console.log(`⚠️ Código "${codigoParaMapping}" descartado como clave de mapping (no es un identificador válido)`);
                }
            } else {
                // odoo_product_id === null → desvincular: limpiar match y volver a pending
                await pool.query(
                    `UPDATE ingreso_items
                     SET odoo_product_id   = NULL,
                         odoo_product_name = NULL,
                         estado_item       = 'pending',
                         odoo_active       = NULL,
                         error_match       = 'Desvinculado manualmente',
                         precio_odoo_anterior = NULL,
                         precio_odoo_lista    = NULL
                     WHERE id = $1`,
                    [itemId]
                );
                console.log(`🔗 Item ${itemId} desvinculado — estado → pending`);
            }
        }

        // Rechazar
        if (estado_item === 'rejected') {
            await pool.query(
                `UPDATE ingreso_items
                 SET estado_item = 'rejected', motivo_rechazo = $1
                 WHERE id = $2`,
                [motivo_rechazo || 'Rechazado manualmente', itemId]
            );
        }

        // Restaurar item rechazado: vuelve a matched si tenía producto, pending si no
        if (estado_item === 'restore') {
            const currentItem = itemResult.rows[0];
            const estadoRestaurado = currentItem.odoo_product_id ? 'matched' : 'pending';
            await pool.query(
                `UPDATE ingreso_items SET estado_item = $1, motivo_rechazo = NULL WHERE id = $2`,
                [estadoRestaurado, itemId]
            );
        }

        // Actualizar markup override
        if (markup_override !== undefined) {
            await pool.query(
                `UPDATE ingreso_items SET markup_override = $1 WHERE id = $2`,
                [markup_override !== null ? parseFloat(markup_override) : null, itemId]
            );
        }

        // Actualizar discount override
        if (discount_override !== undefined) {
            await pool.query(
                `UPDATE ingreso_items SET discount_override = $1 WHERE id = $2`,
                [discount_override !== null ? parseFloat(discount_override) : null, itemId]
            );
        }

        // Tildar / destildar ítem del checklist de control físico
        if (checked !== undefined) {
            if (checked) {
                await pool.query(
                    `UPDATE ingreso_items
                     SET checked = true, checked_at = NOW(), checked_by = $1
                     WHERE id = $2`,
                    [req.user.id, itemId]
                );
            } else {
                await pool.query(
                    `UPDATE ingreso_items
                     SET checked = false, checked_at = NULL, checked_by = NULL
                     WHERE id = $1`,
                    [itemId]
                );
            }
        }

        // Actualizar flags apply_cost / apply_price
        const updates = [];
        const params  = [];
        let   pCount  = 0;

        if (apply_cost !== undefined) {
            pCount++;
            updates.push(`apply_cost = $${pCount}`);
            params.push(Boolean(apply_cost));
        }

        if (apply_price !== undefined) {
            pCount++;
            updates.push(`apply_price = $${pCount}`);
            params.push(Boolean(apply_price));
        }

        if (updates.length > 0) {
            pCount++;
            params.push(itemId);
            await pool.query(
                `UPDATE ingreso_items SET ${updates.join(', ')} WHERE id = $${pCount}`,
                params
            );
        }

        // Actualizar cantidad recibida físicamente
        if (received_qty !== undefined) {
            await pool.query(
                `UPDATE ingreso_items SET received_qty = $1 WHERE id = $2`,
                [Math.max(0, parseInt(received_qty, 10) || 0), itemId]
            );
        }

        // La cantidad de preventa es del código completo: se reparte entre
        // los renglones con el mismo código, sin pasar la cantidad de cada uno.
        let siblings = [];
        if (preventa_qty_confirmed !== undefined) {
            siblings = await ingresoService.distributePreventaQty(
                pool, ingresoId, itemId, preventa_qty_confirmed
            );
        }

        // Actualizar tamaño de pack (divisor de precio)
        if (pack_size !== undefined) {
            await pool.query(
                `UPDATE ingreso_items SET pack_size = $1 WHERE id = $2`,
                [Math.max(1, parseInt(pack_size, 10) || 1), itemId]
            );
        }

        // Cambiar vinculación con producto scrapeado del proveedor
        if (supplier_product_id !== undefined) {
            await pool.query(
                `UPDATE ingreso_items SET supplier_product_id = $1,
                    supplier_match_level = CASE WHEN $1 IS NULL THEN 'none' ELSE 'manual' END,
                    supplier_confidence  = CASE WHEN $1 IS NULL THEN 0 ELSE 1.0 END
                 WHERE id = $2`,
                [supplier_product_id || null, itemId]
            );
        }

        // Devolver item actualizado
        const updated = await pool.query(
            `SELECT * FROM ingreso_items WHERE id = $1`,
            [itemId]
        );
        const fi = updated.rows[0];

        // Aplicar precios a Odoo inmediatamente si algún flag pasó a true en este request
        let odooApplied = null;
        if ((apply_cost === true || apply_price === true) && fi.odoo_product_id) {
            try {
                const { rows: ingresoRows } = await pool.query(
                    `SELECT COALESCE(s.default_discount, 0) AS default_discount,
                            COALESCE(s.markup_neggo, 0) AS default_markup,
                            COALESCE(im.costo_envio,     0) AS costo_envio,
                            COALESCE(im.total_monto,     0) AS total_monto
                     FROM ingreso_mercaderia im
                     LEFT JOIN suppliers s ON s.id = im.supplier_id
                     WHERE im.id = $1`,
                    [ingresoId]
                );
                const supplierDiscount = parseFloat(ingresoRows[0]?.default_discount || 0);
                const supplierMarkup   = parseFloat(ingresoRows[0]?.default_markup   || 0);
                const costoEnvio       = parseFloat(ingresoRows[0]?.costo_envio      || 0);
                const totalMonto       = parseFloat(ingresoRows[0]?.total_monto      || 0);

                const packSize  = Math.max(1, parseInt(fi.pack_size || 1, 10));
                const rawCost   = parseFloat(fi.precio_unitario) / packSize;
                const discount  = fi.discount_override !== null ? parseFloat(fi.discount_override) : supplierDiscount;
                const newCost   = discount > 0
                    ? Math.round(rawCost * (1 - discount / 100) * 100) / 100
                    : rawCost;

                // Porción de envío proporcional al peso del ítem en la factura
                const participacion = (totalMonto > 0 && fi.subtotal > 0)
                    ? parseFloat(fi.subtotal) / totalMonto
                    : 0;
                const envioUnitario = (costoEnvio > 0 && fi.cantidad > 0)
                    ? Math.round(costoEnvio * participacion / (parseInt(fi.cantidad) * packSize) * 100) / 100
                    : 0;
                const newCostConEnvio = Math.round((newCost + envioUnitario) * 100) / 100;

                const markup    = fi.markup_override !== null ? parseFloat(fi.markup_override) : supplierMarkup;
                const newListPrice = markup > 0
                    ? Math.ceil(newCostConEnvio * (1 + markup / 100))
                    : null;

                const costForOdoo  = fi.apply_cost  ? newCostConEnvio : parseFloat(fi.precio_odoo_anterior) || null;
                const priceForOdoo = ingresoService.listPriceForOdoo(fi.apply_price, newListPrice, fi.precio_odoo_lista);

                // No pisar precios si el costo calculado es 0 o desconocido — evita productos con costo=0
                if (!costForOdoo || costForOdoo <= 0) {
                    console.log(`⚠️ Costo 0 o nulo para producto ${fi.odoo_product_id} — se omite actualización de precios en Odoo`);
                } else {
                    await odooService.updateProductPrices(fi.odoo_product_id, costForOdoo, priceForOdoo, 'neggo');
                    // Actualizar cache local para que el reload muestre el nuevo costo sin esperar al sync.
                    // Sin precio de lista nuevo, no se pisa el que ya estaba.
                    if (priceForOdoo != null) {
                        await pool.query(
                            `UPDATE odoo_products_cache SET standard_price = $1, list_price = $2 WHERE odoo_id = $3 AND company = 'neggo'`,
                            [costForOdoo, priceForOdoo, fi.odoo_product_id]
                        );
                        await pool.query(
                            `UPDATE ingreso_items SET precio_odoo_anterior = $1, precio_odoo_lista = $2 WHERE id = $3`,
                            [costForOdoo, priceForOdoo, fi.id]
                        );
                    } else {
                        await pool.query(
                            `UPDATE odoo_products_cache SET standard_price = $1 WHERE odoo_id = $2 AND company = 'neggo'`,
                            [costForOdoo, fi.odoo_product_id]
                        );
                        await pool.query(
                            `UPDATE ingreso_items SET precio_odoo_anterior = $1 WHERE id = $2`,
                            [costForOdoo, fi.id]
                        );
                    }
                    odooApplied = { cost: costForOdoo, list_price: priceForOdoo };
                    console.log(`✅ Precios aplicados en tiempo real a Odoo — producto ${fi.odoo_product_id}: costo=${costForOdoo}, lista=${priceForOdoo}`);
                }
            } catch (odooErr) {
                console.error('❌ Error aplicando precios a Odoo:', odooErr.message);
            }
        }

        return ok(res, { message: 'Item actualizado', item: fi, odoo_applied: odooApplied, siblings });
    } catch (err) {
        console.error('❌ Error en PATCH item:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// PATCH /api/ingreso/:ingresoId/items/:itemId/preventa-link
// Vincula manualmente un ítem a un producto de Odoo Preventas y guarda la cantidad.
// Permite operar con ítems que no tienen match automático en preventa-odoo-match.
// =============================================

router.patch('/:ingresoId/items/:itemId/preventa-link', authenticate, async (req, res) => {
    const { ingresoId, itemId } = req.params;
    const { preventas_product_id, preventas_product_name, preventa_qty_confirmed } = req.body;

    try {
        const { rows: [item] } = await pool.query(
            `SELECT id FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (!item) return fail(res, 'Item no encontrado', 404);

        if (preventas_product_id !== undefined) {
            await pool.query(
                `UPDATE ingreso_items
                 SET preventas_product_id   = $1,
                     preventas_product_name = $2
                 WHERE id = $3`,
                [preventas_product_id || null, preventas_product_name || null, itemId]
            );
        }

        let siblings = [];
        if (preventa_qty_confirmed != null) {
            siblings = await ingresoService.distributePreventaQty(
                pool, ingresoId, itemId, preventa_qty_confirmed
            );
        }

        const { rows: [updated] } = await pool.query(
            `SELECT id, preventa_qty_confirmed, preventas_product_id, preventas_product_name
             FROM ingreso_items WHERE id = $1`, [itemId]
        );
        return ok(res, { ...updated, siblings });
    } catch (err) {
        console.error('❌ Error en preventa-link:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/preventa-links
// Agrega un link de preventa al ítem (soporta múltiples cotizaciones)
// =============================================
router.post('/:ingresoId/items/:itemId/preventa-links', authenticate, async (req, res) => {
    const { ingresoId, itemId } = req.params;
    const { preventas_product_id, preventas_product_name, quotation_id, quotation_name, client, qty } = req.body;

    try {
        const { rows: [item] } = await pool.query(
            `SELECT id, cantidad, preventa_links, preventas_product_id AS legacy_product_id,
                    preventas_product_name AS legacy_product_name, preventa_qty_confirmed AS legacy_qty
             FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (!item) return fail(res, 'Item no encontrado', 404);

        // Migrar link legado si existe y preventa_links está vacío
        let links = Array.isArray(item.preventa_links) ? item.preventa_links : [];
        if (links.length === 0 && item.legacy_product_id) {
            links = [{
                id: `legacy-${itemId}-${Date.now()}`,
                preventas_product_id:   item.legacy_product_id,
                preventas_product_name: item.legacy_product_name,
                quotation_id: null, quotation_name: null, client: null,
                qty: parseInt(item.legacy_qty || 0),
            }];
        }

        const totalLinked = links.reduce((s, l) => s + (l.qty || 0), 0);
        const remaining   = parseInt(item.cantidad) - totalLinked;
        if (remaining <= 0) return fail(res, 'La cantidad del ítem ya está completamente asignada', 400);

        const linkQty = Math.min(Math.max(1, parseInt(qty) || 1), remaining);
        const newLink = {
            id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            preventas_product_id:   preventas_product_id || null,
            preventas_product_name: preventas_product_name || null,
            quotation_id:   quotation_id   || null,
            quotation_name: quotation_name || null,
            client:         client         || null,
            qty: linkQty,
        };

        const updatedLinks     = [...links, newLink];
        const totalConfirmed   = updatedLinks.reduce((s, l) => s + (l.qty || 0), 0);

        await pool.query(
            `UPDATE ingreso_items
             SET preventa_links = $1::jsonb, preventa_qty_confirmed = $2
             WHERE id = $3`,
            [JSON.stringify(updatedLinks), totalConfirmed, itemId]
        );

        const { rows: [updated] } = await pool.query(
            `SELECT id, preventa_qty_confirmed, preventas_product_id, preventas_product_name, preventa_links
             FROM ingreso_items WHERE id = $1`, [itemId]
        );
        console.log(`📦 Link preventa agregado a ítem ${itemId}: ${preventas_product_name} x${linkQty}`);
        return ok(res, { item: updated });
    } catch (err) {
        console.error('❌ Error agregando link preventa:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// DELETE /api/ingreso/:ingresoId/items/:itemId/preventa-links/:linkId
// Elimina un link de preventa específico del ítem
// =============================================
router.delete('/:ingresoId/items/:itemId/preventa-links/:linkId', authenticate, async (req, res) => {
    const { ingresoId, itemId, linkId } = req.params;

    try {
        const { rows: [item] } = await pool.query(
            `SELECT id, preventa_links FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (!item) return fail(res, 'Item no encontrado', 404);

        const links        = Array.isArray(item.preventa_links) ? item.preventa_links : [];
        const updatedLinks = links.filter(l => l.id !== linkId);
        const totalConfirmed = updatedLinks.reduce((s, l) => s + (l.qty || 0), 0);

        await pool.query(
            `UPDATE ingreso_items
             SET preventa_links = $1::jsonb,
                 preventa_qty_confirmed = $2,
                 preventas_product_id   = CASE WHEN $2 = 0 THEN NULL ELSE preventas_product_id END,
                 preventas_product_name = CASE WHEN $2 = 0 THEN NULL ELSE preventas_product_name END
             WHERE id = $3`,
            [JSON.stringify(updatedLinks), totalConfirmed, itemId]
        );

        const { rows: [updated] } = await pool.query(
            `SELECT id, preventa_qty_confirmed, preventas_product_id, preventas_product_name, preventa_links
             FROM ingreso_items WHERE id = $1`, [itemId]
        );
        console.log(`🗑️ Link preventa ${linkId} eliminado de ítem ${itemId}`);
        return ok(res, { item: updated });
    } catch (err) {
        console.error('❌ Error eliminando link preventa:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/create-odoo
// Crear producto nuevo en Odoo triangulando datos del scraper
// =============================================

router.post('/:ingresoId/items/:itemId/create-odoo', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;
    const {
        name: bodyName,
        sale_price: bodySalePrice,
        default_code: bodyDefaultCode,
        barcode: bodyBarcode,
        categ_id: bodyCategId,
        website_categ_id: bodyWebCategId,
        publish_pos = true,
        publish_web = false,
    } = req.body;

    try {
        const itemResult = await pool.query(
            `SELECT ii.*, im.supplier_id, s.prefix as supplier_prefix
             FROM ingreso_items ii
             JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );

        if (itemResult.rows.length === 0) {
            return fail(res, 'Item no encontrado', 404);
        }

        const item = itemResult.rows[0];

        if (item.estado_item !== 'pending') {
            return fail(res, `Item en estado ${item.estado_item}, no es un producto nuevo`, 400);
        }

        // Triangular datos del scraper si hay supplier
        let scrapedData = {};
        if (item.supplier_id && item.codigo) {
            const spResult = await pool.query(
                `SELECT name, image_url, source_category, raw_price
                 FROM supplier_products
                 WHERE supplier_id = $1
                   AND (UPPER(sku) = UPPER($2) OR name ILIKE $3)
                 LIMIT 1`,
                [item.supplier_id, item.codigo, `%${item.descripcion}%`]
            );
            if (spResult.rows.length > 0) scrapedData = spResult.rows[0];
        }

        // Obtener datos del ingreso para calcular costo real
        const { rows: ingresoMeta } = await pool.query(
            `SELECT COALESCE(s.default_discount, 0) AS default_discount,
                    COALESCE(im.costo_envio, 0)    AS costo_envio,
                    COALESCE(im.total_monto, 0)    AS total_monto
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );
        const supplierDiscount = parseFloat(ingresoMeta[0]?.default_discount || 0);
        const costoEnvioTotal  = parseFloat(ingresoMeta[0]?.costo_envio      || 0);
        const totalMontoFact   = parseFloat(ingresoMeta[0]?.total_monto      || 0);

        // Construir default_code: body > prefix+codigo > codigo
        // El prefix se normaliza a mayúsculas para consistencia con los índices de matching
        const prefix       = (item.supplier_prefix || '').toUpperCase();
        const codigoBase   = item.codigo || '';
        const defaultCode  = bodyDefaultCode !== undefined
            ? bodyDefaultCode
            : (prefix && codigoBase ? `${prefix}-${codigoBase}` : codigoBase);

        const productName = bodyName || scrapedData.name || item.descripcion;

        // Costo real = precio_unitario / pack_size − descuento + porción de envío
        const packSize    = Math.max(1, parseInt(item.pack_size || 1, 10));
        const costoBase   = parseFloat(item.precio_unitario || 0) / packSize;
        const discount    = item.discount_override !== null && item.discount_override !== undefined
            ? parseFloat(item.discount_override)
            : supplierDiscount;
        const costoConDto = discount > 0
            ? Math.round(costoBase * (1 - discount / 100) * 100) / 100
            : costoBase;
        const participacion  = (totalMontoFact > 0 && item.subtotal > 0)
            ? parseFloat(item.subtotal) / totalMontoFact
            : 0;
        const envioUnitario  = (costoEnvioTotal > 0 && item.cantidad > 0)
            ? Math.round(costoEnvioTotal * participacion / (parseInt(item.cantidad) * packSize) * 100) / 100
            : 0;
        const cost      = Math.round((costoConDto + envioUnitario) * 100) / 100;
        const listPrice = bodySalePrice ? parseFloat(bodySalePrice) : undefined;

        const productValues = {
            name:           productName,
            default_code:   defaultCode,
            standard_price: cost,
            // Odoo 17+ requiere type='consu' + detailed_type='product' para productos almacenables.
            // El type='product' fue removido en Odoo 17 (causa ValidationError en Odoo 17+/19).
            ...(listPrice     !== undefined && { list_price: listPrice }),
            ...(bodyBarcode   !== undefined && bodyBarcode && { barcode: bodyBarcode }),
            ...(bodyCategId   !== undefined && bodyCategId && { categ_id: parseInt(bodyCategId, 10) }),
            ...(publish_pos   && { available_in_pos: true }),
        };

        const newOdooId = await odooService.createProduct(productValues, 'neggo');

        // Campos de product.template: publicación web y categoría web
        if (publish_web || bodyWebCategId) {
            try {
                const { callOdoo, getCompanyIds } = require('../config/odoo');
                const companyIds = await getCompanyIds();
                const companyId  = companyIds.neggo;
                const [prod] = await callOdoo(
                    'product.product', 'read', [[newOdooId], ['product_tmpl_id']],
                    { context: { allowed_company_ids: [companyId] } }
                );
                if (prod?.product_tmpl_id?.[0]) {
                    const tmplVals = {};
                    if (publish_web)    tmplVals.website_published = true;
                    if (bodyWebCategId) tmplVals.public_categ_ids  = [[6, 0, [parseInt(bodyWebCategId, 10)]]];
                    await callOdoo(
                        'product.template', 'write',
                        [[prod.product_tmpl_id[0]], tmplVals],
                        { context: { allowed_company_ids: [companyId] } }
                    );
                }
            } catch (webErr) {
                console.warn('⚠️ No se pudo actualizar template en web:', webErr.message);
            }
        }

        // Actualizar item con el nuevo producto
        await pool.query(
            `UPDATE ingreso_items
             SET odoo_product_id = $1, odoo_product_name = $2, estado_item = 'matched',
                 odoo_active = true, error_match = NULL,
                 precio_odoo_anterior = 0, precio_odoo_lista = $3,
                 precio_odoo_nuevo = $3,
                 match_level = 'created'
             WHERE id = $4`,
            [newOdooId, productName, listPrice ?? cost, itemId]
        );

        // Insertar en cache local — sin esto, el GET del comprobante resetea el item a pending
        await pool.query(
            `INSERT INTO odoo_products_cache
             (odoo_id, name, internal_ref, barcode, standard_price, list_price, active, company)
             VALUES ($1, $2, $3, $4, $5, $6, true, 'neggo')
             ON CONFLICT (odoo_id, company) DO UPDATE SET
                 name           = EXCLUDED.name,
                 internal_ref   = EXCLUDED.internal_ref,
                 barcode        = EXCLUDED.barcode,
                 standard_price = EXCLUDED.standard_price,
                 list_price     = EXCLUDED.list_price,
                 active         = true`,
            [newOdooId, productName, defaultCode || null, bodyBarcode || null, cost, listPrice ?? cost]
        );

        console.log(`✅ Producto ${productName} (${defaultCode}) creado en Odoo: ID ${newOdooId}`);

        return ok(res, {
            odoo_product_id:   newOdooId,
            odoo_product_name: productName,
            default_code:      defaultCode,
        });
    } catch (err) {
        console.error('❌ Error en create-odoo:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/reactivate
// Reactiva producto inactivo en Odoo usando product.template
// =============================================

router.post('/:ingresoId/items/:itemId/reactivate', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        const itemResult = await pool.query(
            `SELECT ii.*, im.supplier_id
             FROM ingreso_items ii
             JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );

        if (itemResult.rows.length === 0) {
            return fail(res, 'Item no encontrado', 404);
        }

        const item = itemResult.rows[0];

        if (!item.odoo_product_id) {
            return fail(res, 'Item sin producto Odoo asignado', 400);
        }

        // Buscar el template_id del producto (para evitar errores de variantes)
        // Primero buscamos en el cache: usamos el odoo_id para obtener el product.product
        // luego accedemos al product_tmpl_id via Odoo
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId = companyIds.neggo;

        if (!companyId) {
            return fail(res, 'No se encontró la empresa Neggo en Odoo', 500);
        }

        // Leer product_tmpl_id desde product.product
        const productData = await callOdoo(
            'product.product',
            'read',
            [[item.odoo_product_id], ['product_tmpl_id', 'active']],
            { context: { allowed_company_ids: [companyId] } }
        );

        if (!productData || productData.length === 0) {
            return fail(res, `Producto ${item.odoo_product_id} no encontrado en Odoo`, 404);
        }

        const templateId = productData[0].product_tmpl_id?.[0];

        if (!templateId) {
            return fail(res, 'No se pudo obtener el template del producto', 500);
        }

        // Reactivar usando product.template (no product.product — evita errores de variantes)
        await callOdoo(
            'product.template',
            'write',
            [[templateId], { active: true }],
            { context: { allowed_company_ids: [companyId] } }
        );

        // Actualizar el item en la DB local
        await pool.query(
            `UPDATE ingreso_items SET odoo_active = true WHERE id = $1`,
            [itemId]
        );

        // Actualizar cache de Odoo
        await pool.query(
            `UPDATE odoo_products_cache SET active = true WHERE odoo_id = $1 AND company = 'neggo'`,
            [item.odoo_product_id]
        );

        // Reposición: si estaba en la cola por agotado, entró mercadería → repuesto
        try {
            await require('../services/reposicionService')
                .resolverReactivados([item.odoo_product_id], { resolvedBy: req.user.id });
        } catch (err) {
            console.error(`⚠️ Reposición: no se pudo marcar repuesto ${item.odoo_product_id}: ${err.message}`);
        }

        console.log(`✅ Producto ${item.odoo_product_id} (template ${templateId}) reactivado en Odoo`);

        return ok(res, { message: 'Producto reactivado', template_id: templateId });
    } catch (err) {
        console.error('❌ Error en reactivate:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/upload-supplier-photo
// Descarga la imagen del proveedor y la sube al producto Odoo
// =============================================

router.post('/:ingresoId/items/:itemId/upload-supplier-photo', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        const itemResult = await pool.query(
            `SELECT ii.odoo_product_id, sp.image_url
             FROM ingreso_items ii
             LEFT JOIN supplier_products sp ON sp.id = ii.supplier_product_id
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );

        if (itemResult.rows.length === 0) return fail(res, 'Item no encontrado', 404);

        const { odoo_product_id, image_url } = itemResult.rows[0];
        if (!odoo_product_id) return fail(res, 'Item sin producto Odoo asignado', 400);
        if (!image_url)       return fail(res, 'No hay imagen del proveedor para este ítem', 400);

        // Descargar imagen del proveedor
        const imgResponse = await fetch(image_url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeggoApp/1.0)' },
            signal: AbortSignal.timeout(15000)
        });

        if (!imgResponse.ok) {
            return fail(res, `No se pudo descargar la imagen (${imgResponse.status})`, 502);
        }

        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        if (!detectMime(buffer)) {
            return fail(res, 'Lo que devolvió el proveedor no es una foto', 502);
        }

        const result = await writeOdooImage(odoo_product_id, buffer.toString('base64'));
        console.log(`✅ Foto del proveedor subida a Odoo para producto ${odoo_product_id}`);
        return ok(res, { message: 'Imagen subida correctamente a Odoo', ...result });
    } catch (err) {
        console.error('❌ Error subiendo foto a Odoo:', err);
        return fail(res, err.message, err.statusCode || 500);
    }
});

/**
 * Sube la foto a un producto de Odoo Neggo (image_1920: Odoo arma las miniaturas)
 * y actualiza el cache local, así WhatsApp y el catálogo la ven sin esperar el sync.
 */
async function writeOdooImage(odooProductId, base64) {
    const { callOdoo, getCompanyIds } = require('../config/odoo');
    const companyIds = await getCompanyIds();
    const companyId  = companyIds.neggo;
    if (!companyId) {
        const err = new Error('Company Neggo no encontrada');
        err.statusCode = 503;
        throw err;
    }
    const ctx = { context: { allowed_company_ids: [companyId] } };

    await callOdoo('product.product', 'write', [[odooProductId], { image_1920: base64 }], ctx);
    const [product] = await callOdoo('product.product', 'read', [[odooProductId], ['product_tmpl_id']], ctx);
    const templateId = product?.product_tmpl_id?.[0] || null;

    await pool.query(
        `UPDATE odoo_products_cache
         SET has_image   = true,
             template_id = COALESCE($2, template_id),
             image_url   = CASE WHEN COALESCE($2, template_id) IS NOT NULL
                                THEN '/api/products/odoo-image/neggo/' || COALESCE($2, template_id)
                                ELSE image_url END
         WHERE odoo_id = $1 AND company = 'neggo'`,
        [odooProductId, templateId]
    );
    return { template_id: templateId };
}

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/photo
// Carga o reemplaza la foto del producto Odoo con un archivo (multipart, campo "image")
// =============================================

router.post('/:ingresoId/items/:itemId/photo', authenticate, requireRole('admin'), (req, res, next) => {
    uploadImage.single('image')(req, res, (err) => {
        if (err) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 'La foto no puede pesar más de 5MB' : err.message, 400);
        next();
    });
}, async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        if (!req.file) return fail(res, 'Elegí una foto', 400);
        // El tipo real se mira por los primeros bytes, no por la extensión
        if (!detectMime(req.file.buffer)) return fail(res, 'El archivo no es una foto válida', 400);

        const { rows } = await pool.query(
            `SELECT odoo_product_id, COALESCE(odoo_company, 'neggo') AS odoo_company
             FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (rows.length === 0) return fail(res, 'Item no encontrado', 404);
        const { odoo_product_id, odoo_company } = rows[0];
        if (!odoo_product_id) return fail(res, 'El ítem no tiene producto de Odoo vinculado', 400);
        if (odoo_company !== 'neggo') return fail(res, 'Solo se cargan fotos a productos de Neggo', 400);

        const result = await writeOdooImage(odoo_product_id, req.file.buffer.toString('base64'));
        console.log(`✅ Foto cargada en Odoo para producto ${odoo_product_id} (ingreso ${ingresoId}, ítem ${itemId})`);
        return ok(res, { message: 'Foto guardada en Odoo', ...result });
    } catch (err) {
        console.error('❌ Error cargando foto en Odoo:', err);
        return fail(res, err.message, err.statusCode || 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/whatsapp
// Programa una tanda de WhatsApp con productos del ingreso que tienen foto y precio.
// Body: { item_ids: [...], scheduled_at: 'AAAA-MM-DDTHH:mm' (hora Argentina) | send_now: true,
//         interval_seconds? }
// La tanda entra a la misma cola y listado que el resto de las publicaciones.
// =============================================

router.post('/:ingresoId/whatsapp', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    const itemIds = Array.isArray(req.body.item_ids)
        ? req.body.item_ids.map(Number).filter(Number.isInteger)
        : [];
    if (itemIds.length === 0) return fail(res, 'Elegí al menos un producto', 400);

    try {
        const { rows } = await pool.query(
            `SELECT id, odoo_product_id FROM ingreso_items
             WHERE ingreso_id = $1 AND id = ANY($2::int[])
               AND odoo_product_id IS NOT NULL
               AND COALESCE(odoo_company, 'neggo') = 'neggo'
             ORDER BY id`,
            [ingresoId, itemIds]
        );
        // findByIds vuelve a validar foto, precio y producto activo con el cache
        const odooIds  = [...new Set(rows.map(r => r.odoo_product_id))];
        const products = await findByIds(pool, 'neggo', odooIds);
        if (products.length === 0) {
            return fail(res, 'Ninguno de los productos elegidos tiene foto y precio de venta en Odoo', 400);
        }

        const settings = await whatsappQueue.getSettings(pool);
        const { batch, total } = await whatsappQueue.createBatch(pool, {
            company:         'neggo',
            category:        `Ingreso #${ingresoId}`,
            products:        products.map(p => ({ ...p, caption: `${WHATSAPP_INGRESO_HEADER}\n${p.caption}` })),
            groupJid:        req.body.group_jid || settings.group_jid,
            groupSubject:    req.body.group_subject || settings.group_subject,
            intervalSeconds: req.body.interval_seconds || settings.interval_seconds,
            scheduledAt:     req.body.scheduled_at,
            sendNow:         req.body.send_now === true,
            maxAttempts:     process.env.WHATSAPP_MAX_ATTEMPTS,
            createdBy:       req.user.id,
        });

        const publicados = new Set(products.map(p => p.odoo_id));
        const omitidos = itemIds.filter(id => {
            const row = rows.find(r => r.id === id);
            return !row || !publicados.has(row.odoo_product_id);
        });

        console.log(`✅ Tanda de WhatsApp ${batch.id} programada desde ingreso ${ingresoId}: ${total} productos`);
        return ok(res, { id: batch.id, total, scheduled_at: batch.scheduled_at, omitidos }, 201);
    } catch (err) {
        console.error('❌ Error programando WhatsApp desde ingreso:', err.message);
        return fail(res, err.message, 400);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/assign-supplier
// Asigna el proveedor del comprobante como supplierinfo en Odoo Neggo (product.supplierinfo)
// Solo aplica cuando el producto no tiene proveedor registrado en Odoo
// =============================================

router.post('/:ingresoId/items/:itemId/assign-supplier', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        const { rows: [item] } = await pool.query(
            `SELECT ii.odoo_product_id, opc.template_id
             FROM ingreso_items ii
             LEFT JOIN odoo_products_cache opc
                    ON opc.odoo_id = ii.odoo_product_id AND opc.company = 'neggo'
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (!item)                 return fail(res, 'Item no encontrado', 404);
        if (!item.odoo_product_id) return fail(res, 'Item sin producto Odoo asignado', 400);

        const { rows: [ingreso] } = await pool.query(
            `SELECT im.supplier_id, s.name AS supplier_name
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );
        if (!ingreso?.supplier_id) return fail(res, 'El ingreso no tiene proveedor asignado', 400);

        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Company Neggo no encontrada', 503);

        const ctx = { context: { allowed_company_ids: [companyId] } };

        // Buscar partner en Odoo por nombre del proveedor
        const partners = await callOdoo('res.partner', 'search_read',
            [[['name', 'ilike', ingreso.supplier_name]]],
            { fields: ['id', 'name'], limit: 1, context: ctx }
        );
        if (!partners.length) {
            return fail(res, `Proveedor "${ingreso.supplier_name}" no encontrado en Odoo Neggo`, 404);
        }
        const partnerId   = partners[0].id;
        const partnerName = partners[0].name;

        // Resolver template_id
        let templateId = item.template_id;
        if (!templateId) {
            const [prod] = await callOdoo(
                'product.product', 'read',
                [[item.odoo_product_id], ['product_tmpl_id']],
                ctx
            );
            templateId = prod?.product_tmpl_id?.[0];
        }
        if (!templateId) return fail(res, 'No se pudo resolver el template del producto', 500);

        // Verificar si ya existe el supplierinfo para este par (template, partner)
        const existing = await callOdoo('product.supplierinfo', 'search_read',
            [[['product_tmpl_id', '=', templateId], ['partner_id', '=', partnerId], ['company_id', '=', companyId]]],
            { fields: ['id'], context: ctx }
        );

        const yaExistia = existing.length > 0;
        if (!yaExistia) {
            await callOdoo('product.supplierinfo', 'create',
                [{ product_tmpl_id: templateId, partner_id: partnerId, price: 0, min_qty: 0, company_id: companyId }],
                ctx
            );
        }

        // Actualizar vendor_name en cache local
        await pool.query(
            `UPDATE odoo_products_cache SET vendor_name = $1 WHERE odoo_id = $2 AND company = 'neggo'`,
            [partnerName, item.odoo_product_id]
        );

        console.log(`✅ Proveedor "${partnerName}" asignado a producto Odoo ${item.odoo_product_id}${yaExistia ? ' (ya existía)' : ''}`);
        return ok(res, { vendor_name: partnerName, already_existed: yaExistia });
    } catch (err) {
        console.error('❌ Error asignando proveedor:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/items/:itemId/assign-web-categ-from-product
// Busca en Odoo una categoría web (product.public.category) cuyo nombre coincida
// con la categoría interna del producto y la asigna al template.
// Soluciona el problema de IDs distintos entre product.category y product.public.category.
// =============================================

router.post('/:ingresoId/items/:itemId/assign-web-categ-from-product', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        const { rows: [item] } = await pool.query(
            `SELECT ii.odoo_product_id, opc.template_id, opc.categ_name
             FROM ingreso_items ii
             LEFT JOIN odoo_products_cache opc
                    ON opc.odoo_id = ii.odoo_product_id AND opc.company = 'neggo'
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (!item)                 return fail(res, 'Item no encontrado', 404);
        if (!item.odoo_product_id) return fail(res, 'Item sin producto Odoo asignado', 400);
        if (!item.categ_name)      return fail(res, 'El producto no tiene categoría interna asignada', 400);

        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Company Neggo no encontrada', 503);

        const ctx = { context: { allowed_company_ids: [companyId] } };

        // Tomar solo el último segmento del nombre jerárquico ("All / Elec / Cables" → "Cables")
        const shortName = item.categ_name.includes(' / ')
            ? item.categ_name.split(' / ').pop().trim()
            : item.categ_name.trim();

        const webCategs = await callOdoo('product.public.category', 'search_read',
            [[['name', 'ilike', shortName]]],
            { fields: ['id', 'name'], limit: 5, context: ctx }
        );

        if (!webCategs.length) {
            return fail(res, `No se encontró categoría web con nombre "${shortName}"`, 404);
        }

        // Preferir coincidencia exacta (case-insensitive), si no la primera
        const exact  = webCategs.find(c => c.name.toLowerCase() === shortName.toLowerCase());
        const chosen = exact || webCategs[0];

        // Resolver template_id
        let templateId = item.template_id;
        if (!templateId) {
            const [prod] = await callOdoo(
                'product.product', 'read',
                [[item.odoo_product_id], ['product_tmpl_id']],
                ctx
            );
            templateId = prod?.product_tmpl_id?.[0];
        }
        if (!templateId) return fail(res, 'No se pudo resolver el template del producto', 500);

        // Usamos [[4, id]] (link/add) en lugar de [[6, 0, [id]]] (replace)
        // porque [[6, 0, ...]] en Odoo 17/19 intenta eliminar las categorías anteriores
        // y si alguna está referenciada por otros productos dispara un constraint error.
        await callOdoo('product.template', 'write',
            [[templateId], { public_categ_ids: [[4, chosen.id]] }],
            ctx
        );

        // Actualizar cache local
        await pool.query(
            `UPDATE odoo_products_cache SET web_categ_id = $1, web_categ_name = $2
             WHERE odoo_id = $3 AND company = 'neggo'`,
            [chosen.id, chosen.name, item.odoo_product_id]
        );

        console.log(`✅ Categoría web "${chosen.name}" (ID ${chosen.id}) asignada a producto ${item.odoo_product_id}`);
        return ok(res, { web_categ_id: chosen.id, web_categ_name: chosen.name });
    } catch (err) {
        console.error('❌ Error asignando categoría web desde producto:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// PATCH /api/ingreso/:ingresoId/items/:itemId/odoo-product
// Actualiza ref interna y/o barcode del producto en Odoo + cache
// =============================================

router.patch('/:ingresoId/items/:itemId/odoo-product', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;
    const {
        default_code, barcode,
        available_in_pos, is_published,
        categ_id, categ_name,
        website_categ_id, web_categ_name,
    } = req.body;

    try {
        const itemResult = await pool.query(
            `SELECT ii.odoo_product_id, opc.template_id
             FROM ingreso_items ii
             LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ii.odoo_product_id AND opc.company = 'neggo'
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );
        if (itemResult.rows.length === 0) return fail(res, 'Item no encontrado', 404);

        const { odoo_product_id, template_id } = itemResult.rows[0];
        if (!odoo_product_id) return fail(res, 'Item sin producto Odoo asignado', 400);

        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Company Neggo no encontrada', 503);

        const ctx = { context: { allowed_company_ids: [companyId] } };

        // Campos de product.product
        const productVals = {};
        if (default_code !== undefined) productVals.default_code = default_code || false;
        if (barcode       !== undefined) productVals.barcode       = barcode       || false;
        if (Object.keys(productVals).length > 0) {
            await callOdoo('product.product', 'write', [[odoo_product_id], productVals], ctx);
        }

        // Campos de product.template
        const templateVals = {};
        if (available_in_pos !== undefined) templateVals.available_in_pos = Boolean(available_in_pos);
        if (is_published      !== undefined) templateVals.website_published = Boolean(is_published);
        if (categ_id          !== undefined) templateVals.categ_id          = parseInt(categ_id, 10);
        if (website_categ_id  !== undefined) {
            templateVals.public_categ_ids = website_categ_id
                ? [[6, 0, [parseInt(website_categ_id, 10)]]]
                : [[5, 0, 0]];
        }
        if (Object.keys(templateVals).length > 0) {
            const tmplId = template_id || (await (async () => {
                const [prod] = await callOdoo('product.product', 'read', [[odoo_product_id], ['product_tmpl_id']], ctx);
                return prod?.product_tmpl_id?.[0];
            })());
            if (tmplId) await callOdoo('product.template', 'write', [[tmplId], templateVals], ctx);
        }

        if (Object.keys(productVals).length === 0 && Object.keys(templateVals).length === 0) {
            return fail(res, 'Sin campos para actualizar', 400);
        }

        // Actualizar cache local
        const setClauses = [];
        const cacheParams = [];
        let pi = 1;
        if (default_code      !== undefined) { setClauses.push(`internal_ref = $${pi++}`);     cacheParams.push(default_code || null); }
        if (barcode            !== undefined) { setClauses.push(`barcode = $${pi++}`);           cacheParams.push(barcode || null); }
        if (available_in_pos   !== undefined) { setClauses.push(`available_in_pos = $${pi++}`); cacheParams.push(Boolean(available_in_pos)); }
        if (is_published        !== undefined) { setClauses.push(`is_published = $${pi++}`);     cacheParams.push(Boolean(is_published)); }
        if (categ_id            !== undefined) { setClauses.push(`categ_id_odoo = $${pi++}`);   cacheParams.push(parseInt(categ_id, 10)); }
        if (categ_name          !== undefined) { setClauses.push(`categ_name = $${pi++}`);       cacheParams.push(categ_name || null); }
        if (website_categ_id    !== undefined) { setClauses.push(`web_categ_id = $${pi++}`);     cacheParams.push(website_categ_id ? parseInt(website_categ_id, 10) : null); }
        if (web_categ_name      !== undefined) { setClauses.push(`web_categ_name = $${pi++}`);   cacheParams.push(web_categ_name || null); }

        if (setClauses.length > 0) {
            cacheParams.push(odoo_product_id);
            await pool.query(
                `UPDATE odoo_products_cache SET ${setClauses.join(', ')} WHERE odoo_id = $${pi} AND company = 'neggo'`,
                cacheParams
            );
        }

        console.log(`✅ Producto Odoo ${odoo_product_id} actualizado:`, { ...productVals, ...templateVals });
        return ok(res, { message: 'Producto actualizado en Odoo', updated: { ...productVals, ...templateVals } });
    } catch (err) {
        console.error('❌ Error actualizando producto Odoo:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// =============================================
// POST /api/ingreso/:ingresoId/generate-oc
// Genera la OC en Odoo para un ingreso ya confirmado que quedó sin OC.
// =============================================

router.post('/:ingresoId/generate-oc', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    const { odoo_partner_id } = req.body;

    if (!odoo_partner_id) return fail(res, 'odoo_partner_id es requerido', 400);

    try {
        const { rows: [ingreso] } = await pool.query(
            `SELECT im.*, s.prefix AS supplier_prefix, s.default_discount,
                    COALESCE(s.markup_neggo, 0)     AS markup_neggo,
                    COALESCE(s.markup_preventas, 0) AS markup_preventas
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );

        if (!ingreso) return fail(res, 'Ingreso no encontrado', 404);
        if (ingreso.estado !== 'confirmado') return fail(res, 'El ingreso no está confirmado', 400);

        const { rows: items } = await pool.query(
            `SELECT * FROM ingreso_items WHERE ingreso_id = $1 AND estado_item = 'matched'`,
            [ingresoId]
        );

        const supplierPrefix   = ingreso.supplier_prefix || '';
        const supplierMarkup   = parseFloat(ingreso.markup_neggo || 0);
        const supplierDiscount = parseFloat(ingreso.default_discount || 0);
        const costoEnvio       = parseFloat(ingreso.costo_envio      || 0);
        const totalFactura     = parseFloat(ingreso.total_monto      || 0);

        const purchaseLinesNeggo     = [];
        const purchaseLinesPreventas = [];

        for (const item of items) {
            const itemCompany = item.odoo_company || 'neggo';
            const totalQty = parseInt(item.cantidad, 10);
            const prevQty  = Math.min(parseInt(item.preventa_qty_confirmed || 0, 10), Math.max(0, totalQty));
            const neggoQty = Math.max(0, totalQty - prevQty);

            const packSize   = Math.max(1, parseInt(item.pack_size || 1, 10));
            const rawCost    = parseFloat(item.precio_unitario) / packSize;
            const discount   = item.discount_override !== null ? parseFloat(item.discount_override) : supplierDiscount;
            const newCostBase = discount > 0 ? Math.round(rawCost * (1 - discount / 100) * 100) / 100 : rawCost;
            const participacion = (totalFactura > 0 && item.subtotal > 0) ? parseFloat(item.subtotal) / totalFactura : 0;
            const envioUnitario = (costoEnvio > 0 && totalQty > 0) ? Math.round(costoEnvio * participacion / (totalQty * packSize) * 100) / 100 : 0;
            const newCost    = Math.round((newCostBase + envioUnitario) * 100) / 100;

            if (itemCompany === 'preventas') {
                purchaseLinesPreventas.push({ product_id: item.odoo_product_id, name: item.odoo_product_name || item.descripcion, quantity: totalQty, unit_price: newCost });
            } else {
                if (neggoQty > 0) {
                    purchaseLinesNeggo.push({ product_id: item.odoo_product_id, name: item.odoo_product_name || item.descripcion, quantity: neggoQty, unit_price: newCost });
                }
                if (prevQty > 0) {
                    const { findPreventasProductId } = require('../services/ingresoService');
                    // ingresoService no exporta findPreventasProductId — buscar directo
                    const { rows: [pProd] } = await pool.query(
                        `SELECT odoo_id FROM odoo_products_cache
                         WHERE company = 'preventas'
                           AND REPLACE(REPLACE(UPPER(COALESCE(internal_ref,'')),'-',''),' ','') = ANY($1)
                           AND active = true
                         LIMIT 1`,
                        [[
                            `PRE${(supplierPrefix + item.codigo).replace(/[-\s]/g,'').toUpperCase()}`,
                            `PRE${(item.codigo || '').replace(/[-\s]/g,'').toUpperCase()}`
                        ]]
                    );
                    if (pProd) purchaseLinesPreventas.push({ product_id: pProd.odoo_id, name: item.odoo_product_name || item.descripcion, quantity: prevQty, unit_price: newCost });
                }
            }
        }

        const partnerId = parseInt(odoo_partner_id, 10);
        // Si un intento anterior ya creó la OC, no se vuelve a crear.
        let ocNeggoId = ingreso.odoo_purchase_order_id || null;
        let ocPreventasId = ingreso.odoo_purchase_order_id_preventas || null;
        let createdNeggoId = null;
        let createdPrevId = null;

        try {
            if (purchaseLinesNeggo.length > 0 && !ocNeggoId) {
                createdNeggoId = await odooService.createPurchaseOrder(partnerId, purchaseLinesNeggo, 'neggo');
                ocNeggoId = createdNeggoId;
                console.log(`✅ OC Neggo generada: ${ocNeggoId}`);
            }
            if (purchaseLinesPreventas.length > 0 && !ocPreventasId) {
                createdPrevId = await odooService.createPurchaseOrder(partnerId, purchaseLinesPreventas, 'preventas');
                ocPreventasId = createdPrevId;
                console.log(`✅ OC Preventas generada: ${ocPreventasId}`);
            }

            await pool.query(
                `UPDATE ingreso_mercaderia
                 SET odoo_purchase_order_id = COALESCE(odoo_purchase_order_id, $1),
                     odoo_purchase_order_id_preventas = COALESCE(odoo_purchase_order_id_preventas, $2),
                     odoo_partner_id = $3
                 WHERE id = $4`,
                [ocNeggoId, ocPreventasId, partnerId, ingresoId]
            );
        } catch (err) {
            if (createdNeggoId || createdPrevId) {
                await ingresoService.persistPurchaseOrderIds(ingresoId, createdNeggoId, createdPrevId);
                console.error(`⚠️ OC guardada para no duplicarla (Neggo ${createdNeggoId || '—'}, Preventas ${createdPrevId || '—'}).`);
            }
            throw err;
        }

        return ok(res, {
            odoo_purchase_order_id:           ocNeggoId,
            odoo_purchase_order_id_preventas: ocPreventasId,
            neggo_lines:     purchaseLinesNeggo.length,
            preventas_lines: purchaseLinesPreventas.length,
        });
    } catch (err) {
        console.error('❌ Error generando OC:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/supplement-oc
// Agrega a la OC de Preventas los ítems que quedaron sin preventas_product_id
// en la confirmación original (matching mejorado post-fix).
// Solo aplica a ingresos ya confirmados con OC Preventas existente.
// =============================================

router.post('/:ingresoId/supplement-oc', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    const { baseCode } = require('../utils/textMatch');
    const normRef = (s) => (s || '').replace(/[-\s]/g, '').toUpperCase();

    try {
        const { rows: [ingreso] } = await pool.query(
            `SELECT im.*, s.prefix AS supplier_prefix, s.default_discount
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );

        if (!ingreso) return fail(res, 'Ingreso no encontrado', 404);
        if (ingreso.estado !== 'confirmado') return fail(res, 'El ingreso no está confirmado', 400);
        if (!ingreso.odoo_purchase_order_id_preventas) return fail(res, 'No existe OC Preventas para este ingreso', 400);

        const ocPreventasId    = ingreso.odoo_purchase_order_id_preventas;
        const supplierPrefix   = (ingreso.supplier_prefix || '').toUpperCase();
        const supplierDiscount = parseFloat(ingreso.default_discount || 0);
        const costoEnvio       = parseFloat(ingreso.costo_envio || 0);
        const totalFactura     = parseFloat(ingreso.total_monto || 0);

        const { rows: items } = await pool.query(
            `SELECT * FROM ingreso_items
             WHERE ingreso_id = $1
               AND preventa_qty_confirmed > 0
               AND preventas_product_id IS NULL`,
            [ingresoId]
        );

        if (items.length === 0) return ok(res, { message: 'No hay ítems pendientes de suplementar', added: 0 });

        // Cotizaciones enviadas de Preventas (los borradores no cuentan) — misma fuente que preventa-odoo-match
        const quotations = await odooService.getPreventasQuotations(['sent']);

        const allProductIds = [...new Set(
            quotations.flatMap(q => (q.lines || []).map(l => l.product_id).filter(Boolean))
        )];

        const cacheMap = {};
        if (allProductIds.length > 0) {
            const { rows: cacheRows } = await pool.query(
                `SELECT odoo_id, internal_ref, ext_id_clean,
                        UPPER(REGEXP_REPLACE(
                            COALESCE(SUBSTRING(name FROM '\\{([^}]+)\\}'), ''),
                            '[^A-Z0-9]', '', 'g'
                        )) AS brace_code
                 FROM odoo_products_cache
                 WHERE company = 'preventas' AND odoo_id = ANY($1)`,
                [allProductIds]
            );
            for (const r of cacheRows) cacheMap[r.odoo_id] = r;
        }

        // Todas las líneas de cotizaciones, enriquecidas con ref_candidates
        const todasLasLineas = [];
        for (const q of quotations) {
            for (const line of (q.lines || [])) {
                if (!line.product_id) continue;
                const cached = cacheMap[line.product_id] || {};
                const braceKey = cached.brace_code
                    ? normRef(`PRE${supplierPrefix}${cached.brace_code}`) : null;
                const refCandidates = new Set([
                    normRef(cached.ext_id_clean),
                    normRef(cached.internal_ref),
                    normRef(line.external_id),
                    braceKey,
                ].filter(Boolean));
                todasLasLineas.push({
                    ...line,
                    ref_candidates: refCandidates,
                });
            }
        }

        const newLines  = [];
        const unmatched = [];

        for (const item of items) {
            const codigoBase   = baseCode(item.codigo || '');
            const clavePrePref = `PRE${supplierPrefix}${codigoBase}`;
            const claveBase    = `PRE${codigoBase}`;

            let bestLine  = null;
            let bestScore = 0;

            for (const line of todasLasLineas) {
                let score = 0;
                if (codigoBase.length >= 2 && line.ref_candidates.size > 0) {
                    if (line.ref_candidates.has(clavePrePref)) score = 1.0;
                    else if (line.ref_candidates.has(claveBase)) score = 0.97;
                }
                if (score > bestScore) { bestScore = score; bestLine = line; }
            }

            if (!bestLine) {
                unmatched.push({ id: item.id, codigo: item.codigo, descripcion: item.descripcion });
                continue;
            }

            const packSize    = Math.max(1, parseInt(item.pack_size || 1, 10));
            const rawCost     = parseFloat(item.precio_unitario || 0) / packSize;
            const discount    = item.discount_override !== null ? parseFloat(item.discount_override) : supplierDiscount;
            const newCostBase = discount > 0 ? Math.round(rawCost * (1 - discount / 100) * 100) / 100 : rawCost;
            const participacion = (totalFactura > 0 && item.subtotal > 0) ? parseFloat(item.subtotal) / totalFactura : 0;
            const envioUnitario = (costoEnvio > 0 && parseInt(item.cantidad) > 0)
                ? Math.round(costoEnvio * participacion / (parseInt(item.cantidad) * packSize) * 100) / 100 : 0;
            const newCost = Math.round((newCostBase + envioUnitario) * 100) / 100;

            newLines.push({
                product_id: bestLine.product_id,
                name:       bestLine.product_name || item.descripcion,
                quantity:   parseInt(item.preventa_qty_confirmed, 10),
                unit_price: newCost,
            });

            await pool.query(
                `UPDATE ingreso_items
                 SET preventas_product_id = $1, preventas_product_name = $2
                 WHERE id = $3`,
                [bestLine.product_id, bestLine.product_name || item.descripcion, item.id]
            );
        }

        if (newLines.length > 0) {
            await odooService.addLinesToPurchaseOrder(ocPreventasId, newLines, 'preventas');
        }

        console.log(`✅ supplement-oc ingreso ${ingresoId}: +${newLines.length} líneas a OC ${ocPreventasId}, ${unmatched.length} sin match`);

        return ok(res, {
            oc_preventas_id:  ocPreventasId,
            added:            newLines.length,
            unmatched:        unmatched.length,
            unmatched_items:  unmatched,
        });
    } catch (err) {
        console.error('❌ Error en supplement-oc:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/supplement-neggo-oc
// Agrega a la OC de Neggo los ítems matched que no están en ella todavía.
// Útil para ingresos confirmados antes del fix donde los inactivos quedaron fuera.
// =============================================

router.post('/:ingresoId/supplement-neggo-oc', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;

    try {
        const { rows: [ingreso] } = await pool.query(
            `SELECT im.*, s.default_discount,
                    COALESCE(s.markup_neggo, 0) AS markup_neggo
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );

        if (!ingreso) return fail(res, 'Ingreso no encontrado', 404);
        if (ingreso.estado !== 'confirmado') return fail(res, 'El ingreso no está confirmado', 400);
        if (!ingreso.odoo_purchase_order_id) return fail(res, 'No existe OC Neggo para este ingreso', 400);

        const ocNeggoId        = ingreso.odoo_purchase_order_id;
        const supplierDiscount = parseFloat(ingreso.default_discount || 0);
        const costoEnvio       = parseFloat(ingreso.costo_envio      || 0);
        const totalFactura     = parseFloat(ingreso.total_monto       || 0);

        // Leer las líneas existentes de la OC en Odoo para saber qué productos ya están
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        const companyIds = await getCompanyIds();
        const companyId  = companyIds.neggo;
        if (!companyId) return fail(res, 'Company Neggo no encontrada', 503);

        const existingLines = await callOdoo(
            'purchase.order.line',
            'search_read',
            [[['order_id', '=', ocNeggoId]]],
            { fields: ['product_id', 'product_qty'], context: { allowed_company_ids: [companyId] } }
        );

        const existingProductIds = new Set(
            existingLines.map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id).filter(Boolean)
        );

        // Todos los ítems matched que corresponden a Neggo
        const { rows: items } = await pool.query(
            `SELECT * FROM ingreso_items
             WHERE ingreso_id = $1
               AND estado_item = 'matched'
               AND odoo_product_id IS NOT NULL
               AND (odoo_company IS NULL OR odoo_company = 'neggo')`,
            [ingresoId]
        );

        // Filtrar solo los que no están en la OC todavía
        const missing = items.filter(i => !existingProductIds.has(i.odoo_product_id));

        if (missing.length === 0) {
            return ok(res, { message: 'La OC ya tiene todas las líneas', added: 0 });
        }

        // Construir líneas con costos calculados
        const newLines = [];
        for (const item of missing) {
            const prevQty  = parseInt(item.preventa_qty_confirmed || 0, 10);
            const totalQty = parseInt(item.cantidad, 10);
            const neggoQty = Math.max(0, totalQty - prevQty);
            if (neggoQty <= 0) continue;

            const packSize      = Math.max(1, parseInt(item.pack_size || 1, 10));
            const rawCost       = parseFloat(item.precio_unitario) / packSize;
            const discount      = item.discount_override !== null ? parseFloat(item.discount_override) : supplierDiscount;
            const newCostBase   = discount > 0 ? Math.round(rawCost * (1 - discount / 100) * 100) / 100 : rawCost;
            const participacion = (totalFactura > 0 && item.subtotal > 0) ? parseFloat(item.subtotal) / totalFactura : 0;
            const envioUnitario = (costoEnvio > 0 && totalQty > 0)
                ? Math.round(costoEnvio * participacion / (totalQty * packSize) * 100) / 100 : 0;
            const newCost = Math.round((newCostBase + envioUnitario) * 100) / 100;

            newLines.push({
                product_id: item.odoo_product_id,
                name:       item.odoo_product_name || item.descripcion,
                quantity:   neggoQty,
                unit_price: newCost,
            });
        }

        if (newLines.length === 0) {
            return ok(res, { message: 'Los ítems faltantes no tienen unidades para Neggo', added: 0 });
        }

        await odooService.addLinesToPurchaseOrder(ocNeggoId, newLines, 'neggo');

        console.log(`✅ supplement-neggo-oc ingreso ${ingresoId}: +${newLines.length} líneas a OC Neggo #${ocNeggoId}`);

        return ok(res, {
            oc_neggo_id: ocNeggoId,
            added:       newLines.length,
            lines:       newLines,
        });
    } catch (err) {
        console.error('❌ Error en supplement-neggo-oc:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/sync-odoo-prices
// Trae precios actuales de Odoo para todos los ítems matcheados y actualiza
// el cache local + precio_odoo_anterior en ingreso_items.
// =============================================

router.post('/:ingresoId/sync-odoo-prices', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    try {
        const { callOdoo, getCompanyIds } = require('../config/odoo');

        // Obtener ítems matcheados con producto en Odoo
        const itemsResult = await pool.query(
            `SELECT id, odoo_product_id, COALESCE(odoo_company, 'neggo') AS company
             FROM ingreso_items
             WHERE ingreso_id = $1 AND estado_item = 'matched' AND odoo_product_id IS NOT NULL`,
            [ingresoId]
        );

        if (itemsResult.rows.length === 0) {
            return ok(res, { updated: 0, message: 'Sin ítems matcheados para sincronizar' });
        }

        const companyIds = await getCompanyIds();

        // Agrupar por empresa
        const byCompany = { neggo: [], preventas: [] };
        for (const row of itemsResult.rows) {
            byCompany[row.company]?.push(row);
        }

        let updated = 0;

        for (const [companyKey, rows] of Object.entries(byCompany)) {
            if (rows.length === 0) continue;
            const companyId = companyIds[companyKey];
            if (!companyId) continue;

            const odooIds = [...new Set(rows.map(r => r.odoo_product_id))];

            const products = await callOdoo(
                'product.product', 'read',
                [odooIds, ['id', 'name', 'default_code', 'barcode', 'standard_price', 'list_price', 'active']],
                { context: { allowed_company_ids: [companyId] } }
            );

            const priceMap = {};
            for (const p of products) {
                priceMap[p.id] = { standard_price: p.standard_price || 0, list_price: p.list_price || 0 };

                // Actualizar cache
                await pool.query(
                    `INSERT INTO odoo_products_cache
                     (odoo_id, name, internal_ref, barcode, standard_price, list_price, active, company)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (odoo_id, company) DO UPDATE SET
                         name           = EXCLUDED.name,
                         internal_ref   = EXCLUDED.internal_ref,
                         barcode        = EXCLUDED.barcode,
                         standard_price = EXCLUDED.standard_price,
                         list_price     = EXCLUDED.list_price,
                         active         = EXCLUDED.active`,
                    [p.id, p.name, p.default_code || null, p.barcode || null,
                     p.standard_price || 0, p.list_price || 0, p.active !== false, companyKey]
                );
            }

            // Actualizar precio_odoo_anterior en cada ítem
            for (const row of rows) {
                const prices = priceMap[row.odoo_product_id];
                if (!prices) continue;
                await pool.query(
                    `UPDATE ingreso_items
                     SET precio_odoo_anterior = $1, precio_odoo_lista = $2
                     WHERE id = $3`,
                    [prices.standard_price, prices.list_price, row.id]
                );
                updated++;
            }
        }

        console.log(`🔄 Ingreso ${ingresoId}: ${updated} ítem(s) sincronizados desde Odoo`);
        return ok(res, { updated, message: `${updated} ítem(s) sincronizados desde Odoo` });
    } catch (err) {
        console.error('❌ Error en sync-odoo-prices:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/confirm
// =============================================

router.post('/:ingresoId/confirm', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;
    const { odoo_partner_id } = req.body;

    console.log(`🔄 Confirmando ingreso ${ingresoId} por usuario ${req.user.id}`);

    try {
        const ingresoResult = await pool.query(
            `SELECT * FROM ingreso_mercaderia WHERE id = $1`,
            [ingresoId]
        );

        if (ingresoResult.rows.length === 0) {
            return fail(res, 'Ingreso no encontrado', 404);
        }

        const ingreso = ingresoResult.rows[0];

        if (ingreso.estado !== 'pending') {
            return fail(res, `Ingreso en estado ${ingreso.estado}, no puede confirmarse`, 400);
        }

        // Verificar que no haya ítems pending sin ningún plan (ni Neggo ni Preventas)
        const pendingResult = await pool.query(
            `SELECT COUNT(*) as count FROM ingreso_items
             WHERE ingreso_id = $1
               AND estado_item = 'pending'
               AND COALESCE(preventa_qty_confirmed, 0) = 0
               AND preventas_product_id IS NULL`,
            [ingresoId]
        );

        if (parseInt(pendingResult.rows[0].count, 10) > 0) {
            return fail(res, 'Hay items sin resolver. Vincinalos a Neggo, asignálos a preventa o rechazálos.', 400);
        }

        const result = await ingresoService.confirmIngreso(
            ingresoId,
            req.user.id,
            odoo_partner_id ? parseInt(odoo_partner_id, 10) : null
        );

        console.log(`✅ Ingreso ${ingresoId} confirmado: ${result.updated_products_count} productos actualizados`);

        return ok(res, result);
    } catch (err) {
        console.error('❌ Error en confirm:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// DELETE /api/ingreso/:ingresoId/items/:itemId/mapping
// Elimina la vinculación persistente incorrecta para un item
// =============================================

router.delete('/:ingresoId/items/:itemId/mapping', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId, itemId } = req.params;

    try {
        const itemResult = await pool.query(
            `SELECT ii.codigo, im.supplier_id
             FROM ingreso_items ii
             JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
             WHERE ii.id = $1 AND ii.ingreso_id = $2`,
            [itemId, ingresoId]
        );

        if (itemResult.rows.length === 0) return fail(res, 'Item no encontrado', 404);

        const { codigo, supplier_id } = itemResult.rows[0];

        if (!codigo || !supplier_id) {
            return fail(res, 'El item no tiene código o proveedor para limpiar', 400);
        }

        const { rowCount } = await pool.query(
            `DELETE FROM invoice_code_mappings
             WHERE supplier_id = $1 AND UPPER(raw_code) = UPPER($2)`,
            [supplier_id, codigo]
        );

        console.log(`🧹 Mapping eliminada: proveedor ${supplier_id}, código "${codigo}" (${rowCount} registros)`);
        return ok(res, { deleted: rowCount, codigo, supplier_id });
    } catch (err) {
        console.error('❌ Error eliminando mapping:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/ingreso/:ingresoId/preventa-odoo-match
// Compara ítems del ingreso con cotizaciones abiertas en Odoo Preventas
// Match por odoo_product_id (producto compartido entre empresas)
// =============================================

router.get('/:ingresoId/preventa-odoo-match', authenticate, async (req, res) => {
    const { ingresoId } = req.params;
    const { baseCode } = require('../utils/textMatch');

    // Normaliza un internal_ref quitando guiones y espacios, en mayúsculas
    const normRef = (s) => (s || '').replace(/[-\s]/g, '').toUpperCase();

    try {
        // Prefijo del proveedor del ingreso
        const { rows: [ingresoInfo] } = await pool.query(
            `SELECT im.supplier_id, COALESCE(s.prefix, '') AS supplier_prefix
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1`,
            [ingresoId]
        );
        const supplierPrefix = (ingresoInfo?.supplier_prefix || '').toUpperCase();

        // Todos los ítems del ingreso (sin filtrar por estado)
        const { rows: items } = await pool.query(
            `SELECT id, descripcion, codigo, cantidad, precio_unitario,
                    odoo_product_id, odoo_product_name, estado_item
             FROM ingreso_items
             WHERE ingreso_id = $1`,
            [ingresoId]
        );

        if (items.length === 0) return ok(res, []);

        // Agrupar ítems duplicados por código: un proveedor puede facturar el mismo
        // artículo en dos renglones separados. Sumamos cantidades y usamos el primer
        // ingreso_item_id como representante para guardar la confirmación de preventa.
        const codigoMap   = new Map();
        const itemsUnicos = [];
        for (const item of items) {
            const key = (item.codigo || String(item.id)).toUpperCase();
            if (codigoMap.has(key)) {
                const prev = codigoMap.get(key);
                prev.cantidad = String(parseInt(prev.cantidad) + parseInt(item.cantidad));
            } else {
                const clone = { ...item };
                codigoMap.set(key, clone);
                itemsUnicos.push(clone);
            }
        }

        // Cotizaciones enviadas de Odoo Preventas (ya traen default_code por producto; los borradores no cuentan)
        const quotations = await require('../services/odooService').getPreventasQuotations(['sent']);

        // Enriquecer líneas con datos del cache local:
        // external_id en getPreventasQuotations viene del default_code de Odoo (internal_ref sin PRE).
        // El cache local tiene TAMBIÉN el ext_id_clean de ir.model.data (que sí tiene el PRE correcto).
        // Usamos ambos para el match.
        const allProductIds = [...new Set(
            quotations.flatMap(q => (q.lines || []).map(l => l.product_id).filter(Boolean))
        )];

        const cacheMap = {};
        if (allProductIds.length > 0) {
            const { rows: cacheRows } = await pool.query(
                `SELECT odoo_id, internal_ref, ext_id_clean,
                        -- Código del fabricante entre llaves en el nombre: "LINTERNA {WD81} ..." → "WD81"
                        UPPER(REGEXP_REPLACE(
                            COALESCE(SUBSTRING(name FROM '\\{([^}]+)\\}'), ''),
                            '[^A-Z0-9]', '', 'g'
                        )) AS brace_code
                 FROM odoo_products_cache
                 WHERE company = 'preventas' AND odoo_id = ANY($1)`,
                [allProductIds]
            );
            for (const r of cacheRows) {
                cacheMap[r.odoo_id] = {
                    internal_ref:  r.internal_ref,
                    ext_id_clean:  r.ext_id_clean,
                    brace_code:    r.brace_code || null,
                };
            }
        }

        const todasLasLineas = [];
        for (const q of quotations) {
            for (const line of (q.lines || [])) {
                const cached = line.product_id ? (cacheMap[line.product_id] || {}) : {};
                // Candidatos de referencia — cuatro fuentes:
                // 1. ext_id_clean: ir.model.data — ej: "PRECTWB138"
                // 2. internal_ref: extraído del "Art." del nombre — ej: "PRECTEZRA"
                // 3. default_code live — ej: "CTWB138"
                // 4. Código {WD81} del nombre + prefijo proveedor — ej: "PRECTWD81"
                //    (para productos donde el código de factura difiere del código Art.)
                const braceKey = cached.brace_code
                    ? normRef(`PRE${supplierPrefix}${cached.brace_code}`)
                    : null;

                const refCandidates = new Set([
                    normRef(cached.ext_id_clean),
                    cached.ext_id_clean || '',
                    normRef(cached.internal_ref),
                    normRef(line.external_id),
                    braceKey,
                ].filter(Boolean));

                todasLasLineas.push({
                    ...line,
                    quotation:      q,
                    ref_candidates: refCandidates,
                    ref_norm:       normRef(line.external_id),
                });
            }
        }

        console.log(`📋 preventa-odoo-match [${ingresoId}] prefijo="${supplierPrefix}" | ${items.length} ítems (${itemsUnicos.length} únicos) | ${quotations.length} cotizaciones | ${todasLasLineas.length} líneas`);

        // DEBUG: mostrar muestra de líneas y sus refs normalizadas
        const muestraLineas = todasLasLineas.slice(0, 5).map(l => `  "${l.product_name}" external_id="${l.external_id}" ref_norm="${l.ref_norm}"`);
        console.log('🔍 Muestra de líneas Preventas:\n' + muestraLineas.join('\n'));

        // DEBUG: mostrar muestra de ítems y sus claves construidas
        const muestraItems = itemsUnicos.slice(0, 5).map(i => {
            const cb = baseCode(i.codigo || '');
            return `  desc="${i.descripcion}" codigo="${i.codigo}" baseCode="${cb}" claveConPref="PRE${supplierPrefix}${cb}"`;
        });
        console.log('🔍 Muestra de ítems ingreso:\n' + muestraItems.join('\n'));

        const result = [];

        for (const item of itemsUnicos) {
            // Clave PRE + PREFIJO + código_base (sin guiones)
            const codigoBase    = baseCode(item.codigo || '');
            const clavePrePref  = `PRE${supplierPrefix}${codigoBase}`; // ej: PREIMPINF1093
            const claveBaseSola = `PRE${codigoBase}`;                  // fallback sin prefijo proveedor
            const matcheados = [];

            for (const line of todasLasLineas) {
                let matchType  = null;
                let matchScore = 0;

                // 1. Comparación por código contra TODAS las referencias del producto:
                //    ext_id_clean (ir.model.data), internal_ref (cache) y default_code (live).
                //    Esto cubre el caso donde default_code no tiene prefijo PRE pero ext_id sí.
                if (codigoBase.length >= 2 && line.ref_candidates?.size > 0) {
                    if (line.ref_candidates.has(clavePrePref)) {
                        matchType  = 'pre_prefijo_codigo';
                        matchScore = 1.0;
                    } else if (line.ref_candidates.has(claveBaseSola)) {
                        matchType  = 'pre_codigo';
                        matchScore = 0.97;
                    }
                }

                if (matchType) {
                    matcheados.push({
                        quotation_id:   line.quotation.id,
                        quotation_name: line.quotation.name,
                        client:         line.quotation.client,
                        date:           line.quotation.date,
                        state:          line.quotation.state,
                        line_id:        line.id,
                        product_id:     line.product_id,
                        product_name:   line.product_name,
                        quantity:       line.quantity,
                        unit_price:     line.unit_price,
                        subtotal:       line.subtotal,
                        match_type:     matchType,
                        match_score:    matchScore,
                    });
                }
            }

            if (matcheados.length > 0) {
                result.push({
                    ingreso_item_id:   item.id,
                    descripcion:       item.descripcion,
                    codigo:            item.codigo,
                    ingreso_cantidad:  parseInt(item.cantidad),
                    precio_factura:    parseFloat(item.precio_unitario || 0),
                    estado_item:       item.estado_item,
                    odoo_product_name: item.odoo_product_name,
                    total_cotizado:    matcheados.reduce((s, m) => s + (m.quantity || 0), 0),
                    cotizaciones:      matcheados,
                });
            }
        }

        console.log(`✅ preventa-odoo-match [${ingresoId}]: ${result.length} ítems con coincidencias`);
        return ok(res, result);
    } catch (err) {
        console.error('❌ Error en preventa-odoo-match:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/merge-duplicate-items
// Fusiona ítems con el mismo código en un solo registro, sumando cantidades y
// unidades recibidas. Útil cuando el proveedor factura el mismo artículo en
// varios renglones separados. Solo aplica a ingresos en estado 'pending'.
// =============================================

router.post('/:ingresoId/merge-duplicate-items', authenticate, async (req, res) => {
    const { ingresoId } = req.params;
    const client = await pool.connect();
    try {
        const { rows: [ingreso] } = await client.query(
            `SELECT estado FROM ingreso_mercaderia WHERE id = $1`,
            [ingresoId]
        );
        if (!ingreso) return fail(res, 'Ingreso no encontrado', 404);
        if (ingreso.estado !== 'pending') return fail(res, 'Solo se pueden fusionar ítems en ingresos pendientes', 400);

        await client.query('BEGIN');

        // Encontrar grupos de duplicados (mismo código, mismo ingreso)
        const { rows: grupos } = await client.query(`
            SELECT
                codigo,
                array_agg(id ORDER BY id)                              AS item_ids,
                array_agg(cantidad ORDER BY id)                        AS cantidades,
                array_agg(COALESCE(received_qty, 0) ORDER BY id)       AS received_qtys,
                array_agg(COALESCE(preventa_qty_confirmed, 0) ORDER BY id) AS preventa_qtys
            FROM ingreso_items
            WHERE ingreso_id = $1
              AND codigo IS NOT NULL AND codigo <> ''
            GROUP BY codigo
            HAVING COUNT(*) > 1
        `, [ingresoId]);

        let mergedGroups = 0;
        let mergedItems  = 0;

        for (const g of grupos) {
            const [primaryId, ...secondaryIds] = g.item_ids;
            const totalCantidad  = g.cantidades.reduce((s, c) => s + parseInt(c), 0);
            const totalReceived  = g.received_qtys.reduce((s, r) => s + parseInt(r), 0);
            const totalPreventa  = g.preventa_qtys.reduce((s, p) => s + parseInt(p), 0);

            await client.query(
                `UPDATE ingreso_items
                 SET cantidad = $1,
                     received_qty = $2,
                     preventa_qty_confirmed = $3
                 WHERE id = $4`,
                [totalCantidad, totalReceived, totalPreventa, primaryId]
            );

            if (secondaryIds.length > 0) {
                await client.query(
                    `DELETE FROM ingreso_items WHERE id = ANY($1)`,
                    [secondaryIds]
                );
            }

            mergedGroups++;
            mergedItems += secondaryIds.length;
        }

        // Actualizar items_count en ingreso_mercaderia
        const { rows: [{ count }] } = await client.query(
            `SELECT COUNT(*) AS count FROM ingreso_items WHERE ingreso_id = $1`,
            [ingresoId]
        );
        await client.query(
            `UPDATE ingreso_mercaderia SET items_count = $2 WHERE id = $1`,
            [ingresoId, parseInt(count)]
        );

        await client.query('COMMIT');
        console.log(`🔀 merge-duplicate-items [${ingresoId}]: ${mergedGroups} grupos, ${mergedItems} ítems eliminados`);
        return ok(res, {
            merged_groups: mergedGroups,
            removed_items: mergedItems,
            message: mergedGroups === 0
                ? 'No hay artículos duplicados para fusionar'
                : `${mergedGroups} artículo(s) fusionados, ${mergedItems} fila(s) eliminadas`,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error en merge-duplicate-items:', err);
        return fail(res, err.message, 500);
    } finally {
        client.release();
    }
});

// =============================================
// GET /api/ingreso/:ingresoId/preventa-items
// Ítems del ingreso que están en pedidos de clientes activos
// =============================================

router.get('/:ingresoId/preventa-items', authenticate, async (req, res) => {
    const { ingresoId } = req.params;

    try {
        const { rows } = await pool.query(`
            SELECT
                ii.id                   AS ingreso_item_id,
                ii.descripcion,
                ii.codigo,
                ii.cantidad             AS ingreso_cantidad,
                ii.odoo_product_name,
                ii.odoo_product_id,
                pco.id                  AS client_order_id,
                pco.client_name,
                pco.client_phone,
                pco.status              AS order_status,
                pcoi.quantity           AS preventa_cantidad
            FROM ingreso_items ii
            JOIN preventa_client_order_items pcoi ON pcoi.supplier_product_id = ii.supplier_product_id
            JOIN preventa_client_orders pco       ON pco.id = pcoi.client_order_id
            WHERE ii.ingreso_id = $1
              AND ii.supplier_product_id IS NOT NULL
              AND pco.status NOT IN ('cancelado')
            ORDER BY ii.id, pco.client_name
        `, [ingresoId]);

        // Agrupar por ingreso_item_id
        const map = {};
        for (const row of rows) {
            const k = row.ingreso_item_id;
            if (!map[k]) {
                map[k] = {
                    ingreso_item_id:  k,
                    descripcion:      row.descripcion,
                    codigo:           row.codigo,
                    ingreso_cantidad: parseInt(row.ingreso_cantidad),
                    odoo_product_name: row.odoo_product_name,
                    odoo_product_id:  row.odoo_product_id,
                    total_preventa:   0,
                    clientes:         []
                };
            }
            const qty = parseInt(row.preventa_cantidad);
            map[k].clientes.push({
                client_name:     row.client_name,
                client_phone:    row.client_phone,
                client_order_id: row.client_order_id,
                order_status:    row.order_status,
                quantity:        qty
            });
            map[k].total_preventa += qty;
        }

        return ok(res, Object.values(map));
    } catch (err) {
        console.error('❌ Error en preventa-items:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// DELETE /api/ingreso/:ingresoId
// Solo ingresos en estado pending
// =============================================

router.delete('/:ingresoId', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;

    try {
        const result = await pool.query(
            `SELECT id, estado FROM ingreso_mercaderia WHERE id = $1`,
            [ingresoId]
        );

        if (result.rows.length === 0) {
            return fail(res, 'Ingreso no encontrado', 404);
        }

        if (result.rows[0].estado !== 'pending') {
            return fail(res, 'Solo se pueden eliminar ingresos pendientes', 400);
        }

        await pool.query(`DELETE FROM ingreso_mercaderia WHERE id = $1`, [ingresoId]);

        console.log(`🗑️ Ingreso ${ingresoId} eliminado por usuario ${req.user.id}`);

        return ok(res, { message: 'Ingreso eliminado correctamente' });
    } catch (err) {
        console.error('❌ Error eliminando ingreso:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/rematch
// Re-match en background para ítems pending, y para los que vinculó solo la
// descripción de compra sin que nadie los tilde (mientras no haya OC).
// Devuelve solo los ítems que cambiaron (con JOIN data).
// =============================================

router.post('/:ingresoId/rematch', authenticate, async (req, res) => {
    const { ingresoId } = req.params;

    try {
        const ingresoResult = await pool.query(
            `SELECT supplier_id, odoo_purchase_order_id, odoo_purchase_order_id_preventas
             FROM ingreso_mercaderia WHERE id = $1`,
            [ingresoId]
        );
        if (!ingresoResult.rows.length) return fail(res, 'Ingreso no encontrado', 404);

        const { supplier_id, odoo_purchase_order_id, odoo_purchase_order_id_preventas } = ingresoResult.rows[0];
        const sinOc = !odoo_purchase_order_id && !odoo_purchase_order_id_preventas;

        const pendingResult = await pool.query(
            `SELECT id, codigo, descripcion, cantidad, precio_unitario, subtotal,
                    odoo_product_id AS prev_odoo_product_id, match_level AS prev_match_level
             FROM ingreso_items
             WHERE ingreso_id = $1
               AND (estado_item = 'pending' OR estado_item = 'no_match'
                    OR ($2 AND estado_item = 'matched' AND match_level = 'desc_purchase'
                        AND checked IS NOT TRUE))
               AND codigo IS NOT NULL AND codigo <> ''`,
            [ingresoId, sinOc]
        );

        if (pendingResult.rows.length === 0) return ok(res, []);

        const rematched = await ingresoService.matchItems(
            pendingResult.rows,
            supplier_id || null
        );

        const updated = [];
        for (const rm of rematched) {
            if (rm.prev_match_level === 'desc_purchase') {
                // Sigue igual: no hay nada que tocar
                if (rm.odoo_product_id === rm.prev_odoo_product_id) continue;
                // La descripción genérica ya no alcanza: se desvincula para que una persona elija
                if (!rm.odoo_product_id) {
                    await pool.query(
                        `UPDATE ingreso_items
                         SET odoo_product_id = NULL, odoo_product_name = NULL,
                             estado_item = 'pending', odoo_active = NULL,
                             confidence_match = 0, match_level = NULL, error_match = $1,
                             precio_odoo_anterior = NULL, precio_odoo_lista = NULL
                         WHERE id = $2`,
                        [rm.error_match, rm.id]
                    );
                    updated.push({
                        id: rm.id, odoo_product_id: null, odoo_product_name: null,
                        estado_item: 'pending', odoo_active: null, confidence_match: 0,
                        match_level: null, error_match: rm.error_match,
                        precio_odoo_anterior: null, precio_odoo_lista: null,
                        odoo_barcode: null, odoo_internal_ref: null, odoo_list_price: null,
                    });
                    continue;
                }
            }
            if (!rm.odoo_product_id) continue;
            // Lo dudoso (ej. un parecido de nombre) queda pendiente hasta que una persona lo confirme.
            const auto = rm.estado_item === 'matched'
                && !ingresoService.MATCH_LEVELS_TO_CONFIRM.includes(rm.match_level);

            await pool.query(
                `UPDATE ingreso_items
                 SET odoo_product_id   = $1,
                     odoo_product_name = $2,
                     estado_item       = $3,
                     odoo_active       = $4,
                     confidence_match  = $5,
                     error_match       = NULL,
                     precio_odoo_anterior = $6,
                     precio_odoo_lista    = $7,
                     match_level       = $8
                 WHERE id = $9`,
                [
                    rm.odoo_product_id, rm.odoo_product_name,
                    auto ? 'matched' : 'pending',
                    rm.odoo_active !== false,
                    rm.confidence_match,
                    rm.precio_odoo_anterior || null,
                    rm.precio_odoo_lista    || null,
                    rm.match_level || null,
                    rm.id,
                ]
            );

            const { rows: [item] } = await pool.query(
                `SELECT ii.*,
                        opc.barcode      AS odoo_barcode,
                        opc.internal_ref AS odoo_internal_ref,
                        opc.list_price   AS odoo_list_price,
                        opc.active       AS odoo_active_current,
                        sp.image_url     AS supplier_image_url,
                        sp.name          AS supplier_product_name_matched,
                        sp.sku           AS supplier_sku
                 FROM ingreso_items ii
                 LEFT JOIN odoo_products_cache opc
                        ON opc.odoo_id = ii.odoo_product_id AND opc.company = COALESCE(ii.odoo_company, 'neggo')
                 LEFT JOIN supplier_products sp
                        ON sp.id = ii.supplier_product_id
                 WHERE ii.id = $1`,
                [rm.id]
            );
            if (item) updated.push({ ...item, odoo_active: item.odoo_active_current ?? item.odoo_active });
        }

        if (updated.length > 0)
            console.log(`🔄 Ingreso ${ingresoId}: ${updated.length} ítem(s) re-matcheados`);

        return ok(res, updated);
    } catch (err) {
        console.error('❌ Error en rematch:', err.message);
        return fail(res, err.message, 500);
    }
});

// =============================================
// GET /api/ingreso
// =============================================

router.get('/', authenticate, async (req, res) => {
    const { supplier_id, estado, desde, hasta, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT im.*, s.name as supplier_name
            FROM ingreso_mercaderia im
            LEFT JOIN suppliers s ON s.id = im.supplier_id
            WHERE 1=1`;
        const params = [];
        let paramCount = 0;

        if (supplier_id) {
            paramCount++;
            query += ` AND im.supplier_id = $${paramCount}`;
            params.push(parseInt(supplier_id, 10));
        }

        if (estado) {
            paramCount++;
            query += ` AND im.estado = $${paramCount}`;
            params.push(estado);
        }

        if (desde) {
            paramCount++;
            query += ` AND im.created_at >= $${paramCount}`;
            params.push(desde);
        }

        if (hasta) {
            paramCount++;
            query += ` AND im.created_at <= $${paramCount}`;
            params.push(hasta);
        }

        // Contar total
        const countResult = await pool.query(
            query.replace('SELECT im.*, s.name as supplier_name', 'SELECT COUNT(*) as total'),
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Paginar
        paramCount++;
        query += ` ORDER BY im.created_at DESC LIMIT $${paramCount}`;
        params.push(Math.min(parseInt(limit, 10), 100));

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        params.push(parseInt(offset, 10));

        const result = await pool.query(query, params);

        return paginated(res, result.rows, total, limit, offset);
    } catch (err) {
        console.error('❌ Error en GET list:', err);
        return fail(res, err.message, 500);
    }
});

// =============================================
// POST /api/ingreso/:ingresoId/correct-oc
// Corrige las OC de Odoo de un ingreso ya confirmado aplicando:
//  1. Unidades faltantes por bug pack_size > 1 en OC Neggo
//  2. Líneas sin match de Preventas que quedaron fuera de P00044
//  3. Ajuste de envío para ítems pending que sí entraron a P00044 pero sin envío
// =============================================

router.post('/:ingresoId/correct-oc', authenticate, requireRole('admin'), async (req, res) => {
    const { ingresoId } = req.params;

    try {
        const { rows: [ingreso] } = await pool.query(
            `SELECT im.*, s.default_discount, s.prefix AS supplier_prefix
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1 AND im.estado = 'confirmado'`,
            [ingresoId]
        );

        if (!ingreso) return fail(res, 'Ingreso no encontrado o no está confirmado', 404);

        const ocNeggoId    = ingreso.odoo_purchase_order_id;
        const ocPrevId     = ingreso.odoo_purchase_order_id_preventas;
        const totalFactura = parseFloat(ingreso.total_monto || 0);
        const costoEnvio   = parseFloat(ingreso.costo_envio || 0);
        const discount     = parseFloat(ingreso.default_discount || 0);
        const prefix       = ingreso.supplier_prefix || '';

        const { rows: items } = await pool.query(
            `SELECT * FROM ingreso_items WHERE ingreso_id = $1`,
            [ingresoId]
        );

        // Precalcular matches preventas para todos los ítems de una sola vez
        const codigosUnicos = [...new Set(items.map(i => i.codigo).filter(Boolean))];
        const prevMatchMap  = {}; // codigo → odoo_id preventas

        if (codigosUnicos.length > 0) {
            const normRef = (s) => (s || '').replace(/[-\s]/g, '').toUpperCase();
            const normPref = normRef(prefix);
            const candidates = codigosUnicos.flatMap(c => {
                const base = normRef(c);
                const withPref = normPref ? `PRE${normPref}${base}` : null;
                return [withPref, `PRE${base}`].filter(Boolean);
            });

            const { rows: prevRows } = await pool.query(
                `SELECT odoo_id, internal_ref, ext_id_clean
                 FROM odoo_products_cache
                 WHERE company = 'preventas' AND active = true
                   AND (
                     REPLACE(REPLACE(UPPER(COALESCE(internal_ref,'')),'-',''),' ','') = ANY($1)
                     OR ext_id_clean = ANY($1)
                   )`,
                [candidates]
            );

            for (const r of prevRows) {
                const ref = normRef(r.internal_ref || r.ext_id_clean || '');
                for (const c of codigosUnicos) {
                    const base = normRef(c);
                    const withPref = normPref ? `PRE${normPref}${base}` : null;
                    if (ref === withPref || ref === `PRE${base}`) {
                        if (!prevMatchMap[c]) prevMatchMap[c] = r.odoo_id;
                    }
                }
            }
        }

        const corrNeggo = []; // líneas a añadir a OC Neggo
        const corrPrev  = []; // líneas a añadir a OC Preventas

        for (const item of items) {
            const packSize  = Math.max(1, parseInt(item.pack_size || 1, 10));
            const rawCost   = parseFloat(item.precio_unitario) / packSize;
            const disc      = item.discount_override !== null ? parseFloat(item.discount_override) : discount;
            const costBase  = Math.round(rawCost * (1 - disc / 100) * 100) / 100;
            const partic    = (totalFactura > 0 && parseFloat(item.subtotal) > 0)
                ? parseFloat(item.subtotal) / totalFactura : 0;
            const envioUnit = (costoEnvio > 0 && parseInt(item.cantidad) > 0)
                ? Math.round(costoEnvio * partic / (parseInt(item.cantidad) * packSize) * 100) / 100 : 0;
            const newCost   = Math.round((costBase + envioUnit) * 100) / 100;
            const prevQty   = parseInt(item.preventa_qty_confirmed || 0, 10);
            const prevOdooId = item.preventas_product_id
                || prevMatchMap[item.codigo] || null;

            if (item.estado_item === 'matched' && item.odoo_product_id) {
                const neggoQty = parseInt(item.cantidad, 10) - prevQty;

                // Corrección pack_size en OC Neggo (cantidad enviada fue sin *packSize)
                if (packSize > 1 && neggoQty > 0 && ocNeggoId) {
                    corrNeggo.push({
                        product_id: item.odoo_product_id,
                        name:       item.odoo_product_name || item.descripcion,
                        quantity:   neggoQty * (packSize - 1),
                        unit_price: newCost,
                    });
                }

                // Corrección preventa: línea que faltó en P00044
                if (prevQty > 0 && ocPrevId) {
                    if (prevOdooId) {
                        // pack_size > 1: faltaron unidades multiplicadas
                        if (packSize > 1) {
                            corrPrev.push({
                                product_id: prevOdooId,
                                name:       item.odoo_product_name || item.descripcion,
                                quantity:   prevQty * (packSize - 1),
                                unit_price: newCost,
                            });
                        }
                        // pack_size = 1 y precio correcto: sin corrección (envio incluido en matched branch)
                    } else {
                        // Sin producto Preventas: la línea nunca se creó
                        corrPrev.push({
                            product_id: false,
                            name:       item.odoo_product_name || item.descripcion,
                            quantity:   prevQty * packSize,
                            unit_price: newCost,
                        });
                    }
                }

            } else if (item.estado_item === 'pending' && prevQty > 0 && ocPrevId) {
                if (prevOdooId) {
                    // La línea existe en P00044 al costo base (sin envío) → añadir ajuste de envío
                    if (envioUnit > 0) {
                        corrPrev.push({
                            product_id: prevOdooId,
                            name:       `[Ajuste envío] ${item.descripcion}`,
                            quantity:   prevQty * packSize,
                            unit_price: envioUnit,
                        });
                    }
                } else {
                    // Sin producto Preventas: la línea nunca se creó
                    corrPrev.push({
                        product_id: false,
                        name:       item.descripcion,
                        quantity:   prevQty * packSize,
                        unit_price: newCost,
                    });
                }
            }
        }

        const resultNeggo = { lines_added: 0, total_added: 0, error: null };
        const resultPrev  = { lines_added: 0, total_added: 0, error: null };

        if (corrNeggo.length > 0 && ocNeggoId) {
            try {
                await odooService.addLinesToPurchaseOrder(ocNeggoId, corrNeggo, 'neggo');
                resultNeggo.lines_added = corrNeggo.length;
                resultNeggo.total_added = Math.round(corrNeggo.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100) / 100;
                console.log(`✅ correct-oc Neggo ingreso ${ingresoId}: +${corrNeggo.length} líneas ($${resultNeggo.total_added})`);
            } catch (err) {
                resultNeggo.error = err.message;
                console.error(`⚠️ correct-oc Neggo ingreso ${ingresoId}: ${err.message}`);
            }
        }

        if (corrPrev.length > 0 && ocPrevId) {
            try {
                await odooService.addLinesToPurchaseOrder(ocPrevId, corrPrev, 'preventas');
                resultPrev.lines_added = corrPrev.length;
                resultPrev.total_added = Math.round(corrPrev.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100) / 100;
                console.log(`✅ correct-oc Preventas ingreso ${ingresoId}: +${corrPrev.length} líneas ($${resultPrev.total_added})`);
            } catch (err) {
                resultPrev.error = err.message;
                console.error(`⚠️ correct-oc Preventas ingreso ${ingresoId}: ${err.message}`);
            }
        }

        return ok(res, {
            neggo:    { oc_id: ocNeggoId, ...resultNeggo },
            preventas: { oc_id: ocPrevId, ...resultPrev },
            details:  { corrections_neggo: corrNeggo, corrections_preventas: corrPrev },
        });

    } catch (err) {
        console.error('❌ Error en correct-oc:', err);
        return fail(res, err.message, 500);
    }
});

module.exports = router;
