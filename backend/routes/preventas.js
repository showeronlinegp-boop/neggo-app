// Rutas del módulo Preventas
// Pedidos de clientes, órdenes a proveedores, shopping list

const router = require('express').Router();
const pool = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail, paginated } = require('../utils/response');
const { addItemToOrder, addOdooItemToOrder, generateSupplierOrders, sendOrderToOdoo, getShoppingList } = require('../services/preventasService');
const {
    SIN_PROVEEDOR,
    formatEntero,
    formatMoneyAR,
    formatFechaAR,
    groupQuotationsBySupplier,
} = require('../services/supplierBreakdown');

// =============================================
// Helper: re-sincroniza las líneas de los sale.orders en Odoo
// =============================================

async function syncLinesToOdoo(orderId) {
    const odooService = require('../services/odooService');
    const { rows: orders } = await pool.query(
        'SELECT odoo_sale_order_id, neggo_sale_order_id FROM preventa_client_orders WHERE id = $1',
        [orderId]
    );
    if (!orders.length) return;
    const order = orders[0];

    const { rows: items } = await pool.query(
        'SELECT * FROM preventa_client_order_items WHERE client_order_id = $1 ORDER BY id',
        [orderId]
    );

    const toLines = arr => arr.map(i => ({
        product_id: i.odoo_product_id || false,
        name:       i.sku ? `[${i.sku}] ${i.product_name}` : i.product_name,
        quantity:   i.quantity,
        unit_price: parseFloat(i.unit_price || 0),
    }));

    if (order.neggo_sale_order_id) {
        const neggoItems = items.filter(i => i.odoo_company === 'neggo');
        await odooService.updateSaleOrderLines(order.neggo_sale_order_id, toLines(neggoItems), 'neggo');
    }
    if (order.odoo_sale_order_id) {
        const preventasItems = items.filter(i => i.odoo_company === 'preventas' || !i.odoo_company);
        await odooService.updateSaleOrderLines(order.odoo_sale_order_id, toLines(preventasItems), 'preventas');
    }
}

// =============================================
// PEDIDOS DE CLIENTES
// =============================================

// GET /api/preventas/customers — búsqueda de clientes en Odoo Preventas
router.get('/customers', authenticate, async (req, res) => {
    const { search = '', limit = 20 } = req.query;
    try {
        const odooService = require('../services/odooService');
        const customers = await odooService.getCustomers('preventas', {
            search: search.trim(),
            limit: Math.min(parseInt(limit) || 20, 50),
        });
        ok(res, customers);
    } catch (err) {
        console.error('❌ Error al buscar clientes en Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/customers — crear nuevo cliente en Odoo (partner global)
router.post('/customers', authenticate, async (req, res) => {
    const { name, phone, mobile, email } = req.body;
    if (!name?.trim()) return fail(res, 'El nombre del cliente es requerido');
    try {
        const odooService = require('../services/odooService');
        const partner = await odooService.createCustomer({ name: name.trim(), phone, mobile, email }, 'preventas');
        console.log(`✅ Nuevo cliente creado en Odoo: ${partner.name} (ID: ${partner.id})`);
        ok(res, partner, 201);
    } catch (err) {
        console.error('❌ Error al crear cliente en Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/customers/:id — datos frescos de un partner desde Odoo
router.get('/customers/:id', authenticate, async (req, res) => {
    try {
        const odooService = require('../services/odooService');
        const partner = await odooService.getCustomerById(parseInt(req.params.id), 'preventas');
        if (!partner) return fail(res, 'Cliente no encontrado en Odoo', 404);
        ok(res, partner);
    } catch (err) {
        console.error('❌ Error al obtener cliente de Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/client-orders — crear pedido
// Acepta odoo_partner_id para vincular con un cliente de Odoo Preventas
// Acepta pricelist_id opcional para precios especiales
router.post('/client-orders', authenticate, async (req, res) => {
    const { client_name, client_phone, client_notes, odoo_partner_id, pricelist_id } = req.body;
    if (!client_name) return fail(res, 'El nombre del cliente es requerido');
    try {
        const { rows } = await pool.query(
            `INSERT INTO preventa_client_orders (client_name, client_phone, notes, status, created_by, odoo_partner_id, pricelist_id)
             VALUES ($1, $2, $3, 'pendiente', $4, $5, $6) RETURNING *`,
            [client_name, client_phone || null, client_notes || null, req.user.id, odoo_partner_id || null, pricelist_id || null]
        );
        const info = [
            odoo_partner_id ? `partner Odoo: ${odoo_partner_id}` : null,
            pricelist_id    ? `lista: ${pricelist_id}` : null,
        ].filter(Boolean).join(', ');
        console.log(`✅ Pedido creado para "${client_name}" (ID: ${rows[0].id}${info ? `, ${info}` : ''})`);
        ok(res, rows[0], 201);
    } catch (err) {
        console.error('❌ Error al crear pedido:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/client-orders — lista con filtros
router.get('/client-orders', authenticate, async (req, res) => {
    const { status, search, limit = 20, offset = 0 } = req.query;
    try {
        const conditions = [];
        const params = [];

        if (status) { params.push(status); conditions.push(`o.status = $${params.length}`); }
        if (search) { params.push(`%${search}%`); conditions.push(`o.client_name ILIKE $${params.length}`); }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM preventa_client_orders o ${where}`, params
        );

        params.push(parseInt(limit), parseInt(offset));
        const { rows } = await pool.query(
            `SELECT o.*, u.username as created_by_username,
                    COUNT(i.id) as item_count,
                    COALESCE(SUM(i.quantity * i.unit_price), 0) as total_estimated
             FROM preventa_client_orders o
             LEFT JOIN users u ON u.id = o.created_by
             LEFT JOIN preventa_client_order_items i ON i.client_order_id = o.id
             ${where}
             GROUP BY o.id, u.username
             ORDER BY o.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        paginated(res, rows, countResult.rows[0].count, limit, offset);
    } catch (err) {
        console.error('❌ Error al listar pedidos:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/client-orders/:id — detalle con items
router.get('/client-orders/:id', authenticate, async (req, res) => {
    try {
        const { rows: orders } = await pool.query(
            `SELECT o.*, u.username as created_by_username
             FROM preventa_client_orders o
             LEFT JOIN users u ON u.id = o.created_by
             WHERE o.id = $1`,
            [req.params.id]
        );
        if (!orders.length) return fail(res, 'Pedido no encontrado', 404);

        const { rows: items } = await pool.query(
            `SELECT
                i.id, i.client_order_id, i.quantity, i.unit_price, i.unit_cost, i.notes,
                i.source, i.odoo_product_id, i.odoo_company,
                COALESCE(i.product_name, sp.name) AS product_name,
                COALESCE(i.sku, sp.sku)           AS sku,
                COALESCE(i.image_url, sp.image_url) AS image_url,
                CASE WHEN i.source = 'odoo'
                    THEN 'Odoo ' || INITCAP(i.odoo_company)
                    ELSE s.name
                END AS supplier_name,
                sp.source_category
             FROM preventa_client_order_items i
             LEFT JOIN supplier_products sp ON sp.id = i.supplier_product_id
             LEFT JOIN suppliers s ON s.id = sp.supplier_id
             WHERE i.client_order_id = $1
             ORDER BY i.id`,
            [req.params.id]
        );

        ok(res, { ...orders[0], items });
    } catch (err) {
        console.error('❌ Error al obtener pedido:', err.message);
        fail(res, err.message, 500);
    }
});

// PUT /api/preventas/client-orders/:id — actualizar status/notas
router.put('/client-orders/:id', authenticate, async (req, res) => {
    const { status, client_notes } = req.body;
    const updates = [];
    const params = [];

    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (client_notes !== undefined) { params.push(client_notes); updates.push(`notes = $${params.length}`); }
    if (!updates.length) return fail(res, 'Nada para actualizar');

    params.push(req.params.id);
    try {
        const { rows } = await pool.query(
            `UPDATE preventa_client_orders SET ${updates.join(', ')}, updated_at = NOW()
             WHERE id = $${params.length} RETURNING *`,
            params
        );
        if (!rows.length) return fail(res, 'Pedido no encontrado', 404);
        ok(res, rows[0]);
    } catch (err) {
        console.error('❌ Error al actualizar pedido:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/client-orders/:id/items — agregar item
// Acepta supplier_products: { supplierProductId, quantity }
// O productos Odoo:         { odooProductId, odooCompany, quantity }
router.post('/client-orders/:id/items', authenticate, async (req, res) => {
    const { supplierProductId, odooProductId, odooCompany, quantity = 1, unit_price } = req.body;

    if (!supplierProductId && !odooProductId) {
        return fail(res, 'supplierProductId u odooProductId es requerido');
    }

    try {
        const orderId = parseInt(req.params.id);

        // Obtener pricelist_id del pedido (si tiene uno asignado)
        const { rows: orderRows } = await pool.query(
            'SELECT pricelist_id FROM preventa_client_orders WHERE id = $1',
            [orderId]
        );
        const pricelistId = orderRows[0]?.pricelist_id || null;

        let item;
        if (supplierProductId) {
            item = await addItemToOrder(orderId, parseInt(supplierProductId), parseInt(quantity), pricelistId);
        } else {
            if (!odooCompany || !['neggo', 'preventas'].includes(odooCompany)) {
                return fail(res, 'odooCompany debe ser "neggo" o "preventas"');
            }
            const priceOverride = unit_price != null ? parseFloat(unit_price) : undefined;
            item = await addOdooItemToOrder(orderId, parseInt(odooProductId), odooCompany, parseInt(quantity), priceOverride, pricelistId);
        }

        // Sync a Odoo si ya está en cotización
        const { rows: st } = await pool.query(
            'SELECT status FROM preventa_client_orders WHERE id = $1', [orderId]
        );
        if (st[0]?.status === 'cotizacion') {
            syncLinesToOdoo(orderId).catch(e => console.error('⚠️ Sync Odoo tras agregar ítem:', e.message));
        }

        ok(res, item, 201);
    } catch (err) {
        console.error('❌ Error al agregar item:', err.message);
        fail(res, err.message, 500);
    }
});

// DELETE /api/preventas/client-orders/:id — eliminar pedido y cancelar órdenes en Odoo
router.delete('/client-orders/:id', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT odoo_sale_order_id, neggo_sale_order_id FROM preventa_client_orders WHERE id = $1',
            [req.params.id]
        );
        if (!rows.length) return fail(res, 'Pedido no encontrado', 404);

        const { odoo_sale_order_id, neggo_sale_order_id } = rows[0];
        const odooService = require('../services/odooService');

        if (neggo_sale_order_id) {
            try {
                await odooService.cancelSaleOrder(neggo_sale_order_id, 'neggo');
                console.log(`✅ Pedido ${req.params.id} — orden Neggo ${neggo_sale_order_id} cancelada`);
            } catch (err) {
                console.error(`❌ No se pudo cancelar en Odoo Neggo:`, err.message);
                return fail(res, `No se pudo cancelar en Odoo Neggo: ${err.message}`, 500);
            }
        }

        if (odoo_sale_order_id) {
            try {
                await odooService.cancelSaleOrder(odoo_sale_order_id, 'preventas');
                console.log(`✅ Pedido ${req.params.id} — orden Preventas ${odoo_sale_order_id} cancelada`);
            } catch (err) {
                console.error(`❌ No se pudo cancelar en Odoo Preventas:`, err.message);
                return fail(res, `No se pudo cancelar en Odoo Preventas: ${err.message}`, 500);
            }
        }

        await pool.query('DELETE FROM preventa_client_order_items WHERE client_order_id = $1', [req.params.id]);
        await pool.query('DELETE FROM preventa_client_orders WHERE id = $1', [req.params.id]);
        console.log(`✅ Pedido ${req.params.id} eliminado`);
        ok(res, { deleted: true });
    } catch (err) {
        console.error('❌ Error al eliminar pedido:', err.message);
        fail(res, err.message, 500);
    }
});

// DELETE /api/preventas/client-orders/:id/items/:itemId — quitar item
router.delete('/client-orders/:id/items/:itemId', authenticate, async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM preventa_client_order_items
             WHERE id = $1 AND client_order_id = $2`,
            [req.params.itemId, req.params.id]
        );
        if (!rowCount) return fail(res, 'Item no encontrado', 404);

        // Sync a Odoo si ya está en cotización
        const orderId = parseInt(req.params.id);
        const { rows: st } = await pool.query(
            'SELECT status FROM preventa_client_orders WHERE id = $1', [orderId]
        );
        if (st[0]?.status === 'cotizacion') {
            syncLinesToOdoo(orderId).catch(e => console.error('⚠️ Sync Odoo tras quitar ítem:', e.message));
        }

        ok(res, { deleted: true });
    } catch (err) {
        console.error('❌ Error al eliminar item:', err.message);
        fail(res, err.message, 500);
    }
});

// PUT /api/preventas/client-orders/:id/items/:itemId — actualizar cantidad
router.put('/client-orders/:id/items/:itemId', authenticate, async (req, res) => {
    const { quantity } = req.body;
    const qty = parseInt(quantity);
    if (!qty || qty < 1) return fail(res, 'Cantidad inválida');

    const orderId = parseInt(req.params.id);
    try {
        const { rows } = await pool.query(
            `UPDATE preventa_client_order_items SET quantity = $1
             WHERE id = $2 AND client_order_id = $3 RETURNING *`,
            [qty, req.params.itemId, orderId]
        );
        if (!rows.length) return fail(res, 'Ítem no encontrado', 404);

        await pool.query(
            `UPDATE preventa_client_orders
             SET total_estimated = (
                 SELECT COALESCE(SUM(unit_price * quantity), 0)
                 FROM preventa_client_order_items WHERE client_order_id = $1
             ), updated_at = NOW() WHERE id = $1`,
            [orderId]
        );

        const { rows: st } = await pool.query(
            'SELECT status FROM preventa_client_orders WHERE id = $1', [orderId]
        );
        if (st[0]?.status === 'cotizacion') {
            syncLinesToOdoo(orderId).catch(e => console.error('⚠️ Sync Odoo tras cambiar cantidad:', e.message));
        }

        ok(res, rows[0]);
    } catch (err) {
        console.error('❌ Error al actualizar cantidad:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/client-orders/:id/confirm — confirma las órdenes en Odoo
router.post('/client-orders/:id/confirm', authenticate, async (req, res) => {
    const orderId = parseInt(req.params.id);
    try {
        const { rows } = await pool.query(
            'SELECT * FROM preventa_client_orders WHERE id = $1', [orderId]
        );
        if (!rows.length) return fail(res, 'Pedido no encontrado', 404);
        const order = rows[0];

        if (order.status === 'confirmado') return fail(res, 'El pedido ya está confirmado');
        if (order.status === 'pendiente')  return fail(res, 'Enviá el pedido a Odoo antes de confirmar');

        const odooService = require('../services/odooService');

        if (order.odoo_sale_order_id) {
            await odooService.confirmSaleOrder(order.odoo_sale_order_id, 'preventas');
        }
        if (order.neggo_sale_order_id) {
            await odooService.confirmSaleOrder(order.neggo_sale_order_id, 'neggo');
        }

        await pool.query(
            `UPDATE preventa_client_orders SET status = 'confirmado', updated_at = NOW() WHERE id = $1`,
            [orderId]
        );

        const parts = [
            order.odoo_sale_order_name,
            order.neggo_sale_order_name,
        ].filter(Boolean).join(' · ');
        console.log(`✅ Pedido ${orderId} confirmado en Odoo: ${parts}`);
        ok(res, { status: 'confirmado' });
    } catch (err) {
        console.error('❌ Error al confirmar pedido:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/client-orders/:id/send-to-odoo
// Crea una sale.order por empresa según los ítems: Neggo para ítems de Neggo,
// Preventas para ítems de Preventas. Usa ensurePartner para crear el cliente
// en la empresa destino si todavía no existe ahí.
// Body opcional: { partner_id } cuando el pedido no tiene odoo_partner_id.
router.post('/client-orders/:id/send-to-odoo', authenticate, async (req, res) => {
    const orderId = parseInt(req.params.id);
    try {
        const { rows: orders } = await pool.query(
            'SELECT * FROM preventa_client_orders WHERE id = $1',
            [orderId]
        );
        if (!orders.length) return fail(res, 'Pedido no encontrado', 404);

        const order = orders[0];

        if (order.odoo_sale_order_id && order.neggo_sale_order_id) {
            return fail(res, 'El pedido ya fue enviado a Odoo en ambas empresas');
        }

        const partnerId = order.odoo_partner_id || parseInt(req.body.partner_id);
        if (!partnerId) return fail(res, 'Seleccioná un cliente de Odoo antes de enviar');

        if (!order.odoo_partner_id) {
            await pool.query(
                'UPDATE preventa_client_orders SET odoo_partner_id = $1, updated_at = NOW() WHERE id = $2',
                [partnerId, orderId]
            );
        }

        const { rows: items } = await pool.query(
            'SELECT * FROM preventa_client_order_items WHERE client_order_id = $1 ORDER BY id',
            [orderId]
        );
        if (!items.length) return fail(res, 'El pedido no tiene ítems');

        const odooService = require('../services/odooService');
        const result = {};

        // — Ítems de Neggo —
        if (!order.neggo_sale_order_id) {
            const neggoItems = items.filter(i => i.odoo_company === 'neggo');
            if (neggoItems.length) {
                const pid = await odooService.ensurePartner(partnerId, order.client_name, 'neggo');
                const lines = neggoItems.map(i => ({
                    product_id: i.odoo_product_id || false,
                    name:       i.sku ? `[${i.sku}] ${i.product_name}` : i.product_name,
                    quantity:   i.quantity,
                    unit_price: parseFloat(i.unit_price || 0),
                }));
                result.neggo = await odooService.createSaleOrder(pid, lines, 'neggo');
                console.log(`✅ Pedido ${orderId} → Odoo Neggo ${result.neggo.name}`);
            }
        }

        // — Ítems de Preventas (y fallback supplier sin empresa asignada) —
        if (!order.odoo_sale_order_id) {
            const preventasItems = items.filter(i => i.odoo_company === 'preventas' || !i.odoo_company);
            if (preventasItems.length) {
                const pid = await odooService.ensurePartner(partnerId, order.client_name, 'preventas');
                const lines = preventasItems.map(i => ({
                    product_id: i.odoo_product_id || false,
                    name:       i.sku ? `[${i.sku}] ${i.product_name}` : i.product_name,
                    quantity:   i.quantity,
                    unit_price: parseFloat(i.unit_price || 0),
                }));
                result.preventas = await odooService.createSaleOrder(pid, lines, 'preventas');
                console.log(`✅ Pedido ${orderId} → Odoo Preventas ${result.preventas.name}`);
            }
        }

        if (!result.neggo && !result.preventas) {
            return fail(res, 'No hay ítems pendientes de enviar a Odoo');
        }

        const setClauses = ["status = 'cotizacion'", 'updated_at = NOW()'];
        const params = [];

        if (result.preventas) {
            params.push(result.preventas.id);   setClauses.push(`odoo_sale_order_id = $${params.length}`);
            params.push(result.preventas.name);  setClauses.push(`odoo_sale_order_name = $${params.length}`);
        }
        if (result.neggo) {
            params.push(result.neggo.id);   setClauses.push(`neggo_sale_order_id = $${params.length}`);
            params.push(result.neggo.name);  setClauses.push(`neggo_sale_order_name = $${params.length}`);
        }
        params.push(orderId);
        await pool.query(
            `UPDATE preventa_client_orders SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
            params
        );

        ok(res, {
            preventas: result.preventas ? { id: result.preventas.id, name: result.preventas.name } : null,
            neggo:     result.neggo     ? { id: result.neggo.id,     name: result.neggo.name     } : null,
        });
    } catch (err) {
        console.error('❌ Error al enviar pedido a Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// =============================================
// GENERACIÓN Y GESTIÓN DE ÓRDENES A PROVEEDORES
// =============================================

// POST /api/preventas/generate-supplier-orders
router.post('/generate-supplier-orders', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const { clientOrderIds } = req.body;
    if (!clientOrderIds?.length) return fail(res, 'clientOrderIds es requerido');
    try {
        const result = await generateSupplierOrders(clientOrderIds, req.user.id);
        console.log(`✅ ${result.length} órdenes a proveedores generadas`);
        ok(res, result, 201);
    } catch (err) {
        console.error('❌ Error al generar órdenes:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/supplier-orders — lista
router.get('/supplier-orders', authenticate, async (req, res) => {
    const { supplierId, status, limit = 20, offset = 0 } = req.query;
    try {
        const conditions = [];
        const params = [];

        if (supplierId) { params.push(supplierId); conditions.push(`so.supplier_id = $${params.length}`); }
        if (status) { params.push(status); conditions.push(`so.status = $${params.length}`); }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM preventa_supplier_orders so ${where}`, params
        );

        params.push(parseInt(limit), parseInt(offset));
        const { rows } = await pool.query(
            `SELECT so.*, s.name as supplier_name,
                    COUNT(i.id) as item_count
             FROM preventa_supplier_orders so
             JOIN suppliers s ON s.id = so.supplier_id
             LEFT JOIN preventa_supplier_order_items i ON i.supplier_order_id = so.id
             ${where}
             GROUP BY so.id, s.name
             ORDER BY so.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        paginated(res, rows, countResult.rows[0].count, limit, offset);
    } catch (err) {
        console.error('❌ Error al listar órdenes:', err.message);
        fail(res, err.message, 500);
    }
});

// PUT /api/preventas/supplier-orders/:id — actualizar status
router.put('/supplier-orders/:id', authenticate, requireRole('admin', 'operador'), async (req, res) => {
    const { status } = req.body;
    if (!status) return fail(res, 'status es requerido');
    try {
        const { rows } = await pool.query(
            `UPDATE preventa_supplier_orders SET status = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [status, req.params.id]
        );
        if (!rows.length) return fail(res, 'Orden no encontrada', 404);
        ok(res, rows[0]);
    } catch (err) {
        console.error('❌ Error al actualizar orden:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/supplier-orders/:id/send-to-odoo
router.post('/supplier-orders/:id/send-to-odoo', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const result = await sendOrderToOdoo(parseInt(req.params.id));
        console.log(`✅ Orden ${req.params.id} enviada a Odoo: ${result.odooPurchaseOrderName}`);
        ok(res, result);
    } catch (err) {
        console.error('❌ Error al enviar a Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/supplier-orders/:id/pdf — genera PDF para entregar al proveedor
router.get('/supplier-orders/:id/pdf', authenticate, async (req, res) => {
    const PDFDocument = require('pdfkit');
    try {
        const { rows: orders } = await pool.query(
            `SELECT so.*, s.name as supplier_name
             FROM preventa_supplier_orders so
             JOIN suppliers s ON s.id = so.supplier_id
             WHERE so.id = $1`,
            [req.params.id]
        );
        if (!orders.length) return fail(res, 'Orden no encontrada', 404);
        const order = orders[0];

        const { rows: items } = await pool.query(
            // Un mismo producto pedido por varios clientes va en una sola línea con la cantidad sumada
            `SELECT MIN(product_name) AS product_name, SUM(quantity)::int AS quantity, unit_cost,
                    STRING_AGG(notes, ' / ') FILTER (WHERE notes IS NOT NULL AND notes <> '') AS notes
             FROM preventa_supplier_order_items
             WHERE supplier_order_id = $1
             GROUP BY COALESCE(supplier_product_id::text, product_name), unit_cost
             ORDER BY MIN(id)`,
            [req.params.id]
        );

        const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Orden ${order.id} — ${order.supplier_name}`, Author: 'Neggo Mayorista' } });

        const safeName = order.supplier_name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').toLowerCase();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="orden-${safeName}-${order.id}.pdf"`);
        doc.pipe(res);

        // ── Colores
        const NAVY   = '#003366';
        const ORANGE = '#FF6600';
        const GRAY   = '#666666';
        const LIGHT  = '#F5F5F5';
        const BLACK  = '#333333';
        const PAGE_W = 595 - 100; // ancho útil

        // ── Header
        doc.rect(0, 0, 595, 70).fill(NAVY);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20)
           .text('NEGGO MAYORISTA', 50, 20);
        doc.fillColor('#FFFFFF').font('Helvetica').fontSize(9)
           .text('Pergamino, Buenos Aires', 50, 44)
           .text(`Generado: ${new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })}`, 50, 55);

        // ── Info de la orden
        doc.moveDown(3.5);
        const infoY = 90;
        doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(13)
           .text(`ORDEN DE COMPRA #${order.id}`, 50, infoY);

        doc.fillColor(GRAY).font('Helvetica').fontSize(10)
           .text(`Proveedor:`, 50, infoY + 22)
           .text(`Estado:`, 50, infoY + 36)
           .text(`Fecha:`, 50, infoY + 50);

        doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
           .text(order.supplier_name, 130, infoY + 22)
           .text(order.status.charAt(0).toUpperCase() + order.status.slice(1), 130, infoY + 36)
           .text(new Date(order.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }), 130, infoY + 50);

        if (order.notes) {
            doc.fillColor(GRAY).font('Helvetica').fontSize(9)
               .text(`Notas: ${order.notes}`, 50, infoY + 66, { width: PAGE_W });
        }

        // ── Divisor
        const tableY = infoY + (order.notes ? 88 : 76);
        doc.moveTo(50, tableY).lineTo(545, tableY).strokeColor(ORANGE).lineWidth(2).stroke();

        // ── Encabezado de tabla
        const colX   = [50, 260, 340, 420, 480];
        const headY  = tableY + 10;
        doc.rect(50, headY, PAGE_W, 20).fill(NAVY);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
        ['Producto', 'SKU', 'Cantidad', 'P. Unit.', 'Subtotal'].forEach((label, i) => {
            doc.text(label, colX[i] + 4, headY + 5, { width: colX[i + 1] ? colX[i + 1] - colX[i] - 4 : 65, align: i >= 2 ? 'right' : 'left' });
        });

        // ── Filas
        let rowY = headY + 22;
        let total = 0;
        const fmtARS = n => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 }).format(n || 0);

        items.forEach((item, idx) => {
            if (rowY > 750) { doc.addPage(); rowY = 50; }
            const subtotal = (item.unit_cost || 0) * item.quantity;
            total += subtotal;

            if (idx % 2 === 0) doc.rect(50, rowY - 2, PAGE_W, 18).fill(LIGHT);

            doc.fillColor(BLACK).font('Helvetica').fontSize(8.5);
            const skuMatch = item.product_name.match(/^\[([^\]]+)\]/);
            const sku  = skuMatch ? skuMatch[1] : '—';
            const name = skuMatch ? item.product_name.replace(/^\[[^\]]+\]\s*/, '') : item.product_name;

            doc.text(name, colX[0] + 4, rowY, { width: colX[1] - colX[0] - 8, ellipsis: true });
            doc.text(sku,  colX[1] + 4, rowY, { width: colX[2] - colX[1] - 4 });
            doc.fillColor(BLACK).font('Helvetica').fontSize(8.5);
            doc.text(String(item.quantity), colX[2] + 4, rowY, { width: colX[3] - colX[2] - 4, align: 'right' });
            doc.text(item.unit_cost ? fmtARS(item.unit_cost) : '—', colX[3] + 4, rowY, { width: colX[4] - colX[3] - 4, align: 'right' });
            doc.text(fmtARS(subtotal), colX[4] + 4, rowY, { width: 61, align: 'right' });

            rowY += 18;
        });

        // ── Total
        rowY += 6;
        doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#CCCCCC').lineWidth(1).stroke();
        rowY += 8;
        doc.rect(380, rowY - 4, 165, 24).fill(NAVY);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
           .text('TOTAL', 384, rowY + 2)
           .text(fmtARS(total), 384, rowY + 2, { width: 157, align: 'right' });

        // ── Footer
        const footerY = doc.page.height - 40;
        doc.moveTo(50, footerY - 10).lineTo(545, footerY - 10).strokeColor('#CCCCCC').lineWidth(0.5).stroke();
        doc.fillColor(GRAY).font('Helvetica').fontSize(8)
           .text('Neggo Mayorista — Pergamino, Buenos Aires', 50, footerY, { align: 'center', width: PAGE_W });

        doc.end();
    } catch (err) {
        console.error('❌ Error al generar PDF de orden:', err.message);
        if (!res.headersSent) fail(res, err.message, 500);
    }
});

// GET /api/preventas/ingreso-commitments
// Devuelve { [preventas_product_id]: committed_qty } sumando preventa_qty_confirmed
// de todos los ingresos activos, cruzando Neggo ↔ Preventas por internal_ref.
router.get('/ingreso-commitments', authenticate, async (req, res) => {
    try {
        const pool = require('../config/database');
        const { rows } = await pool.query(`
            SELECT
                opc_p.odoo_id            AS preventas_product_id,
                SUM(ii.preventa_qty_confirmed)::int AS committed_qty
            FROM ingreso_items ii
            JOIN odoo_products_cache opc_n
                ON opc_n.odoo_id = ii.odoo_product_id AND opc_n.company = 'neggo'
            JOIN odoo_products_cache opc_p
                ON opc_p.company = 'preventas'
               AND REPLACE(REPLACE(UPPER(COALESCE(opc_p.internal_ref,'')),'-',''),' ','')
                   = CONCAT('PRE',
                       REPLACE(REPLACE(UPPER(COALESCE(opc_n.internal_ref,'')),'-',''),' ',''))
            WHERE ii.preventa_qty_confirmed > 0
              AND ii.estado_item = 'matched'
            GROUP BY opc_p.odoo_id
        `);

        const map = {};
        for (const r of rows) map[r.preventas_product_id] = r.committed_qty;
        ok(res, map);
    } catch (err) {
        console.error('❌ Error en ingreso-commitments:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/odoo-quotations — cotizaciones enviadas de Preventas en Odoo
// (los borradores no se muestran en la pantalla de Cotizaciones)
router.get('/odoo-quotations', authenticate, async (req, res) => {
    try {
        const odooService = require('../services/odooService');
        const quotations  = await odooService.getPreventasQuotations(['sent']);
        console.log(`📋 ${quotations.length} cotizaciones traídas de Odoo Preventas`);
        ok(res, quotations);
    } catch (err) {
        console.error('❌ Error al traer cotizaciones Odoo:', err.message);
        fail(res, err.message, 500);
    }
});

// GET /api/preventas/odoo-quotations/by-supplier
// Agrupa por el proveedor local del mapping. Si no hay mapping, usa vendor_name
// de Odoo. Lo que no resuelve queda en "Sin proveedor".
// Solo cotizaciones enviadas, igual que /odoo-quotations.
router.get('/odoo-quotations/by-supplier', authenticate, async (req, res) => {
    try {
        const odooService = require('../services/odooService');
        const quotations  = await odooService.getPreventasQuotations(['sent']);

        if (quotations.length === 0) return ok(res, []);

        const productIds = [...new Set(
            quotations.flatMap(q => (q.lines || []).map(l => l.product_id).filter(Boolean))
        )];

        const productCacheMap = {};
        const localSupplierByProductId = {};

        if (productIds.length > 0) {
            const { rows } = await pool.query(
                `SELECT
                    opc_p.odoo_id,
                    opc_p.vendor_name,
                    opc_p.standard_price,
                    COALESCE(opc_p.image_url, opc_n.image_url) AS image_url
                 FROM odoo_products_cache opc_p
                 LEFT JOIN odoo_products_cache opc_n
                     ON opc_n.company = 'neggo'
                    AND opc_p.internal_ref IS NOT NULL
                    AND REPLACE(REPLACE(UPPER(COALESCE(opc_p.internal_ref,'')),'-',''),' ','')
                        = CONCAT('PRE', REPLACE(REPLACE(UPPER(COALESCE(opc_n.internal_ref,'')),'-',''),' ',''))
                 WHERE opc_p.odoo_id = ANY($1::int[])
                   AND opc_p.company = 'preventas'`,
                [productIds]
            );
            for (const row of rows) {
                productCacheMap[row.odoo_id] = {
                    vendor_name:    row.vendor_name    || null,
                    image_url:      row.image_url      || null,
                    standard_price: row.standard_price || null,
                };
            }

            // Mapping directo del producto Preventas.
            const { rows: mapped } = await pool.query(
                `SELECT DISTINCT ON (pm.odoo_product_id)
                        pm.odoo_product_id,
                        s.name AS supplier_name
                 FROM product_mappings pm
                 JOIN supplier_products sp ON sp.id = pm.supplier_product_id
                 JOIN suppliers s ON s.id = sp.supplier_id AND s.active = true
                 WHERE pm.active = true
                   AND pm.odoo_company = 'preventas'
                   AND pm.odoo_product_id = ANY($1::int[])
                 ORDER BY pm.odoo_product_id, pm.match_confidence DESC NULLS LAST, pm.id DESC`,
                [productIds]
            );
            for (const row of mapped) {
                localSupplierByProductId[row.odoo_product_id] = row.supplier_name;
            }

            // Respaldo: el mismo artículo mapeado del lado Neggo (referencia PRE + ref).
            const { rows: twins } = await pool.query(
                `SELECT DISTINCT ON (opc_p.odoo_id)
                        opc_p.odoo_id,
                        s.name AS supplier_name
                 FROM odoo_products_cache opc_p
                 JOIN odoo_products_cache opc_n
                     ON opc_n.company = 'neggo'
                    AND opc_p.internal_ref IS NOT NULL
                    AND REPLACE(REPLACE(UPPER(COALESCE(opc_p.internal_ref,'')),'-',''),' ','')
                        = CONCAT('PRE', REPLACE(REPLACE(UPPER(COALESCE(opc_n.internal_ref,'')),'-',''),' ',''))
                 JOIN product_mappings pm
                     ON pm.active = true
                    AND pm.odoo_company = 'neggo'
                    AND pm.odoo_product_id = opc_n.odoo_id
                 JOIN supplier_products sp ON sp.id = pm.supplier_product_id
                 JOIN suppliers s ON s.id = sp.supplier_id AND s.active = true
                 WHERE opc_p.company = 'preventas'
                   AND opc_p.odoo_id = ANY($1::int[])
                 ORDER BY opc_p.odoo_id, pm.match_confidence DESC NULLS LAST, pm.id DESC`,
                [productIds]
            );
            for (const row of twins) {
                if (!localSupplierByProductId[row.odoo_id]) {
                    localSupplierByProductId[row.odoo_id] = row.supplier_name;
                }
            }
        }

        const result = groupQuotationsBySupplier(quotations, productCacheMap, localSupplierByProductId);
        const sin = result.find(s => s.supplier_name === SIN_PROVEEDOR);
        console.log(`📦 Breakdown por proveedor: ${result.length} proveedores, ${quotations.length} cotizaciones, sin proveedor: ${sin ? sin.total_products : 0}`);
        ok(res, result);
    } catch (err) {
        console.error('❌ Error al generar breakdown por proveedor:', err.message);
        fail(res, err.message, 500);
    }
});

// POST /api/preventas/odoo-quotations/pdf
// Genera PDF del pedido a un proveedor vía HTML → Puppeteer → Chrome.
// Las imágenes se incrustan como base64 para que Chrome las renderice aunque el browser corra en otro container.
// Body: { supplier_name, products: [{ product_name, external_id, unit_cost, total_qty, quotations, image_url }], total_cost, total_qty }
router.post('/odoo-quotations/pdf', authenticate, async (req, res) => {
    const puppeteer = require('puppeteer-core');
    const fs        = require('fs');
    const path      = require('path');
    const { supplier_name, products = [], total_cost, total_qty } = req.body;

    if (!supplier_name) return fail(res, 'supplier_name es requerido');

    const STORAGE   = process.env.STORAGE_PATH || '/app/storage';
    const CHROME_WS = process.env.CHROME_WS_ENDPOINT;
    let browser = null;

    try {
        if (!CHROME_WS) throw new Error('CHROME_WS_ENDPOINT no configurado');

        const dateStr = formatFechaAR(new Date());

        // Devuelve una data URL base64 para incrustar la imagen en el HTML.
        // Soporta dos fuentes:
        //   /api/products/odoo-image/:company/:templateId  → llama Odoo directo
        //   /storage/...                                   → lee del filesystem
        const { callOdoo, getCompanyIds } = require('../config/odoo');
        let odooCompanyIds = null;

        const toBase64 = async (imageUrl) => {
            if (!imageUrl) return null;

            // Fuente Odoo
            const odooMatch = imageUrl.match(/\/api\/products\/odoo-image\/(neggo|preventas)\/(\d+)/);
            if (odooMatch) {
                try {
                    if (!odooCompanyIds) odooCompanyIds = await getCompanyIds();
                    const companyId = odooCompanyIds[odooMatch[1]];
                    const data = await callOdoo(
                        'product.template', 'read',
                        [[parseInt(odooMatch[2])]],
                        { fields: ['image_128'], context: { allowed_company_ids: [companyId] } }
                    );
                    const b64 = data?.[0]?.image_128;
                    return b64 ? `data:image/png;base64,${b64}` : null;
                } catch {
                    return null;
                }
            }

            // Fuente filesystem
            if (imageUrl.startsWith('/storage')) {
                const fullPath = path.join(STORAGE, imageUrl.replace('/storage', ''));
                if (!fs.existsSync(fullPath)) return null;
                try {
                    const ext  = path.extname(fullPath).toLowerCase().replace('.', '');
                    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : `image/${ext || 'png'}`;
                    return `data:${mime};base64,${fs.readFileSync(fullPath).toString('base64')}`;
                } catch {
                    return null;
                }
            }

            return null;
        };

        const grandTotal = products.reduce((sum, p) =>
            p.unit_cost != null ? sum + parseFloat(p.unit_cost) * p.total_qty : sum, 0);

        // ── Filas HTML (resuelve imágenes en paralelo antes de construir el HTML)
        const resolvedImgs = await Promise.all(products.map(p => toBase64(p.image_url)));

        const rows = products.map((p, idx) => {
            const subtotal = p.unit_cost != null ? parseFloat(p.unit_cost) * p.total_qty : null;
            const dataSrc  = resolvedImgs[idx];
            const letter   = (p.product_name || '').replace(/[^a-zA-Z]/g, '')[0]?.toUpperCase() || '?';
            const bg       = idx % 2 === 0 ? '#ffffff' : '#f5f3ee';

            const imgCell = dataSrc
                ? `<img src="${dataSrc}" style="width:38px;height:38px;object-fit:cover;border-radius:4px;display:block;">`
                : `<div style="width:38px;height:38px;border-radius:4px;background:#f5f3ee;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#6b6a64;">${letter}</div>`;

            const quotations = (p.quotations || []).map(q => `${q.quotation_name}×${q.qty}`).join('&nbsp;&nbsp;');

            return `<tr style="background:${bg};">
  <td style="padding:7px 6px 7px 8px;width:50px;text-align:center;vertical-align:middle;">${imgCell}</td>
  <td style="padding:7px 6px;vertical-align:middle;max-width:0;">
    <div style="font-weight:600;font-size:8.5pt;color:#1c1c1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.product_name || '—'}</div>
    <div style="font-size:7pt;color:#6b6a64;margin-top:3px;font-family:monospace;">${p.external_id || '—'}</div>
    ${quotations ? `<div style="font-size:6.5pt;color:#9a988f;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${quotations}</div>` : ''}
  </td>
  <td style="padding:7px 8px;width:60px;text-align:right;vertical-align:middle;font-weight:700;font-size:9pt;color:#1c1c1a;font-variant-numeric:tabular-nums;white-space:nowrap;">${formatEntero(p.total_qty)}</td>
  <td style="padding:7px 8px;width:105px;text-align:right;vertical-align:middle;font-size:8pt;color:#6b6a64;font-variant-numeric:tabular-nums;white-space:nowrap;">${formatMoneyAR(p.unit_cost)}</td>
  <td style="padding:7px 8px;width:105px;text-align:right;vertical-align:middle;font-weight:700;font-size:8.5pt;color:#1c1c1a;font-variant-numeric:tabular-nums;white-space:nowrap;">${subtotal != null ? formatMoneyAR(subtotal) : '—'}</td>
</tr>`;
        }).join('\n');

        // ── HTML completo
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 9pt; color: #1c1c1a; background: #fff; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th { background: #1f3a68; color: #fff; font-size: 7.5pt; font-weight: 600; padding: 6px 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  tbody td { border-bottom: 1px solid #e8e3d8; }
  @media print { thead { display: table-header-group; } }
</style>
</head>
<body>

<!-- Header -->
<div style="background:#1f3a68;padding:18px 32px 16px;">
  <div style="font-size:18pt;font-weight:700;color:#fff;letter-spacing:0.3px;">NEGGO MAYORISTA</div>
  <div style="font-size:8pt;color:rgba(255,255,255,0.7);margin-top:5px;">Pergamino, Buenos Aires &nbsp;·&nbsp; Generado: ${dateStr}</div>
</div>

<!-- Proveedor -->
<div style="padding:14px 32px 0;">
  <div style="font-size:14pt;font-weight:700;color:#1c1c1a;letter-spacing:0.2px;">${supplier_name.toUpperCase()}</div>
  <div style="font-size:9.5pt;color:#6b6a64;margin-top:5px;">${products.length} producto${products.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${formatEntero(total_qty || 0)} unidades</div>
</div>
<div style="height:2px;background:#e25a1c;margin:12px 32px 0;"></div>

<!-- Tabla -->
<div style="padding:0 32px;">
  <table>
    <colgroup>
      <col style="width:52px;">
      <col>
      <col style="width:60px;">
      <col style="width:105px;">
      <col style="width:105px;">
    </colgroup>
    <thead>
      <tr>
        <th style="text-align:center;"></th>
        <th style="text-align:left;">Producto</th>
        <th style="text-align:right;">Cant.</th>
        <th style="text-align:right;">P. Unit.</th>
        <th style="text-align:right;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>

<!-- Total -->
<div style="display:flex;justify-content:flex-end;padding:14px 32px 0;">
  <div style="background:#1f3a68;color:#fff;padding:8px 18px;display:flex;gap:28px;align-items:center;border-radius:3px;min-width:200px;justify-content:space-between;">
    <span style="font-size:8pt;letter-spacing:0.05em;">TOTAL</span>
    <span style="font-size:11pt;font-weight:700;font-variant-numeric:tabular-nums;">${formatMoneyAR(total_cost ?? grandTotal)}</span>
  </div>
</div>

<!-- Footer -->
<div style="text-align:center;font-size:7.5pt;color:#9a988f;padding:14px 32px 0;border-top:1px solid #e8e3d8;margin-top:16px;">
  Neggo Mayorista · Pergamino, Buenos Aires
</div>

</body>
</html>`;

        browser = await puppeteer.connect({ browserWSEndpoint: CHROME_WS });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0mm', right: '0mm', bottom: '12mm', left: '0mm' },
        });

        await page.close();
        await browser.disconnect();
        browser = null;

        const safeName = supplier_name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').toLowerCase();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="pedido-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf"`);
        res.end(pdf);

    } catch (err) {
        console.error('❌ Error al generar PDF de pedido:', err.message);
        if (browser) await browser.disconnect().catch(() => {});
        if (!res.headersSent) fail(res, err.message, 500);
    }
});

// GET /api/preventas/shopping-list/:supplierId — listado consolidado
router.get('/shopping-list/:supplierId', authenticate, async (req, res) => {
    try {
        const list = await getShoppingList(parseInt(req.params.supplierId));
        ok(res, list);
    } catch (err) {
        console.error('❌ Error al generar shopping list:', err.message);
        fail(res, err.message, 500);
    }
});

module.exports = router;
