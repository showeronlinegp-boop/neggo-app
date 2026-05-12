---
name: odoo-integration
description: Patrones de integración con Odoo 19 via JSON-RPC. Leer antes de cualquier interacción con Odoo incluyendo lectura/escritura de productos, partners, órdenes de venta, órdenes de compra y facturas. Cubre autenticación, multi-empresa y modelos principales.
---

# Integración Odoo 19 — JSON-RPC

## Conexión

Odoo 19 usa JSON-RPC nativo. Endpoint único: `https://neggo.odoo.com/jsonrpc`

### Autenticación
Para Odoo Online con plan Custom: usar API Key (no password).
Generar en: Ajustes → Usuarios → tu usuario → Seguridad de Cuenta → API Keys.

```javascript
// Llamada JSON-RPC genérica
async function jsonRpc(url, method, params) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: Date.now()
        })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.data?.message || data.error.message);
    return data.result;
}

// Llamada a un modelo Odoo (call_kw)
async function callOdoo(model, method, args, kwargs = {}) {
    return jsonRpc(`${ODOO_URL}/jsonrpc`, 'call', {
        service: 'object',
        method: 'execute_kw',
        args: [ODOO_DB, ODOO_USER_ID, ODOO_API_KEY, model, method, args, kwargs]
    });
}
```

## Multi-empresa

Cada llamada debe incluir el `company_id` en el contexto para operar en la empresa correcta.

```javascript
// Leer productos de la empresa Neggo (company_id hay que obtenerlo)
const products = await callOdoo('product.product', 'search_read',
    [[['active', '=', true]]],
    {
        fields: ['name', 'default_code', 'list_price', 'standard_price', 'categ_id', 'barcode', 'qty_available'],
        context: { 'allowed_company_ids': [NEGGO_COMPANY_ID] },
        limit: 100,
        offset: 0
    }
);
```

Los company_ids se obtienen una vez al iniciar:
```javascript
const companies = await callOdoo('res.company', 'search_read',
    [[]],
    { fields: ['id', 'name'] }
);
// Guardar: { neggo: id_neggo, preventas: id_preventas }
```

## Modelos principales y campos

### product.product (productos)
```
id, name, default_code (ref interna), barcode, list_price (venta),
standard_price (costo), categ_id, image_1920, qty_available,
active, company_id
```

### product.template (templates)
```
id, name, default_code, list_price, categ_id, image_1920
```
Un template puede tener múltiples product.product (variantes).

### res.partner (clientes/proveedores)
```
id, name, email, phone, mobile, street, city, vat,
supplier_rank (>0 = proveedor), customer_rank (>0 = cliente),
company_id
```

### sale.order (cotizaciones/ventas)
```
id, name, partner_id, date_order, state, amount_total,
order_line (one2many), company_id
```
States: draft, sent, sale, done, cancel

### purchase.order (órdenes de compra)
```
id, name, partner_id, date_order, state, amount_total,
order_line (one2many), company_id
```
States: draft, sent, purchase, done, cancel

### purchase.order.line
```
id, order_id, product_id, name, product_qty,
price_unit, price_subtotal
```

## Operaciones comunes

### Leer productos con paginación
```javascript
async function getProducts(companyId, offset = 0, limit = 100) {
    return callOdoo('product.product', 'search_read',
        [[['active', '=', true]]],
        {
            fields: ['name', 'default_code', 'list_price', 'standard_price',
                     'categ_id', 'barcode', 'qty_available', 'image_128'],
            context: { 'allowed_company_ids': [companyId] },
            limit, offset,
            order: 'name asc'
        }
    );
}
```

### Actualizar precio de un producto
```javascript
async function updateProductPrices(productId, cost, salePrice, companyId) {
    return callOdoo('product.product', 'write',
        [[productId], {
            standard_price: cost,
            list_price: salePrice
        }],
        { context: { 'allowed_company_ids': [companyId] } }
    );
}
```

### Crear orden de compra
```javascript
async function createPurchaseOrder(partnerId, lines, companyId) {
    const orderId = await callOdoo('purchase.order', 'create',
        [{
            partner_id: partnerId,
            company_id: companyId,
            order_line: lines.map(l => [0, 0, {
                product_id: l.product_id,
                name: l.name,
                product_qty: l.quantity,
                price_unit: l.unit_price
            }])
        }],
        { context: { 'allowed_company_ids': [companyId] } }
    );
    return orderId;
}
```

## Cache local

Los datos de Odoo se cachean en la tabla `odoo_products_cache` de PostgreSQL.
Sync cada 2 horas via cron job. El sync es incremental: solo productos con
`write_date` mayor al último sync.

```javascript
async function syncOdooProducts(companyId, lastSync) {
    const domain = lastSync
        ? [['write_date', '>', lastSync.toISOString()]]
        : [['active', '=', true]];
    // ... paginar y actualizar cache
}
```

## Manejo de errores

- Rate limiting: Odoo Online tiene límites (~1 req/seg para operaciones pesadas)
- Agregar retry con backoff exponencial para errores 429 o de conexión
- Loguear todas las llamadas fallidas en scraping_runs.errors
- Si Odoo no responde, la app sigue funcionando con el cache local
