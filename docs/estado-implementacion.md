# Estado de implementación — Neggo App

Relevamiento estático del 19 de octubre de 2026. Cruza `docs/plan-maestro.md` y `docs/agents/01` a `14` con el código que está en el repositorio. No se levantó Docker ni se llamó a Odoo: el diagnóstico mira archivos, el schema y dos chequeos locales (`node --check` en el backend y `npm run build` en el frontend).

## Cómo se clasifica cada módulo

| Estado | Significado |
|---|---|
| Completo | El flujo de la spec está en código usable (rutas, servicio, página y SQL). Puede quedar deuda menor. |
| Parcial | Hay implementación real y se usa, y a la vez faltan criterios explícitos de la spec. |
| Placeholder | Solo hay DDL, comentarios o andamiaje, sin comportamiento. |
| Inexistente | No hay tabla, ruta, servicio ni página. |

## Qué se confirma del análisis previo

La base de Fase 1 está construida y, en varios módulos, fue más allá del plan:

- Infra Docker: Nginx, Express, Postgres 15 y Chrome (`docker-compose.yml`, `nginx/nginx.conf`, `backend/Dockerfile`).
- Auth, usuarios y activity log.
- Proveedores, reglas y scraping (Cast, Mali, Impotekno, El Rey).
- Productos, vínculos, alertas de precio y cache de Odoo.
- Preventas (pedidos, órdenes a proveedores, catálogos PDF) más sync a Odoo y listas de precios, que el plan no pedía.
- Frontend React 18 con Vite, layout, PWA y las pantallas de Fase 1. El comentario de `frontend/src/App.jsx` (líneas 14-15) que las llama "placeholders" está desactualizado: las páginas cargan la API.

## Qué hay que corregir de ese análisis

| Afirmación previa | Lo que muestra el código |
|---|---|
| Faltan los Agentes 10, 12, 13 y 14 | Falta el comportamiento. El DDL de esas specs ya está copiado en `backend/sql/schema.sql` (aprox. líneas 435-670). No hay servicios, rutas ni páginas. Estado: **placeholder**. |
| Falta el Agente 11 (ingreso, OCR, cámara) | El ingreso de mercadería ya es un módulo grande y operativo, con otro modelo de datos. OCR y cámara no están. Estado: **parcial**. |
| Hay un CRM del agente comercial en `/api/agent/crm` (contactos, envíos, seguimiento) | Esa ruta no existe. `backend/server.js` no monta ningún router bajo `/api/agent`. No hay archivos con "crm", contactos comerciales ni seguimiento de envíos. |

## Tabla módulo / estado / evidencia

| Módulo | Estado | Evidencia |
|---|---|---|
| 01 Infraestructura | Completo | `docker-compose.yml` (nginx, backend, postgres, chrome), `nginx/nginx.conf`, `backend/Dockerfile`, `backend/server.js` (`GET /api/health`), `backend/config/database.js`, `frontend/vite.config.js`, `frontend/manifest.json`, `frontend/public/sw.js`, `.env.example`, `scripts/verify-setup.ps1` |
| 02 Auth, usuarios, activity log | Completo | `backend/middleware/auth.js`, `backend/middleware/activityLog.js`, `backend/routes/auth.js`, `backend/routes/users.js`, `backend/routes/activityLog.js`, `backend/utils/response.js`, `frontend/src/pages/Login.jsx`, `frontend/src/pages/admin/Users.jsx`, `frontend/src/pages/admin/ActivityLog.jsx`, `frontend/src/context/AuthContext.jsx` |
| 03 Integración Odoo | Completo | `backend/config/odoo.js`, `backend/services/odooService.js` (879 líneas), `backend/jobs/odooSync.js`, `backend/jobs/scheduler.js`, `backend/routes/products.js` (`POST /api/products/odoo/sync`, `GET /api/products/odoo`) |
| 04 Proveedores y reglas | Parcial | CRUD y reglas duales: `backend/routes/suppliers.js`, `backend/routes/supplierRules.js`, `backend/services/rulesEngine.js`, `frontend/src/pages/suppliers/SupplierList.jsx`, `frontend/src/pages/suppliers/SupplierRules.jsx`. Faltan `POST /api/suppliers/:id/rules/import-excel` y `GET /api/products/supplier/:id/calculate-prices`. `xlsx` está en `backend/package.json` y ningún archivo lo importa |
| 05 Scraping | Parcial | Orquestación real: `backend/services/scrapingService.js`, `backend/routes/scraping.js`, `backend/scrapers/registry.js`, `frontend/src/pages/scraping/ScrapingPanel.jsx`. Los cuatro scrapers delegan en Python + Selenium (`backend/scrapers/pythonScraper.js`, `backend/scrapers/python/*.py`), no en Puppeteer. Falta el scraper `neggo-odoo` (la clave se siembra en `backend/initDatabase.js` y no está en el registry) |
| 06 Productos, vínculos, alertas | Completo | `backend/services/matchingService.js`, `backend/services/priceAlertService.js`, `backend/routes/productMappings.js`, `backend/routes/priceAlerts.js`, `frontend/src/pages/products/SupplierProducts.jsx`, `frontend/src/pages/products/ProductMappings.jsx`, `frontend/src/pages/alerts/PriceAlerts.jsx`. La spec de alertas por empresa está en el backend (`status = 'auto_applied'` para Preventas) |
| 07 Preventas y catálogos | Completo | `backend/routes/preventas.js` (1087 líneas), `backend/services/preventasService.js`, `backend/services/catalogService.js` (PDFKit), `backend/routes/catalogs.js`, `frontend/src/pages/preventas/ClientOrders.jsx`, `SupplierOrders.jsx`, `Catalogs.jsx`. Además, fuera de la spec: `backend/routes/preventasSync.js`, `backend/services/preventasSyncService.js`, `frontend/src/pages/preventas/PreventasSyncPage.jsx`, cotizaciones Odoo y desglose por proveedor |
| 08 Shell frontend | Completo | `frontend/src/App.jsx`, `frontend/src/components/Layout.jsx`, `ProtectedRoute.jsx`, `frontend/src/api/client.js`, `frontend/src/theme/tokens.js`, componentes en `frontend/src/components/common/`, service worker registrado en `frontend/src/main.jsx` |
| 09 Páginas de Fase 1 | Parcial | Las 12 pantallas de la spec existen y pegan a la API (ver rutas en `frontend/src/App.jsx`). Hueco de la spec: `PriceAlerts.jsx` tabula Pendientes / Aprobadas / Descartadas y no tiene la solapa de solo lectura "Actualizaciones Preventas". El botón "Importar desde Excel" no está en `SupplierRules.jsx` |
| 10 Ventas y clientes | Placeholder | Solo DDL: `client_notes`, `client_reminders`, `client_metrics_cache` en `backend/sql/schema.sql`. No existen `backend/services/clientMetricsService.js`, `backend/routes/clients.js` ni `frontend/src/pages/clients/` |
| 11 Ingreso de mercadería | Parcial | Módulo propio, anterior a la spec: `backend/routes/ingreso.js` (2722 líneas), `backend/services/ingresoService.js`, `frontend/src/pages/IngresoUpload.jsx`, `IngresoPreview.jsx` (2805 líneas), `IngresoList.jsx`, tablas `ingreso_mercaderia` / `ingreso_items` / `invoice_code_mappings`. La spec pide `invoice_imports`, `invoiceMatchingService.js`, `account.move` y foto por cámara. Nada de eso está |
| 12 Pedidos y Kanban | Placeholder | Solo DDL: `neggo_orders`, `neggo_order_items`, `neggo_picking_sessions`. No existen `pickingService.js`, `checkingService.js`, `backend/routes/neggoOrders.js` ni `frontend/src/pages/orders/` |
| 13 Marketing | Placeholder | Solo DDL: `marketing_calendar`, `marketing_templates`, `marketing_generated`. No existen `imageService.js`, `marketingAiService.js`, `backend/routes/marketing.js` ni `frontend/src/pages/marketing/`. `sharp` está en `backend/package.json` y no se importa |
| 14 Compras inteligentes | Placeholder | Solo DDL: `competitors`, `competitor_products`, `competitor_product_mappings`, `stock_alerts`, `purchase_suggestions`, `sales_seasonality`. No existen `backend/routes/competitors.js`, `backend/routes/purchases.js`, `backend/scrapers/competitors/` ni `frontend/src/pages/purchasing/` |
| Extra: listas de precios | Completo | Fuera del plan de los 14 agentes. `backend/routes/pricelists.js`, `backend/services/pricelistService.js`, `frontend/src/pages/preventas/PricelistManager.jsx`, tablas `client_pricelists` y `client_pricelist_rules` |
| Extra: productos Odoo (admin) | Completo | `frontend/src/pages/admin/OdooProducts.jsx`, `frontend/src/pages/admin/AdminPanel.jsx`, archivo y categorías en `backend/routes/products.js` |

No hay ningún agente en estado inexistente: hasta el 10, el 12, el 13 y el 14 dejaron las tablas en el schema.

## Detalle que cambia el diagnóstico

### Fórmula de precios distinta a la del plan

`docs/skills/business-rules/SKILL.md` y el plan maestro calculan el costo como `lista × (1 - descuento)` y el precio Neggo como markup sobre el costo. El código vigente, en `backend/services/rulesEngine.js`, suma un flete del 1,5% y aplica el markup sobre `lista × 1.015` para las dos empresas. La misma fórmula está duplicada en SQL en `backend/routes/products.js` (aprox. líneas 337-345). Los agentes 10 a 14 tienen que usar esta fórmula, o el dueño tiene que decidir volver a la del plan. Hoy los dos documentos dicen cosas distintas.

### Scraping: dos motores de browser

`docker-compose.yml` levanta `browserless/chrome`, y `backend/scrapers/baseScraper.js` sabe conectarse por WebSocket. Los scrapers que realmente corren extienden `PythonScraper` y lanzan Selenium contra el Chromium instalado en `backend/Dockerfile`. `BaseScraper.run()` —el único lugar que llama a `detectPendingCategories()`— no se ejecuta en ese camino. La UI de categorías sin regla igual funciona: `SupplierRules.jsx` lee `GET /api/suppliers/:id/unmapped-categories`, que calcula el faltante en el momento.

El backend del compose depende de Postgres y no declara dependencia de `chrome`. El PDF de cotizaciones en `backend/routes/preventas.js` sí usa Puppeteer contra browserless.

### Agente 11 ya resuelve una parte del flujo

`IngresoUpload.jsx` acepta CSV (drag-and-drop). `ingresoService.parseCSV` usa PapaParse y `parsePrecio` para el formato español. `matchItems` vincula contra `odoo_products_cache` (referencia, nombre, barcode) y guarda el código en `invoice_code_mappings`. La vista previa muestra precio de factura y el producto scrapeado del proveedor (triangulación parcial). Al confirmar, `confirmIngreso` actualiza costos y crea `purchase.order` en Odoo (Neggo y Preventas), no un `account.move`. La foto a Odoo reutiliza `supplier_image_url`; no hay `getUserMedia` ni captura de cámara. El control físico de ingreso ya escucha un lector USB como teclado (`barcodeBuffer` en `IngresoPreview.jsx`).

### Alertas

`priceAlertService.js` escribe Preventas como `auto_applied` y deja Neggo en `pending` para aprobar o descartar. La pantalla no ofrece la solapa de auditoría de Preventas que pide el Agente 09; el badge de empresa aparece dentro de la fila.

### Activity log

`backend/middleware/activityLog.js` registra mutaciones de un usuario autenticado. Los GET de listado no se guardan, salvo login y runs de scraping. El mapa de módulos no nombra ingreso, listas de precios ni preventas-sync: caen en `general`.

## Qué pueden reutilizar los Agentes 10 a 14

`/api/agent/crm` no es un punto de enganche. Lo reutilizable está en Odoo y en Preventas.

### Agente 10 — Ventas y clientes

- Lectura y alta de partners: `odooService.getCustomers`, `getCustomerById`, `createCustomer`, `getPartners`, `getPartnerById`, `getSaleOrders`, `getPreventasQuotations` en `backend/services/odooService.js`.
- API ya expuesta, acotada a Preventas: `GET/POST /api/preventas/customers` y `GET /api/preventas/customers/:id` en `backend/routes/preventas.js`.
- `GET /api/products/odoo/partners` busca proveedores de Odoo (sirve para compras, no para el dashboard de clientes).
- `preventa_client_orders` ya guarda `odoo_partner_id`, teléfono y `notes`. Esas notas son del pedido, no de la ficha. La tabla `client_notes` está vacía de código.
- Listas especiales por cliente: `/api/pricelists`.
- Roles `admin` y `vendedor` ya existen en el layout y en el middleware.

### Agente 11 — cerrar el ingreso, sin reescribirlo

- Parseo, matching, triangulación con `supplier_products`, confirmación y OC: `ingresoService.js` e `ingreso.js`.
- Fotos: `POST /api/ingreso/:id/items/:itemId/upload-supplier-photo` y el proxy de imagen `GET /api/ingreso/odoo-image/:odooId`.
- Alta y reactivación de productos Odoo: `createProduct`, `setProductArchived` y las rutas `create-odoo` / `reactivate`.
- `matchingService.js` y `utils/textMatch.js` si se unifica el fuzzy con el de facturas.
- La spec ya dice que el OCR queda para después y que el flujo posterior se reutiliza. Ese es el estado real.

### Agente 12 — pedidos, picking y Kanban

- `getSaleOrders` y `getPreventasQuotations` para traer pedidos confirmados.
- Cache con barcode, categoría, imagen y stock: `odoo_products_cache` (`qty_available`, `barcode`, `categ_name`, `image_url`).
- Patrón de escaneo USB ya probado en `IngresoPreview.jsx`. No hay API de cámara.
- Tiempo casi real hoy: SSE de logs de scraping (`backend/services/scrapingLogs.js` y los `location` sin buffer en `nginx/nginx.conf`). No hay Socket.IO. El Kanban de la spec puede arrancar con polling; el SSE es el único precedente si se quiere push.
- `frontend/src/hooks/useDraggable.js` ya existe para drag-and-drop en desktop.

### Agente 13 — marketing

- PDF de catálogo con reglas de precio: `backend/services/catalogService.js` y `POST /api/catalogs/generate`.
- Imágenes de producto ya cacheadas (`supplier_products.image_url`, `odoo_products_cache.image_url` / `template_id`).
- `sharp` declarado y sin uso: es la librería que pide la spec para el 1080×1350.
- `OPENAI_API_KEY` ya está en el entorno del servicio backend en `docker-compose.yml`. Ningún archivo llama a OpenAI.
- Storage montado en `/app/storage` y servido por Nginx en `/storage/`.

### Agente 14 — compras inteligentes

- Historial y tendencia: `price_history`, `price_alerts`, `GET /api/products/supplier/:id/price-history`.
- Mismo producto en Neggo y Preventas: `GET /api/mappings/comparison`.
- Stock actual en el cache (`qty_available`), sin velocidad de venta calculada.
- Framework de scrapers (`BaseScraper` / `PythonScraper` + `registry.js`) para competidores. Hay que decidir cuál de los dos motores usar.
- `rulesEngine.calculatePrices` para pasar de precio de lista a costo y venta.
- Métricas de venta del Agente 10 (o `getSaleOrders` directo) para estacionalidad y días de stock. Sin eso el 14 no tiene velocidad de venta.

## Riesgos técnicos

### 1. Tres fuentes de schema que no coinciden

Docker solo monta `backend/sql/schema.sql` y `backend/sql/seeds.sql` (`docker-compose.yml`). `seeds.sql` está vacío a propósito: el admin y los proveedores los crea `backend/initDatabase.js` al arrancar. Las migraciones `backend/sql/migrations/001` a `018` no se aplican solas.

Columnas que el código usa, que una migración agrega, y que ni `schema.sql` ni `initDatabase.js` crean:

| Columna | La pide el código | Migración |
|---|---|---|
| `suppliers.markup_neggo`, `suppliers.markup_preventas` | `routes/suppliers.js`, `rulesEngine.js`, `ingresoService.js` | `005_markup_dual.sql` |
| `supplier_category_rules.markup_neggo_override`, `markup_preventas_override` | `routes/supplierRules.js` | `005_markup_dual.sql` |
| `ingreso_items.preventa_qty_confirmed` | `routes/ingreso.js`, `routes/preventas.js` | `003_preventa_qty_confirmed.sql` |
| `ingreso_items.match_level` | `ingresoService.js` (INSERT), `routes/ingreso.js` | `016_ingreso_match_level.sql` |
| `ingreso_mercaderia.odoo_purchase_order_id_preventas` | `ingresoService.confirmIngreso` | `004_ingreso_oc_preventas.sql` |
| `odoo_products_cache.template_id`, `has_image` | `jobs/odooSync.js`, `preventasSyncService.js` | `011_odoo_cache_image_template.sql` |
| `preventa_client_orders.pricelist_id` | `routes/preventas.js` | `018_pricelists.sql` |

`schema.sql` crea el índice `idx_pco_pricelist` sobre `preventa_client_orders(pricelist_id)` (línea 700) y el `CREATE TABLE` de esa tabla no incluye la columna. En un Postgres vacío, el entrypoint oficial corre los `.sql` con `ON_ERROR_STOP=1`: ese índice aborta el script. Un volumen ya migrado a mano no ve el problema. Un `docker compose` desde cero sí.

`initDatabase.js` parcha otra lista (categorías Odoo, `web_categ_*`, `preventas_sync_state`, `received_qty`, etc.) que tampoco está completa en `schema.sql`. Cualquier agente nuevo que asuma "el schema.sql es la base" va a chocar con esto.

### 2. Credenciales en el código de arranque

`backend/initDatabase.js` escribe en `suppliers.scrape_config` usuario/clave de Mali y un token de El Rey cuando el proveedor todavía no tiene config. La spec del Agente 14 repite el patrón: `competitors.login_password` como `VARCHAR` en claro. Conviene decidir un lugar único para secretos antes de sumar competidores.

### 3. Tests, lint y build

- No hay archivos `*.test.js` / `*.spec.js`, ni Jest, ni Vitest, ni un script `test` en ningún `package.json`. No hay una suite rota: no hay suite.
- No hay ESLint ni script `lint`. No hay un lint que esté fallando.
- `node --check` sobre todos los `.js` de `backend/` terminó sin errores de sintaxis.
- `npm run build` en `frontend/` (Vite 6.4.2) compiló. Aviso único de esbuild, en `frontend/src/pages/IngresoPreview.jsx` línea 1396: el `??` de `selected?.line_id === l.line_id ?? selected?.id === l.id` siempre se queda con el operando izquierdo por precedencia. El build igual sale en verde.
- Este relevamiento no ejecutó los tests de integración que el plan menciona para el sprint 4 de Fase 1, porque no existen.

### 4. UTF-8

Los `.js`, `.jsx`, `.sql`, `.py` y `.md` revisados decodifican como UTF-8. No apareció el mojibake típico (`Ã¡`, `Ã±`, `ï¿½`).

El archivo dañado es `CLAUDE.md`. Los primeros 5225 bytes son UTF-8 legible (convenciones del proyecto). A partir de ahí hay 1139 bytes NUL: un volcado UTF-16 LE de un objeto de PowerShell (`Invoke-WebRequest` contra un README, con `StatusCode`, `RawContent`, `ParsedHtml`). Por eso `file` lo ve como binario y varios lectores lo rechazan. El identificador `ImpoteknóScraper` en `backend/scrapers/impotekno.js` y `registry.js` es Unicode válido, y es frágil para imports y búsquedas.

### 5. Deuda de tamaño y de contrato

- `backend/routes/ingreso.js` (2722 líneas) y `frontend/src/pages/IngresoPreview.jsx` (2805) concentran el Agente 11. Un refactor hacia `invoice_imports` en medio de ese archivo es el mayor riesgo de regresión del roadmap.
- `App.jsx` sigue describiendo páginas reales como placeholders.
- El cron de Odoo corre cada hora (`scheduler.js`, `0 * * * *`) y `syncOdooProducts` baja el catálogo completo. La spec pide incremental por `write_date` cada 2 horas. El sync al arrancar también es completo.
- `activityLog` y el layout no conocen los módulos que se van a sumar: cada agente nuevo tiene que acordarse de los dos.

## Orden recomendado para los Agentes 10 a 14

El orden sigue dependencias técnicas, no el calendario del plan. El schema de los cinco ya está escrito; el trabajo es comportamiento.

| Orden | Agente | Tamaño | Por qué en ese lugar |
|---|---|---|---|
| 1 | 10 Ventas y clientes | Mediano. Un servicio, una ruta de unos 9 endpoints, tres páginas, un cron diario. El SQL ya está | `getSaleOrders` y los partners ya existen. Este agente les pone cache, clasificación y UI. La velocidad de venta que necesita el 14 sale de acá |
| 2 | 11 Ingreso, como cierre del módulo actual | Mediano-alto, y es el más riesgoso. No es un módulo nuevo: hay que tocar el archivo de 2700 líneas y la pantalla de 2800 | Ya parsea CSV, matchea y confirma. Terminarlo ahora evita que el 12 copie otro modelo de escaneo y de fotos |
| 3 | 12 Pedidos, picking y Kanban | Grande. Dos servicios, una ruta, tres pantallas (una pensada para tablet), sync de `sale.order` | Depende de Fase 1, que está. Reusa el cache, el lector USB del ingreso y, si el 10 ya corrió, la misma lectura de pedidos |
| 4 | 14 Compras inteligentes | Grande. Tres servicios, dos rutas, cinco pantallas, scrapers de competidores | Precio, mappings y stock ya están. La estacionalidad y los días de cobertura esperan las métricas del 10. El 13 no le aporta datos |
| 5 | 13 Marketing | Grande. Generación de imágenes, IA, calendario y templates. Puede avanzar en paralelo con el 14 después del 10 | El PDF y el storage ya existen. La spec lo encadena al 11 y al 12; el código no lo necesita para imágenes, captions y calendario |

El 13 y el 14 se pueden repartir después del 10. El 11 conviene cerrarlo antes del 12 para no duplicar barcode, fotos y estados.

### Decisiones del dueño antes de arrancar

1. **Fórmula vigente.** Confirmar que costo y venta siguen `rulesEngine.js` (flete 1,5% y markup sobre lista con flete, igual en Neggo y en Preventas) y actualizar la skill y el plan. La otra opción es volver a la fórmula escrita en `docs/skills/business-rules/SKILL.md`. Los agentes nuevos no deberían implementar las dos.
2. **Schema único.** Antes del primer agente nuevo, incorporar al `schema.sql` (o hacer que el arranque aplique `migrations/`) las columnas de la tabla de riesgos. Si no, el 10 nace sobre tablas que un volumen viejo puede no tener y un volumen nuevo puede no terminar de crear.
3. **Agente 10 — alcance de clientes.** Métricas de Neggo, de Preventas, o de las dos. Umbrales de VIP (top 20%), frecuente (15 días) e inactivo (30 días): si se mantienen como están en la spec. Si el dashboard convive con `GET /api/preventas/customers` o lo reemplaza para la búsqueda de pedidos.
4. **Agente 11 — no reescribir a ciegas.** Conservar `ingreso_mercaderia` / `ingreso_items` (lo que está en producción de código) o migrar a `invoice_imports`, que la spec propone y nadie usa. El cierre de hoy crea `purchase.order`; la spec pide `account.move`. Definir cuál de los dos es el comprobante correcto. OCR con GPT-4o-mini: la propia spec lo deja afuera; hace falta un sí explícito si se quiere en esta pasada. Fotos: seguir subiendo la imagen del scraper, o capturar con la cámara del celular.
5. **Agente 12 — operación de depósito.** Si la zona de picking es `categ_name` de Odoo u otro mapa. Si el Kanban se actualiza por polling o por el SSE que ya usa el scraping. Confirmar la regla "quien arma no controla". Si entran solo pedidos de la empresa Neggo.
6. **Agente 13 — marca e IA.** Confirmar que `OPENAI_API_KEY` se va a usar. Pasar logo y fuentes (la spec nombra Montserrat y Nunito; no están en el repo). Canales reales: Instagram, WhatsApp, Facebook, u otro.
7. **Agente 14 — competidores y secretos.** Lista inicial de competidores y si hace falta login. No guardar claves en `VARCHAR`: hoy `scrape_config` y `initDatabase.js` ya lo hacen, y la spec del 14 lo repite. Ventana de historia para estacionalidad (la spec dice 2 años de `sale.order`).
8. **CRM.** No hay que integrar `/api/agent/crm`. El 10 se apoya en `odooService` y en `/api/preventas/customers`. Si ese CRM existe en otro repositorio, hay que traer el contrato antes de diseñar contactos, envíos y seguimiento.
