// Servicio de lógica de negocio para el módulo Preventas
// Gestiona pedidos de clientes, órdenes a proveedores y sincronización con Odoo

const pool = require('../config/database');
const { calculatePrices, getCategoryRule } = require('./rulesEngine');
const odooService = require('./odooService');
const { resolveDescuento, calculateSpecialPrice } = require('./pricelistService');

// =============================================
// PEDIDOS DE CLIENTES
// =============================================

/**
 * Agrega un ítem a un pedido de cliente.
 * Busca el supplier_product, obtiene la regla de categoría si existe,
 * calcula precio y costo con rulesEngine para empresa 'preventas',
 * y persiste el ítem.
 *
 * @param {number} orderId — ID del pedido de cliente
 * @param {number} supplierProductId — ID del supplier_product
 * @param {number} quantity — cantidad
 * @returns {Promise<object>} ítem creado con precios calculados
 */
async function addItemToOrder(orderId, supplierProductId, quantity, pricelistId = null) {
    // Verificar que el pedido existe
    const orderCheck = await pool.query(
        'SELECT id, status FROM preventa_client_orders WHERE id = $1',
        [orderId]
    );
    if (orderCheck.rows.length === 0) {
        throw new Error(`Pedido ${orderId} no encontrado`);
    }
    if (orderCheck.rows[0].status === 'cancelado') {
        throw new Error(`No se puede agregar ítems a un pedido cancelado`);
    }

    // Obtener el producto con datos del proveedor
    const productResult = await pool.query(
        `SELECT sp.id, sp.name, sp.sku, sp.raw_price, sp.image_url,
                sp.source_category, sp.supplier_id,
                s.id as supplier_id, s.name as supplier_name,
                s.default_discount, s.markup_preventas
         FROM supplier_products sp
         JOIN suppliers s ON s.id = sp.supplier_id
         WHERE sp.id = $1 AND sp.available = true`,
        [supplierProductId]
    );

    if (productResult.rows.length === 0) {
        throw new Error(`Producto ${supplierProductId} no encontrado o no disponible`);
    }

    const product = productResult.rows[0];

    let unitPrice, unitCost;

    if (pricelistId && product.raw_price) {
        // Precio especial: raw_price × (1 - descuento_lista%)
        const descuento = await resolveDescuento(pricelistId, product.supplier_id);
        unitPrice = calculateSpecialPrice(parseFloat(product.raw_price), descuento);

        // Costo sigue siendo el normal (raw_price con descuento del proveedor)
        const categoryRule = await getCategoryRule(pool, product.supplier_id, product.source_category, 'preventas');
        const supplier = {
            default_discount: product.default_discount,
            markup_preventas: product.markup_preventas
        };
        const prices = calculatePrices(product, supplier, categoryRule, 'preventas');
        unitCost = Number.isFinite(prices.cost) ? prices.cost : null;
    } else {
        // Precio estándar usando rulesEngine
        const categoryRule = await getCategoryRule(pool, product.supplier_id, product.source_category, 'preventas');
        const supplier = {
            default_discount: product.default_discount,
            markup_preventas: product.markup_preventas
        };
        const prices = calculatePrices(product, supplier, categoryRule, 'preventas');
        unitPrice = Number.isFinite(prices.sale_price) ? prices.sale_price : null;
        unitCost  = Number.isFinite(prices.cost)       ? prices.cost       : null;
    }

    // UPSERT: si el producto ya está en el pedido, sumar cantidad; si no, insertar
    const existing = await pool.query(
        `SELECT id, quantity FROM preventa_client_order_items
         WHERE client_order_id = $1 AND supplier_product_id = $2 LIMIT 1`,
        [orderId, supplierProductId]
    );

    let itemResult;
    if (existing.rows.length > 0) {
        const newQty = existing.rows[0].quantity + quantity;
        itemResult = await pool.query(
            `UPDATE preventa_client_order_items
             SET quantity = $1, unit_price = $2, unit_cost = $3
             WHERE id = $4 RETURNING *`,
            [newQty, unitPrice, unitCost, existing.rows[0].id]
        );
    } else {
        itemResult = await pool.query(
            `INSERT INTO preventa_client_order_items
                (client_order_id, supplier_product_id, product_name, quantity, unit_price, unit_cost, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [orderId, supplierProductId, product.name, quantity, unitPrice, unitCost, product.image_url || null]
        );
    }

    // Recalcular total estimado del pedido
    await _recalcOrderTotal(orderId);

    console.log(`✅ Ítem ${existing.rows.length ? 'actualizado' : 'agregado'} al pedido ${orderId}: ${product.name} x${itemResult.rows[0].quantity} — precio: $${unitPrice}${pricelistId ? ' (precio especial)' : ''}`);

    return {
        ...itemResult.rows[0],
        prices
    };
}

/**
 * Recalcula y actualiza el total estimado de un pedido de cliente.
 * @param {number} orderId
 */
async function _recalcOrderTotal(orderId) {
    await pool.query(
        `UPDATE preventa_client_orders
         SET total_estimated = (
             SELECT COALESCE(SUM(unit_price * quantity), 0)
             FROM preventa_client_order_items
             WHERE client_order_id = $1
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [orderId]
    );
}

/**
 * Agrega un ítem de producto Odoo (del cache) a un pedido de cliente.
 *
 * @param {number} orderId
 * @param {number} odooProductId — odoo_id del producto en el cache
 * @param {string} odooCompany — 'neggo' | 'preventas'
 * @param {number} quantity
 * @returns {Promise<object>} ítem creado
 */
async function addOdooItemToOrder(orderId, odooProductId, odooCompany, quantity, unitPriceOverride, pricelistId = null) {
    const orderCheck = await pool.query(
        'SELECT id, status FROM preventa_client_orders WHERE id = $1',
        [orderId]
    );
    if (orderCheck.rows.length === 0) throw new Error(`Pedido ${orderId} no encontrado`);
    if (orderCheck.rows[0].status === 'cancelado') throw new Error(`No se puede agregar ítems a un pedido cancelado`);

    const { rows } = await pool.query(
        `SELECT odoo_id, name, internal_ref, list_price, standard_price, image_url
         FROM odoo_products_cache
         WHERE odoo_id = $1 AND company = $2 AND active = true`,
        [odooProductId, odooCompany]
    );

    if (rows.length === 0) {
        throw new Error(`Producto Odoo ${odooProductId} (${odooCompany}) no encontrado en cache`);
    }

    const product = rows[0];
    let unitPrice;

    // Si hay pricelist y no hay override manual, intentar calcular desde raw_price via mapping
    if (pricelistId && unitPriceOverride == null) {
        const { rows: mappings } = await pool.query(
            `SELECT sp.raw_price, sp.supplier_id
             FROM product_mappings pm
             JOIN supplier_products sp ON sp.id = pm.supplier_product_id
             WHERE pm.odoo_product_id = $1 AND pm.odoo_company = $2 AND pm.active = true
             ORDER BY pm.match_confidence DESC
             LIMIT 1`,
            [odooProductId, odooCompany]
        );
        if (mappings.length > 0 && mappings[0].raw_price) {
            const descuento = await resolveDescuento(pricelistId, mappings[0].supplier_id);
            unitPrice = calculateSpecialPrice(parseFloat(mappings[0].raw_price), descuento);
        } else {
            // Sin mapping: usar list_price de Odoo como base
            unitPrice = product.list_price ? parseFloat(product.list_price) : null;
        }
    } else {
        unitPrice = unitPriceOverride != null
            ? unitPriceOverride
            : (product.list_price ? parseFloat(product.list_price) : null);
    }

    const unitCost = product.standard_price ? parseFloat(product.standard_price) : null;

    // UPSERT: si el mismo producto Odoo ya está en el pedido, sumar cantidad
    const existing = await pool.query(
        `SELECT id, quantity FROM preventa_client_order_items
         WHERE client_order_id = $1 AND odoo_product_id = $2 AND odoo_company = $3 LIMIT 1`,
        [orderId, odooProductId, odooCompany]
    );

    let itemResult;
    if (existing.rows.length > 0) {
        const newQty = existing.rows[0].quantity + quantity;
        itemResult = await pool.query(
            `UPDATE preventa_client_order_items
             SET quantity = $1, unit_price = $2, unit_cost = $3
             WHERE id = $4 RETURNING *`,
            [newQty, unitPrice, unitCost, existing.rows[0].id]
        );
    } else {
        itemResult = await pool.query(
            `INSERT INTO preventa_client_order_items
                (client_order_id, odoo_product_id, odoo_company, product_name, sku,
                 quantity, unit_price, unit_cost, image_url, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'odoo')
             RETURNING *`,
            [orderId, odooProductId, odooCompany, product.name, product.internal_ref || null,
             quantity, unitPrice, unitCost, product.image_url || null]
        );
    }

    await _recalcOrderTotal(orderId);

    console.log(`✅ Ítem Odoo ${existing.rows.length ? 'actualizado' : 'agregado'} al pedido ${orderId}: ${product.name} x${itemResult.rows[0].quantity} — precio: $${unitPrice}`);
    return itemResult.rows[0];
}

// =============================================
// GENERACIÓN DE ÓRDENES A PROVEEDORES
// =============================================

/**
 * Agrupa ítems de pedidos de clientes seleccionados por proveedor
 * y crea preventa_supplier_orders para cada uno.
 * Usa transacción SQL para atomicidad completa.
 *
 * @param {number[]} clientOrderIds — IDs de pedidos de cliente a consolidar
 * @param {number} createdBy — ID del usuario que genera las órdenes
 * @returns {Promise<Array<{ supplierId, supplierName, itemCount, totalAmount, orderId }>>}
 */
async function generateSupplierOrders(clientOrderIds, createdBy) {
    if (!clientOrderIds || clientOrderIds.length === 0) {
        throw new Error('Se requiere al menos un pedido de cliente');
    }

    // Solo procesa ítems de supplier_products (los ítems Odoo no generan orden de compra)
    const itemsResult = await pool.query(
        `SELECT
            pcoi.id as item_id,
            pcoi.client_order_id,
            pcoi.supplier_product_id,
            pcoi.product_name,
            pcoi.quantity,
            pcoi.unit_price,
            pcoi.unit_cost,
            sp.supplier_id,
            s.name as supplier_name
         FROM preventa_client_order_items pcoi
         JOIN supplier_products sp ON sp.id = pcoi.supplier_product_id
         JOIN suppliers s ON s.id = sp.supplier_id
         WHERE pcoi.client_order_id = ANY($1::int[])
           AND pcoi.supplier_product_id IS NOT NULL
         ORDER BY sp.supplier_id`,
        [clientOrderIds]
    );

    if (itemsResult.rows.length === 0) {
        throw new Error('Los pedidos seleccionados no tienen ítems');
    }

    // Agrupar ítems por proveedor
    const bySupplier = {};
    for (const item of itemsResult.rows) {
        if (!bySupplier[item.supplier_id]) {
            bySupplier[item.supplier_id] = {
                supplierId: item.supplier_id,
                supplierName: item.supplier_name,
                items: []
            };
        }
        bySupplier[item.supplier_id].items.push(item);
    }

    const client = await pool.connect();
    const createdOrders = [];

    try {
        await client.query('BEGIN');

        for (const supplierData of Object.values(bySupplier)) {
            const { supplierId, supplierName, items } = supplierData;

            // Calcular total de costo para esta orden de proveedor
            const totalAmount = items.reduce(
                (sum, item) => sum + (parseFloat(item.unit_cost) * item.quantity),
                0
            );

            // Crear la orden de proveedor
            const orderResult = await client.query(
                `INSERT INTO preventa_supplier_orders
                    (supplier_id, status, total_estimated, created_by)
                 VALUES ($1, 'borrador', $2, $3)
                 RETURNING id`,
                [supplierId, Math.round(totalAmount * 100) / 100, createdBy]
            );

            const supplierOrderId = orderResult.rows[0].id;

            // Insertar cada ítem en la orden de proveedor
            for (const item of items) {
                await client.query(
                    `INSERT INTO preventa_supplier_order_items
                        (supplier_order_id, supplier_product_id, client_order_item_id,
                         product_name, quantity, unit_cost)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        supplierOrderId,
                        item.supplier_product_id,
                        item.item_id,
                        item.product_name,
                        item.quantity,
                        item.unit_cost
                    ]
                );
            }

            createdOrders.push({
                supplierId,
                supplierName,
                itemCount: items.length,
                totalAmount: Math.round(totalAmount * 100) / 100,
                orderId: supplierOrderId
            });

            console.log(`📦 Orden de proveedor creada — ${supplierName} (id: ${supplierOrderId}), ${items.length} ítems, total: $${Math.round(totalAmount)}`);
        }

        await client.query('COMMIT');
        console.log(`✅ Generadas ${createdOrders.length} órdenes de proveedor desde ${clientOrderIds.length} pedidos de cliente`);

        return createdOrders;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error al generar órdenes de proveedor — ROLLBACK ejecutado:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// =============================================
// SINCRONIZACIÓN CON ODOO
// =============================================

/**
 * Envía una orden de proveedor a Odoo como purchase.order.
 * Busca el partner del proveedor en Odoo por nombre.
 * Actualiza la BD con el ID de la OC creada en Odoo.
 *
 * @param {number} supplierOrderId — ID de preventa_supplier_orders
 * @returns {Promise<{ odooOrderId: number, supplierOrderId: number }>}
 */
async function sendOrderToOdoo(supplierOrderId) {
    // Obtener la orden con datos del proveedor
    const orderResult = await pool.query(
        `SELECT pso.id, pso.supplier_id, pso.status, pso.odoo_purchase_order_id,
                s.name as supplier_name
         FROM preventa_supplier_orders pso
         JOIN suppliers s ON s.id = pso.supplier_id
         WHERE pso.id = $1`,
        [supplierOrderId]
    );

    if (orderResult.rows.length === 0) {
        throw new Error(`Orden de proveedor ${supplierOrderId} no encontrada`);
    }

    const order = orderResult.rows[0];

    if (order.status === 'cancelado') {
        throw new Error(`La orden ${supplierOrderId} está cancelada, no se puede enviar a Odoo`);
    }

    if (order.odoo_purchase_order_id) {
        throw new Error(`La orden ${supplierOrderId} ya fue enviada a Odoo (OC #${order.odoo_purchase_order_id})`);
    }

    // Obtener ítems de la orden
    const itemsResult = await pool.query(
        `SELECT psoi.supplier_product_id, psoi.product_name,
                psoi.quantity, psoi.unit_cost,
                sp.sku
         FROM preventa_supplier_order_items psoi
         JOIN supplier_products sp ON sp.id = psoi.supplier_product_id
         WHERE psoi.supplier_order_id = $1`,
        [supplierOrderId]
    );

    if (itemsResult.rows.length === 0) {
        throw new Error(`La orden ${supplierOrderId} no tiene ítems`);
    }

    // Buscar el partner del proveedor en Odoo por nombre
    console.log(`📦 Buscando partner en Odoo para proveedor: "${order.supplier_name}"`);
    const partners = await odooService.getPartners({ type: 'supplier', search: order.supplier_name });

    if (partners.length === 0) {
        const errMsg = `❌ Partner no encontrado en Odoo para proveedor "${order.supplier_name}". Crear el proveedor en Odoo antes de enviar la orden.`;
        console.error(errMsg);
        throw new Error(`Partner "${order.supplier_name}" no encontrado en Odoo. Verificar que el proveedor existe como partner en la empresa Preventas.`);
    }

    // Tomar el primer match (más relevante por el search ilike)
    const partner = partners[0];
    console.log(`✅ Partner encontrado en Odoo: ${partner.name} (id: ${partner.id})`);

    // Construir líneas para Odoo
    // Nota: product_id puede ser null si no hay mapping — Odoo acepta líneas sin producto con nombre descriptivo
    const orderLines = itemsResult.rows.map(item => ({
        product_id: false,           // sin mapping directo de producto
        name: item.sku
            ? `[${item.sku}] ${item.product_name}`
            : item.product_name,
        quantity: item.quantity,
        unit_price: parseFloat(item.unit_cost)
    }));

    // Crear la purchase.order en Odoo empresa Preventas
    const odooOrderId = await odooService.createPurchaseOrder(partner.id, orderLines, 'preventas');

    // Persistir el ID de Odoo en la BD y cambiar estado
    await pool.query(
        `UPDATE preventa_supplier_orders
         SET odoo_purchase_order_id = $1,
             status = 'enviado',
             updated_at = NOW()
         WHERE id = $2`,
        [odooOrderId, supplierOrderId]
    );

    console.log(`✅ Orden ${supplierOrderId} enviada a Odoo — OC ID: ${odooOrderId}, proveedor: ${order.supplier_name}`);

    return { odooOrderId, supplierOrderId };
}

// =============================================
// SHOPPING LIST (lista de compras consolidada)
// =============================================

/**
 * Retorna la lista consolidada de ítems pendientes de compra para un proveedor.
 * Agrupa por producto sumando cantidades de todos los pedidos activos.
 *
 * @param {number} supplierId — ID del proveedor
 * @returns {Promise<Array>}
 */
async function getShoppingList(supplierId) {
    // Verificar que el proveedor existe
    const supplierCheck = await pool.query(
        'SELECT id, name FROM suppliers WHERE id = $1',
        [supplierId]
    );
    if (supplierCheck.rows.length === 0) {
        throw new Error(`Proveedor ${supplierId} no encontrado`);
    }

    // Consolidar ítems de órdenes de proveedor en estado borrador/enviado
    // agrupando por producto para mostrar cantidad total a pedir
    const result = await pool.query(
        `SELECT
            sp.id as supplier_product_id,
            sp.sku,
            sp.name as product_name,
            sp.raw_price,
            sp.image_url,
            sp.source_category,
            SUM(psoi.quantity) as total_quantity,
            MIN(psoi.unit_cost) as unit_cost,
            COUNT(DISTINCT psoi.supplier_order_id) as order_count
         FROM preventa_supplier_order_items psoi
         JOIN preventa_supplier_orders pso ON pso.id = psoi.supplier_order_id
         JOIN supplier_products sp ON sp.id = psoi.supplier_product_id
         WHERE pso.supplier_id = $1
           AND pso.status IN ('borrador', 'enviado')
         GROUP BY sp.id, sp.sku, sp.name, sp.raw_price, sp.image_url, sp.source_category
         ORDER BY sp.name ASC`,
        [supplierId]
    );

    const supplier = supplierCheck.rows[0];
    const totalCost = result.rows.reduce(
        (sum, item) => sum + (parseFloat(item.unit_cost) * parseInt(item.total_quantity)),
        0
    );

    console.log(`📦 Shopping list para ${supplier.name}: ${result.rows.length} productos, total estimado: $${Math.round(totalCost)}`);

    return {
        supplier: { id: supplier.id, name: supplier.name },
        items: result.rows,
        totalItems: result.rows.length,
        totalCost: Math.round(totalCost * 100) / 100
    };
}

module.exports = {
    addItemToOrder,
    addOdooItemToOrder,
    generateSupplierOrders,
    sendOrderToOdoo,
    getShoppingList
};
