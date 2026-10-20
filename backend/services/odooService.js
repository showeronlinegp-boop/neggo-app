// Servicio de integración con Odoo 19
// Cubre productos, partners, órdenes de compra y cotizaciones de venta

const { callOdoo, getCompanyIds } = require('../config/odoo');

// =============================================
// Helpers internos
// =============================================

/**
 * Resuelve companyKey ('neggo' | 'preventas') al ID numérico de Odoo.
 * Lanza error claro si la clave no existe en el cache.
 *
 * @param {string} companyKey
 * @returns {Promise<number>}
 */
async function resolveCompanyId(companyKey) {
    const ids = await getCompanyIds();
    const id = ids[companyKey];
    if (!id) {
        throw new Error(`Company key inválida o no encontrada en Odoo: "${companyKey}"`);
    }
    return id;
}

/**
 * Construye el kwargs con context multi-empresa para Odoo.
 *
 * @param {number} companyId
 * @param {object} [extraKwargs={}]
 * @returns {object}
 */
function withCompany(companyId, extraKwargs = {}) {
    return {
        ...extraKwargs,
        context: {
            ...(extraKwargs.context || {}),
            allowed_company_ids: [companyId]
        }
    };
}

// =============================================
// PRODUCTOS
// =============================================

/**
 * Trae productos de Odoo paginados, filtrados por empresa.
 * Soporta búsqueda por nombre/referencia interna y por categoría.
 *
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @param {object} opts
 * @param {number} [opts.offset=0]
 * @param {number} [opts.limit=100]
 * @param {string} [opts.search=''] — filtra por name o default_code
 * @param {number|null} [opts.category=null] — ID de categ_id
 * @returns {Promise<Array>}
 */
async function getProducts(companyKey, { offset = 0, limit = 100, search = '', category = null } = {}) {
    const companyId = await resolveCompanyId(companyKey);

    const domain = [['company_id', '=', companyId], ['active', '=', true]];

    if (search) {
        domain.push('|');
        domain.push(['name', 'ilike', search]);
        domain.push(['default_code', 'ilike', search]);
    }

    if (category !== null) {
        domain.push(['categ_id', '=', category]);
    }

    const fields = [
        'id', 'name', 'default_code', 'barcode',
        'list_price', 'standard_price', 'categ_id',
        'qty_available', 'active', 'company_id'
    ];

    return callOdoo(
        'product.product',
        'search_read',
        [domain],
        withCompany(companyId, { fields, offset, limit })
    );
}

/**
 * Trae un producto completo por ID.
 *
 * @param {number} productId
 * @param {string} companyKey
 * @returns {Promise<object|null>}
 */
async function getProductById(productId, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    const fields = [
        'id', 'name', 'default_code', 'barcode',
        'list_price', 'standard_price', 'categ_id',
        'qty_available', 'active', 'company_id',
        'description', 'type', 'uom_id'
    ];

    const results = await callOdoo(
        'product.product',
        'search_read',
        [[['id', '=', productId], ['company_id', '=', companyId]]],
        withCompany(companyId, { fields, limit: 1 })
    );

    return results.length > 0 ? results[0] : null;
}

/**
 * Actualiza standard_price (costo) y list_price (precio de venta) de un producto.
 * Si se provee categId, también actualiza categ_id en Odoo.
 *
 * @param {number} productId
 * @param {number} cost — standard_price
 * @param {number} salePrice — list_price
 * @param {string} companyKey
 * @param {number|null} [categId=null] — categ_id de Odoo (opcional)
 * @returns {Promise<boolean>} true si Odoo confirmó la escritura
 */
async function updateProductPrices(productId, cost, salePrice, companyKey, categId = null) {
    const companyId = await resolveCompanyId(companyKey);

    const vals = {};
    const costN = Number(cost);
    const saleN = salePrice == null || salePrice === '' ? null : Number(salePrice);
    if (Number.isFinite(costN)) vals.standard_price = costN;
    if (Number.isFinite(saleN)) vals.list_price = saleN;
    if (categId) vals.categ_id = categId;
    if (Object.keys(vals).length === 0) return false;

    const result = await callOdoo(
        'product.product',
        'write',
        [[productId], vals],
        withCompany(companyId)
    );

    console.log(`✅ Precios actualizados en Odoo — producto ${productId} [${companyKey}]: costo=${cost}, venta=${salePrice}${categId ? `, categ=${categId}` : ''}`);
    return result;
}

/**
 * Trae el árbol de categorías de productos de Odoo para una empresa.
 * Usa el campo complete_name que incluye la ruta completa (ej: "All / Electrónica / Audio").
 *
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @returns {Promise<Array<{id, name, complete_name}>>}
 */
async function getProductCategories(companyKey) {
    const companyId = await resolveCompanyId(companyKey);
    return callOdoo(
        'product.category',
        'search_read',
        [[]],
        withCompany(companyId, {
            fields: ['id', 'name', 'complete_name'],
            limit: 500,
            order: 'complete_name asc'
        })
    );
}

/**
 * Actualiza la cantidad (stock) de un producto en Odoo
 * Se suma la cantidad delta al stock actual
 *
 * @param {number} productId
 * @param {number} quantityDelta — cantidad a sumar (puede ser negativa)
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @returns {Promise<{success, new_qty, old_qty}>}
 */
async function updateProductQty(productId, quantityDelta, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    // Traer cantidad actual en Odoo
    const currentProduct = await callOdoo(
        'product.product',
        'read',
        [[productId], ['qty_available']],
        withCompany(companyId)
    );

    if (!currentProduct || currentProduct.length === 0) {
        throw new Error(`Producto ${productId} no encontrado en Odoo`);
    }

    const oldQty = currentProduct[0].qty_available || 0;
    const newQty = oldQty + quantityDelta;

    // Escribir nueva cantidad
    await callOdoo(
        'product.product',
        'write',
        [[productId], { qty_available: newQty }],
        withCompany(companyId)
    );

    console.log(`✅ Stock actualizado en Odoo — producto ${productId} [${companyKey}]: ${oldQty} → ${newQty}`);

    return {
        success: true,
        old_qty: oldQty,
        new_qty: newQty
    };
}

/**
 * Crea un producto en Odoo.
 * Usa product.template (no product.product) para soportar detailed_type en Odoo 17+/19.
 * En Odoo 17+, type='product' fue eliminado; la forma correcta es detailed_type='product'
 * sobre product.template. Retorna el ID del product.product (variante) recién creado.
 *
 * @param {object} values — campos del producto (name, default_code, detailed_type, etc.)
 * @param {string} companyKey
 * @returns {Promise<number>} ID del product.product creado
 */
async function createProduct(values, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    const { standard_price, ...templateValues } = values;
    const productData = { ...templateValues, company_id: companyId };

    // 1. Crear product.template
    const tmplId = await callOdoo(
        'product.template',
        'create',
        [productData],
        withCompany(companyId)
    );

    if (!tmplId) throw new Error('No se pudo crear el template del producto');

    // 2. Obtener el product.product via búsqueda por product_tmpl_id (más robusto que leer product_variant_ids)
    const variants = await callOdoo(
        'product.product',
        'search_read',
        [[['product_tmpl_id', '=', tmplId]]],
        withCompany(companyId, { fields: ['id'], limit: 1 })
    );

    const newId = variants?.[0]?.id;
    if (!newId) throw new Error(`Template ${tmplId} creado pero sin variante product.product`);

    // 3. Escribir standard_price explícitamente en la variante — en Odoo a veces no se propaga desde el template
    if (standard_price !== undefined) {
        try {
            await callOdoo(
                'product.product',
                'write',
                [[newId], { standard_price }],
                withCompany(companyId)
            );
        } catch (e) {
            console.warn(`⚠️ No se pudo setear standard_price en variante ${newId}:`, e.message);
        }
    }

    console.log(`✅ Producto creado en Odoo [${companyKey}] — template: ${tmplId}, variante: ${newId}`);
    return newId;
}

// =============================================
// PARTNERS
// =============================================

/**
 * Busca clientes en Odoo dentro de una empresa específica.
 * No filtra por customer_rank porque en muchas instalaciones no está seteado.
 *
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @param {object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.limit=30]
 * @returns {Promise<Array>}
 */
async function getCustomers(companyKey, { search = '', limit = 30 } = {}) {
    const companyId = await resolveCompanyId(companyKey);

    // No filtramos por company_id en el domain — dejamos que allowed_company_ids
    // del contexto maneje la visibilidad multi-empresa. Filtrar por company_id
    // excluía clientes creados bajo otra empresa del grupo (ej: Neggo).
    const domain = [['active', '=', true]];
    if (search) domain.push(['name', 'ilike', search.trim()]);

    const fields = ['id', 'name', 'email', 'phone', 'vat', 'city', 'customer_rank'];

    return callOdoo(
        'res.partner',
        'search_read',
        [domain],
        withCompany(companyId, { fields, limit, order: 'customer_rank desc, name asc' })
    );
}

/**
 * Crea una orden de venta (sale.order) en Odoo con sus líneas.
 * Retorna { id, name } donde name es el número de orden (ej: "S00042").
 *
 * @param {number} partnerId — ID del cliente en Odoo
 * @param {Array<{ product_id: number|false, name: string, quantity: number, unit_price: number }>} lines
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @returns {Promise<{ id: number, name: string }>}
 */
async function createSaleOrder(partnerId, lines, companyKey, extra = {}) {
    const companyId = await resolveCompanyId(companyKey);

    const orderLines = lines.map(line => [0, 0, {
        product_id:       line.product_id || false,
        name:             line.name,
        product_uom_qty:  line.quantity,
        price_unit:       line.unit_price,
    }]);

    const values = {
        partner_id: partnerId,
        order_line: orderLines,
    };
    if (extra.origin) values.origin = extra.origin;
    if (extra.client_order_ref) values.client_order_ref = extra.client_order_ref;
    if (extra.note) values.note = extra.note;

    const orderId = await callOdoo(
        'sale.order',
        'create',
        [values],
        withCompany(companyId)
    );

    if (!orderId) throw new Error('Odoo no retornó un ID de orden de venta');

    const [orderData] = await callOdoo(
        'sale.order',
        'read',
        [[orderId], ['name']],
        withCompany(companyId)
    );

    const name = orderData?.name || `S${String(orderId).padStart(5, '0')}`;

    console.log(`✅ Sale order creada en Odoo [${companyKey}] — ID: ${orderId}, nombre: ${name}, partner: ${partnerId}, líneas: ${lines.length}`);
    return { id: orderId, name };
}

/**
 * Crea un nuevo cliente (res.partner) en Odoo como partner global (sin company_id)
 * para que sea accesible desde todas las empresas.
 *
 * @param {{ name: string, phone?: string, mobile?: string, email?: string }} data
 * @param {string} companyKey
 * @returns {Promise<{ id: number, name: string }>}
 */
async function createCustomer(data, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    const partnerId = await callOdoo(
        'res.partner',
        'create',
        [{
            name:          data.name,
            phone:         data.phone || false,
            email:         data.email || false,
            company_id:    false,
            customer_rank: 1,
        }],
        withCompany(companyId)
    );

    if (!partnerId) throw new Error('Odoo no retornó un ID para el nuevo cliente');
    console.log(`✅ Cliente creado en Odoo [global] — ID: ${partnerId}, nombre: ${data.name}`);
    return { id: partnerId, name: data.name };
}

/**
 * Trae un partner por ID con sus campos de contacto.
 * Útil para refrescar datos de cliente desde Odoo.
 *
 * @param {number} partnerId
 * @param {string} companyKey
 * @returns {Promise<object|null>}
 */
async function getCustomerById(partnerId, companyKey) {
    const companyId = await resolveCompanyId(companyKey);
    const results = await callOdoo(
        'res.partner',
        'read',
        [[partnerId], ['id', 'name', 'phone', 'email', 'city', 'vat', 'company_id']],
        withCompany(companyId)
    );
    return results?.[0] ?? null;
}

/**
 * Garantiza que un partner sea accesible en la empresa indicada.
 * Primero intenta leer por ID. Si no es visible, busca por nombre exacto.
 * Si tampoco existe, lo crea como partner global.
 *
 * @param {number} partnerId
 * @param {string} partnerName
 * @param {string} companyKey — 'neggo' | 'preventas'
 * @returns {Promise<number>} ID del partner (puede ser el original u otro)
 */
async function ensurePartner(partnerId, partnerName, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    // Leer el partner e inspeccionar su company_id
    try {
        const [p] = await callOdoo(
            'res.partner',
            'read',
            [[partnerId], ['id', 'name', 'company_id']],
            withCompany(companyId)
        ) || [];
        if (p) {
            const pCompany = Array.isArray(p.company_id) ? p.company_id[0] : p.company_id;

            // Global o misma empresa → compatible, usar tal cual
            if (!pCompany || pCompany === companyId) return partnerId;

            // Pertenece a otra empresa → intentar hacerlo global usando
            // el contexto de su empresa original (que es donde tenemos acceso)
            console.log(`⚠️ Partner ${partnerId} "${partnerName}" pertenece a empresa ${pCompany}, haciéndolo global`);
            try {
                await callOdoo(
                    'res.partner',
                    'write',
                    [[partnerId], { company_id: false }],
                    { context: { allowed_company_ids: [pCompany] } }
                );
                console.log(`✅ Partner ${partnerId} "${partnerName}" ahora es global`);
                return partnerId;
            } catch (writeErr) {
                console.log(`⚠️ No se pudo hacer global (${writeErr.message}), creando partner nuevo`);
            }
        }
    } catch {}

    // Buscar partner compatible (global o de la empresa destino) por nombre exacto
    const found = await callOdoo(
        'res.partner',
        'search_read',
        [[
            ['name', '=', partnerName],
            ['active', '=', true],
            '|',
            ['company_id', '=', false],
            ['company_id', '=', companyId],
        ]],
        withCompany(companyId, { fields: ['id', 'name'], limit: 1 })
    );
    if (found?.length) {
        console.log(`📦 Partner "${partnerName}" compatible en [${companyKey}]: ID ${found[0].id}`);
        return found[0].id;
    }

    // Última opción: crear globalmente con los datos del partner original
    let createData = { name: partnerName };
    try {
        const [orig] = await callOdoo(
            'res.partner',
            'read',
            [[partnerId], ['name', 'phone', 'email', 'city', 'vat']],
            withCompany(companyId)
        ) || [];
        if (orig) createData = { name: orig.name, phone: orig.phone || undefined, email: orig.email || undefined };
    } catch {}

    const created = await createCustomer(createData, companyKey);
    console.log(`✅ Partner "${partnerName}" creado globalmente para [${companyKey}]: ID ${created.id}`);
    return created.id;
}

/**
 * Reemplaza todas las líneas de un sale.order existente.
 * Usa (5,0,0) para borrar las existentes y (0,0,{...}) para agregar las nuevas.
 * Solo válido mientras la orden está en estado draft (cotización).
 *
 * @param {number} odooOrderId
 * @param {Array<{ product_id: number|false, name: string, quantity: number, unit_price: number }>} lines
 * @param {string} companyKey
 */
async function updateSaleOrderLines(odooOrderId, lines, companyKey) {
    const companyId = await resolveCompanyId(companyKey);
    const orderLines = [
        [5, 0, 0],
        ...lines.map(l => [0, 0, {
            product_id:      l.product_id || false,
            name:            l.name,
            product_uom_qty: l.quantity,
            price_unit:      l.unit_price,
        }])
    ];
    await callOdoo(
        'sale.order',
        'write',
        [[odooOrderId], { order_line: orderLines }],
        withCompany(companyId)
    );
    console.log(`✅ Líneas actualizadas [${companyKey}] orden ${odooOrderId}: ${lines.length} ítems`);
}

/**
 * Confirma una orden de venta (draft → sale).
 *
 * @param {number} odooOrderId
 * @param {string} companyKey
 */
/**
 * Archiva o desarchiva un producto en Odoo (active = false/true).
 * Opera sobre product.product (variante) y también sobre product.template.
 *
 * @param {number} odooProductId — ID de product.product
 * @param {string} companyKey    — 'neggo' | 'preventas'
 * @param {boolean} archived     — true = archivar, false = restaurar
 */
async function setProductArchived(odooProductId, companyKey, archived = true) {
    const companyId = await resolveCompanyId(companyKey);

    // Obtener el template_id de la variante
    const variants = await callOdoo(
        'product.product',
        'search_read',
        [[['id', '=', odooProductId]]],
        withCompany(companyId, { fields: ['product_tmpl_id'], limit: 1 })
    );
    const tmplId = variants?.[0]?.product_tmpl_id?.[0];

    if (tmplId) {
        // Usar action_archive/action_unarchive en el template — método canónico de Odoo.
        // Afecta el template y todas sus variantes.
        const method = archived ? 'action_archive' : 'action_unarchive';
        await callOdoo('product.template', method, [[tmplId]], withCompany(companyId));
    } else {
        // Fallback: write directo en la variante si no se encontró el template
        await callOdoo(
            'product.product',
            'write',
            [[odooProductId], { active: !archived }],
            withCompany(companyId)
        );
    }

    console.log(`✅ Producto odoo_id=${odooProductId} (tmpl=${tmplId}) ${archived ? 'archivado' : 'restaurado'} en Odoo [${companyKey}]`);
}

async function confirmSaleOrder(odooOrderId, companyKey) {
    const companyId = await resolveCompanyId(companyKey);
    await callOdoo(
        'sale.order',
        'action_confirm',
        [[odooOrderId]],
        withCompany(companyId)
    );
    console.log(`✅ Sale order ${odooOrderId} confirmada en Odoo [${companyKey}]`);
}

/**
 * Cancela una orden de venta en Odoo.
 * Si la orden está confirmada ('sale'), intenta cancelarla con action_cancel.
 *
 * @param {number} odooOrderId
 * @param {string} companyKey
 * @returns {Promise<boolean>}
 */
async function cancelSaleOrder(odooOrderId, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    await callOdoo(
        'sale.order',
        'action_cancel',
        [[odooOrderId]],
        withCompany(companyId)
    );

    console.log(`✅ Sale order ${odooOrderId} cancelada en Odoo [${companyKey}]`);
    return true;
}

/**
 * Trae partners de Odoo filtrados por tipo.
 *
 * @param {object} opts
 * @param {'customer'|'supplier'} [opts.type='customer']
 * @param {string} [opts.search=''] — filtra por nombre o email
 * @returns {Promise<Array>}
 */
async function getPartners({ type = 'customer', search = '' } = {}) {
    // Buscar por nombre — no filtramos por supplier_rank/customer_rank porque
    // en muchas instalaciones de Odoo esos flags no están seteados correctamente.
    const domain = search
        ? [['name', 'ilike', search]]
        : [];

    const fields = [
        'id', 'name', 'email', 'phone',
        'supplier_rank', 'customer_rank', 'company_id',
        'street', 'city', 'vat'
    ];

    return callOdoo(
        'res.partner',
        'search_read',
        [domain],
        { fields, limit: 50, order: 'name asc' }
    );
}

/**
 * Trae un partner por ID con todos sus campos relevantes.
 *
 * @param {number} partnerId
 * @returns {Promise<object|null>}
 */
async function getPartnerById(partnerId) {
    const fields = [
        'id', 'name', 'email', 'phone',
        'supplier_rank', 'customer_rank', 'company_id',
        'street', 'city', 'country_id', 'vat',
        'comment', 'active'
    ];

    const results = await callOdoo(
        'res.partner',
        'search_read',
        [[['id', '=', partnerId]]],
        { fields, limit: 1 }
    );

    return results.length > 0 ? results[0] : null;
}

// =============================================
// ÓRDENES DE COMPRA
// =============================================

/**
 * Crea una orden de compra (purchase.order) con sus líneas.
 *
 * @param {number} partnerId — ID del proveedor en Odoo
 * @param {Array<{ product_id: number, name: string, quantity: number, unit_price: number }>} lines
 * @param {string} companyKey
 * @returns {Promise<number>} ID de la orden creada
 */
async function createPurchaseOrder(partnerId, lines, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    // Construir líneas en formato Odoo (comando 0 = create)
    const orderLines = lines.map(line => [0, 0, {
        product_id: line.product_id,
        name: line.name,
        product_qty: line.quantity,
        price_unit: line.unit_price
    }]);

    const orderId = await callOdoo(
        'purchase.order',
        'create',
        [{
            partner_id: partnerId,
            order_line: orderLines,
            company_id: companyId
        }],
        withCompany(companyId)
    );

    console.log(`✅ Orden de compra creada en Odoo [${companyKey}] — ID: ${orderId}, partner: ${partnerId}, líneas: ${lines.length}`);
    return orderId;
}

/**
 * Agrega líneas a una orden de compra existente (que esté en estado borrador).
 *
 * @param {number} orderId
 * @param {Array<{ product_id: number, name: string, quantity: number, unit_price: number }>} lines
 * @param {string} companyKey
 * @returns {Promise<boolean>}
 */
async function addLinesToPurchaseOrder(orderId, lines, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    const orderLines = lines.map(line => [0, 0, {
        product_id: line.product_id,
        name: line.name,
        product_qty: line.quantity,
        price_unit: line.unit_price
    }]);

    await callOdoo(
        'purchase.order',
        'write',
        [[orderId], { order_line: orderLines }],
        withCompany(companyId)
    );

    console.log(`✅ Agregadas ${lines.length} líneas a OC ${orderId} en Odoo [${companyKey}]`);
    return true;
}

/**
 * Confirma una orden de compra (botón Confirmar en Odoo).
 *
 * @param {number} orderId
 * @param {string} companyKey
 * @returns {Promise<boolean>}
 */
async function confirmPurchaseOrder(orderId, companyKey) {
    const companyId = await resolveCompanyId(companyKey);

    const result = await callOdoo(
        'purchase.order',
        'button_confirm',
        [[orderId]],
        withCompany(companyId)
    );

    console.log(`✅ Orden de compra ${orderId} confirmada en Odoo [${companyKey}]`);
    return result;
}

// =============================================
// COTIZACIONES DE VENTA
// =============================================

/**
 * Trae órdenes de venta de Odoo para un partner, con filtros opcionales.
 *
 * @param {number} partnerId
 * @param {object} opts
 * @param {string|null} [opts.status=null] — estado Odoo ('draft', 'sale', 'done', 'cancel')
 * @param {string|null} [opts.from=null] — fecha ISO desde
 * @param {string|null} [opts.to=null] — fecha ISO hasta
 * @returns {Promise<Array>}
 */
async function getSaleOrders(partnerId, { status = null, from = null, to = null } = {}) {
    const domain = [['partner_id', '=', partnerId]];

    if (status) {
        domain.push(['state', '=', status]);
    }

    if (from) {
        domain.push(['date_order', '>=', from]);
    }

    if (to) {
        domain.push(['date_order', '<=', to]);
    }

    const fields = [
        'id', 'name', 'partner_id', 'state',
        'date_order', 'amount_total', 'amount_untaxed',
        'order_line', 'company_id'
    ];

    return callOdoo(
        'sale.order',
        'search_read',
        [domain],
        { fields, order: 'date_order desc', limit: 100 }
    );
}

const QUOTATION_PAGE = 200;
const QUOTATION_PAGE_CAP = 20000;

/**
 * Lee search_read de a una página. Corta si Odoo repite la página
 * (offset ignorado) para no entrar en un bucle.
 */
async function readAllPages(fetchPage, pageSize = QUOTATION_PAGE) {
    const all = [];
    const seen = new Set();
    let offset = 0;

    while (offset <= QUOTATION_PAGE_CAP) {
        const rows = (await fetchPage(offset, pageSize)) || [];
        let added = 0;
        for (const row of rows) {
            if (row && row.id != null) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
            }
            all.push(row);
            added++;
        }
        if (rows.length < pageSize || added === 0) break;
        offset += pageSize;
    }

    return all;
}

async function readByIds(model, ids, fields, context) {
    const chunkSize = 80;
    const all = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const rows = await callOdoo(
            model,
            'search_read',
            [[['id', 'in', chunk]]],
            { fields, limit: chunk.length, context }
        );
        if (rows && rows.length) all.push(...rows);
    }
    return all;
}

// Línea de nota o de sección: Odoo manda product_id en false. No es un producto.
function normalizeQuotationLine(line, defaultCodes) {
    const productId = Array.isArray(line.product_id) ? line.product_id[0] : null;
    if (!productId) return null;
    return {
        id:           line.id,
        product_id:   productId,
        product_name: Array.isArray(line.product_id) ? line.product_id[1] : line.name,
        external_id:  defaultCodes[productId] || null,
        quantity:     line.product_uom_qty,
        unit_price:   line.price_unit,
        subtotal:     line.price_subtotal,
    };
}

const WEEKLY_SALES_TTL_MS = 10 * 60 * 1000;
const WEEKLY_SALES_ERROR_TTL_MS = 2 * 60 * 1000;
let weeklySoldCache = null;

function odooProductId(value) {
    if (Array.isArray(value)) return value[0] || null;
    return value || null;
}

function sumQtyByProduct(lines, qtyField) {
    const qtyById = new Map();
    for (const line of lines) {
        const pid = Number(odooProductId(line.product_id));
        const qty = Number(line[qtyField]) || 0;
        if (!pid || qty <= 0) continue;
        qtyById.set(pid, (qtyById.get(pid) || 0) + qty);
    }
    return qtyById;
}

function mergeQtyMaps(into, from) {
    for (const [id, qty] of from) into.set(id, (into.get(id) || 0) + qty);
    return into;
}

/**
 * Cantidades vendidas en los últimos 7 días (empresa Neggo por defecto).
 * Suma líneas de sale.order confirmadas y, si existe, de pos.order.
 * Solo lee Odoo. Cachea 10 minutos para no pegarle en cada modal.
 *
 * @returns {Promise<{ qtyById: Map<number, number>, error: string|null, desde: string }>}
 */
async function getWeeklySoldQty(companyKey = 'neggo') {
    const now = Date.now();
    if (weeklySoldCache && weeklySoldCache.companyKey === companyKey) {
        const ttl = weeklySoldCache.error ? WEEKLY_SALES_ERROR_TTL_MS : WEEKLY_SALES_TTL_MS;
        if (now - weeklySoldCache.at < ttl) return weeklySoldCache;
    }

    const since = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const desde = since.toISOString().slice(0, 19).replace('T', ' ');

    try {
        const companyId = await resolveCompanyId(companyKey);
        const context = { allowed_company_ids: [companyId], active_test: false };
        const qtyById = new Map();

        const saleLines = await readAllPages((offset, limit) => callOdoo(
            'sale.order.line',
            'search_read',
            [[
                ['order_id.company_id', '=', companyId],
                ['order_id.state', 'in', ['sale', 'done']],
                ['order_id.date_order', '>=', desde],
                ['product_id', '!=', false],
            ]],
            { fields: ['id', 'product_id', 'product_uom_qty'], limit, offset, context }
        ));
        mergeQtyMaps(qtyById, sumQtyByProduct(saleLines, 'product_uom_qty'));

        try {
            const posLines = await readAllPages((offset, limit) => callOdoo(
                'pos.order.line',
                'search_read',
                [[
                    ['order_id.company_id', '=', companyId],
                    ['order_id.state', 'in', ['paid', 'done', 'invoiced']],
                    ['order_id.date_order', '>=', desde],
                    ['product_id', '!=', false],
                ]],
                { fields: ['id', 'product_id', 'qty'], limit, offset, context }
            ));
            mergeQtyMaps(qtyById, sumQtyByProduct(posLines, 'qty'));
        } catch (err) {
            console.warn(`⚠️ POS no disponible para ventas de la semana: ${err.message}`);
        }

        weeklySoldCache = { at: now, companyKey, qtyById, error: null, desde };
        return weeklySoldCache;
    } catch (err) {
        console.error('❌ Ventas de la semana (reposición):', err.message);
        weeklySoldCache = { at: now, companyKey, qtyById: new Map(), error: err.message, desde };
        return weeklySoldCache;
    }
}

/**
 * Trae las cotizaciones de venta de la empresa Preventas (por defecto draft + sent),
 * con sus líneas de productos. Pagina de a 200 hasta agotarlas.
 *
 * @param {string[]} [states] - estados de sale.order a traer
 * @returns {Promise<Array>}
 */
async function getPreventasQuotations(states = ['draft', 'sent']) {
    const companyId = await resolveCompanyId('preventas');
    const context = { allowed_company_ids: [companyId] };

    const orders = await readAllPages((offset, limit) => callOdoo(
        'sale.order',
        'search_read',
        [[['state', 'in', states], ['company_id', '=', companyId]]],
        {
            fields: ['id', 'name', 'partner_id', 'date_order', 'amount_total', 'amount_untaxed', 'state', 'order_line'],
            order:  'id asc',
            limit,
            offset,
            context,
        }
    ));

    if (orders.length === 0) return [];

    const allLineIds = [...new Set(orders.flatMap(o => o.order_line || []))];
    const lines = allLineIds.length > 0
        ? await readByIds(
            'sale.order.line',
            allLineIds,
            ['id', 'order_id', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal', 'name'],
            context
        )
        : [];

    const productIds = [...new Set(
        lines.map(l => (Array.isArray(l.product_id) ? l.product_id[0] : null)).filter(Boolean)
    )];
    const defaultCodes = {};
    const artCodeRe = /\bArt\.\s+(\S+)\s*$/i;
    if (productIds.length > 0) {
        const products = await readByIds(
            'product.product',
            productIds,
            ['id', 'default_code', 'name'],
            context
        );
        for (const p of products) {
            if (p.default_code) {
                defaultCodes[p.id] = p.default_code;
            } else if (p.name) {
                // Fallback: extraer "Art. XXXXX" del nombre y anteponer PRE
                // Ej: "PLANCHA Art. ITP113238" → external_id = "PREITP113238"
                const m = p.name.match(artCodeRe);
                if (m) defaultCodes[p.id] = `PRE${m[1]}`;
            }
        }
        const conRef = Object.keys(defaultCodes).length;
        console.log(`📦 Referencias cargadas: ${conRef}/${productIds.length} productos (default_code o Art. del nombre)`);
    }

    const linesByOrder = {};
    let skipped = 0;
    for (const line of lines) {
        const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
        const normalized = normalizeQuotationLine(line, defaultCodes);
        if (!normalized) {
            skipped++;
            continue;
        }
        if (!linesByOrder[orderId]) linesByOrder[orderId] = [];
        linesByOrder[orderId].push(normalized);
    }
    if (skipped > 0) {
        console.log(`📋 Líneas de Odoo sin producto omitidas: ${skipped}`);
    }

    orders.sort((a, b) => String(b.date_order || '').localeCompare(String(a.date_order || '')) || b.id - a.id);
    console.log(`📋 Cotizaciones Preventas leídas: ${orders.length}`);

    return orders.map(o => ({
        id:         o.id,
        name:       o.name,
        client:     Array.isArray(o.partner_id) ? o.partner_id[1] : null,
        partner_id: Array.isArray(o.partner_id) ? o.partner_id[0] : null,
        date:       o.date_order,
        total:      o.amount_total,
        subtotal:   o.amount_untaxed,
        state:      o.state,
        lines:      linesByOrder[o.id] || [],
    }));
}

/**
 * Órdenes de venta con líneas, por empresa. Para armado/control.
 * No usa updateSaleOrderLines (ese helper borra todas las líneas).
 *
 * @param {'neggo'|'preventas'} companyKey
 * @param {{ states?: string[], days?: number|null, ids?: number[]|null }} [opts]
 */
async function getSaleOrdersWithLines(companyKey, {
    states = ['sale'],
    days = 30,
    ids = null,
    limit = 80,
} = {}) {
    const companyId = await resolveCompanyId(companyKey);
    const context = { allowed_company_ids: [companyId] };
    const domain = [['company_id', '=', companyId]];

    if (ids && ids.length) {
        domain.push(['id', 'in', ids]);
    } else {
        domain.push(['state', 'in', states]);
        if (days) {
            const from = new Date();
            from.setDate(from.getDate() - Number(days));
            domain.push(['date_order', '>=', from.toISOString().slice(0, 10)]);
        }
    }

    const pageSize = ids && ids.length ? ids.length : Math.min(Number(limit) || 80, 80);
    const orders = await callOdoo(
        'sale.order',
        'search_read',
        [domain],
        {
            fields: [
                'id', 'name', 'partner_id', 'date_order', 'amount_total',
                'amount_untaxed', 'state', 'order_line', 'origin', 'client_order_ref',
            ],
            order: 'date_order desc',
            limit: pageSize,
            context,
        }
    ) || [];

    if (orders.length === 0) return [];

    const allLineIds = [...new Set(orders.flatMap(o => o.order_line || []))];
    const lines = allLineIds.length > 0
        ? await readByIds(
            'sale.order.line',
            allLineIds,
            ['id', 'order_id', 'product_id', 'product_uom_qty', 'qty_delivered', 'price_unit', 'price_subtotal', 'name'],
            context
        )
        : [];

    const linesByOrder = {};
    for (const line of lines) {
        const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
        const productId = Array.isArray(line.product_id) ? line.product_id[0] : null;
        if (!productId) continue;
        if (!linesByOrder[orderId]) linesByOrder[orderId] = [];
        linesByOrder[orderId].push({
            id:            line.id,
            product_id:    productId,
            product_name:  Array.isArray(line.product_id) ? line.product_id[1] : line.name,
            quantity:      Number(line.product_uom_qty) || 0,
            qty_delivered: Number(line.qty_delivered) || 0,
            unit_price:    Number(line.price_unit) || 0,
            subtotal:      Number(line.price_subtotal) || 0,
        });
    }

    return orders.map(o => ({
        id:               o.id,
        name:             o.name,
        client:           Array.isArray(o.partner_id) ? o.partner_id[1] : null,
        partner_id:       Array.isArray(o.partner_id) ? o.partner_id[0] : null,
        date:             o.date_order,
        total:            o.amount_total,
        subtotal:         o.amount_untaxed,
        state:            o.state,
        origin:           o.origin || null,
        client_order_ref: o.client_order_ref || null,
        lines:            linesByOrder[o.id] || [],
    }));
}

async function writeSaleOrderLineQty(lineId, qty, companyKey) {
    const companyId = await resolveCompanyId(companyKey);
    await callOdoo(
        'sale.order.line',
        'write',
        [[lineId], { product_uom_qty: qty }],
        withCompany(companyId)
    );
}

async function unlinkSaleOrderLines(lineIds, companyKey) {
    const ids = (lineIds || []).filter(id => Number.isInteger(id));
    if (ids.length === 0) return;
    const companyId = await resolveCompanyId(companyKey);
    await callOdoo(
        'sale.order.line',
        'unlink',
        [ids],
        withCompany(companyId)
    );
}

module.exports = {
    // Productos
    getProducts,
    getProductById,
    updateProductPrices,
    updateProductQty,
    createProduct,
    getProductCategories,
    setProductArchived,
    // Partners
    getPartners,
    getPartnerById,
    getCustomers,
    getCustomerById,
    createCustomer,
    ensurePartner,
    // Órdenes de compra
    updateSaleOrderLines,
    confirmSaleOrder,
    createPurchaseOrder,
    addLinesToPurchaseOrder,
    confirmPurchaseOrder,
    // Órdenes de venta
    createSaleOrder,
    cancelSaleOrder,
    getSaleOrders,
    getSaleOrdersWithLines,
    writeSaleOrderLineQty,
    unlinkSaleOrderLines,
    getPreventasQuotations,
    getWeeklySoldQty,
    readAllPages,
    normalizeQuotationLine,
    sumQtyByProduct,
};

