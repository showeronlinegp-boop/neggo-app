# Agente 03 — Servicio Odoo JSON-RPC

## Objetivo
Implementar la capa de abstracción para comunicarse con Odoo 19 via JSON-RPC, incluyendo autenticación, operaciones CRUD multi-empresa, y sync de cache local.

## Skills a leer antes de empezar
- `docs/skills/odoo-integration/SKILL.md` (completa)
- `docs/skills/project-context/SKILL.md` (sección multi-empresa)

## Dependencias
- Agente 01 y 02 completados

## Tareas

### 1. Cliente JSON-RPC base
Crear `backend/config/odoo.js`:
- Función `jsonRpc(method, params)` genérica
- Función `callOdoo(model, method, args, kwargs)` para execute_kw
- Retry con backoff exponencial (3 intentos, 1s-2s-4s)
- Logging de cada llamada (modelo, método, duración)
- Variables de env: ODOO_URL, ODOO_DB, ODOO_USER_ID, ODOO_API_KEY

### 2. Servicio Odoo
Crear `backend/services/odooService.js` con métodos:

**Empresas:**
- `getCompanies()` → obtener IDs de Neggo y Preventas, cachear en memoria

**Productos:**
- `getProducts(companyKey, { offset, limit, search, category })` → search_read paginado
- `getProductById(productId, companyKey)` → read con todos los campos
- `updateProductPrices(productId, cost, salePrice, companyKey)` → write standard_price + list_price
- `createProduct(values, companyKey)` → create en product.product

**Partners:**
- `getPartners({ type, search })` → type: 'customer' o 'supplier'
- `getPartnerById(partnerId)` → read

**Órdenes de compra:**
- `createPurchaseOrder(partnerId, lines, companyKey)` → create purchase.order con lines
- `confirmPurchaseOrder(orderId, companyKey)` → button_confirm

**Cotizaciones:**
- `getSaleOrders(partnerId, { status, from, to })` → search_read con domain

### 3. Sync de cache
Crear `backend/jobs/odooSync.js`:
- Sync incremental de productos Odoo → tabla `odoo_products_cache`
- Para cada empresa (Neggo y Preventas):
  - Obtener productos con write_date > último sync
  - Upsert en cache (ON CONFLICT DO UPDATE)
  - Actualizar timestamp de sync
- Ejecutar cada 2 horas via cron (configurar en scheduler.js)
- Log de sync: cuántos productos actualizados por empresa

### 4. Ruta de sync manual
Crear entrada en `backend/routes/products.js`:
- `POST /api/products/odoo/sync` — Fuerza sync inmediato (solo admin)
- `GET /api/products/odoo` — Leer del cache local con filtros (company, search, category)

### 5. Job scheduler base
Crear `backend/jobs/scheduler.js`:
- Usar `node-cron`
- Registrar job de sync Odoo cada 2 horas
- Estructura extensible para agregar más jobs después (scraping)
- Log de inicio/fin de cada job

## Criterios de éxito
- [ ] `getCompanies()` retorna IDs de Neggo y Preventas
- [ ] `getProducts('neggo')` trae productos del cache después del sync
- [ ] `updateProductPrices()` actualiza costo y precio en Odoo
- [ ] `createPurchaseOrder()` crea una OC en Odoo visible desde el ERP
- [ ] El sync corre cada 2 horas y actualiza el cache local
- [ ] Si Odoo no responde, la app sigue funcionando con datos del cache
