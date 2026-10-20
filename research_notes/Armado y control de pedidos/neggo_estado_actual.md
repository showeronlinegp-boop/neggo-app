# Neggo App — estado actual vs. armado y control de pedidos

Notas de exploración (thoroughness: medium). Fecha: 2026-10-20.  
No se modificó código de aplicación. Alcance: cotizaciones/ventas Odoo, preventas, ingresos, reposición, WhatsApp, auth y writes peligrosos.

El módulo pedido (armado + control al estilo 2-step de Odoo, backorders, igualar qty enviada vs pedida, tracking hasta comprobante de pago, picker/checker) **no existe**. Hay un placeholder de schema del Agente 12 y piezas reutilizables alrededor.

---

## 1. Rutas y páginas existentes

### 1.1 Frontend (`frontend/src/App.jsx` + `Layout.jsx`)

| Ruta | Página | Roles en nav | Qué hace hoy |
|---|---|---|---|
| `/preventas/cotizaciones` | `frontend/src/pages/preventas/OdooQuotations.jsx` | admin, operador | Lista **solo lectura** de cotizaciones Odoo Preventas en estado `sent`. Muestra líneas, monto, badge de ingreso comprometido. No confirma, no edita, no arma. |
| `/preventas/ordenes-odoo` | `frontend/src/pages/preventas/OdooSupplierBreakdown.jsx` | admin, operador | Las mismas cotizaciones `sent`, agrupadas por proveedor. Genera PDF de pedido a proveedor (Puppeteer). |
| `/preventas/pedidos` | `frontend/src/pages/preventas/ClientOrders.jsx` | admin, vendedor, operador | Pedidos locales (`preventa_client_orders`). Crear, editar ítems Neggo/Preventas, enviar a Odoo como `sale.order` (draft), confirmar (`action_confirm`), archivar producto Neggo, marcar reponer. |
| `/preventas/ordenes` | `frontend/src/pages/preventas/SupplierOrders.jsx` | admin, operador | Órdenes a proveedores locales → `purchase.order` en Odoo Preventas. |
| `/preventas/listas-precios` | `PricelistManager.jsx` | admin | Listas especiales de cliente. |
| `/preventas/catalogos` | `Catalogs.jsx` | admin, vendedor | PDF de catálogo. |
| `/productos/sync-preventas` | `PreventasSyncPage.jsx` | admin | Sync scraper ↔ Odoo Preventas (incluye inactivar en bloque por proveedor). |
| `/ingreso` | `IngresoList.jsx` | admin, operador | Lista de comprobantes de proveedor (factura / remito / nota). |
| `/ingreso/new` | `IngresoUpload.jsx` | admin, operador | Alta por CSV. |
| `/ingreso/:ingresoId` | `IngresoPreview.jsx` | admin, operador | Match vs Odoo, control físico con lector USB, match vs cotizaciones Preventas `sent`, confirmar (crea `purchase.order`, no factura). WhatsApp de producto (admin). |
| `/reposicion` | `frontend/src/pages/reposicion/Reposicion.jsx` + `ReposicionProveedorModal.jsx` | admin, operador | Cola Neggo: pendiente / encargado / resueltos. Archivar, activar, reponer. |
| `/admin/odoo-products` | `OdooProducts.jsx` | admin (nav admin) | Listado cache Odoo; archivar/activar (Neggo pasa por `/reposicion/archivar`). |
| `/admin/whatsapp` | `WhatsAppPublish.jsx` | admin | Cola de **publicación de productos** a grupos (Evolution API). No es mensajería 1:1 al cliente. |
| `/actividad` | `ActivityLog.jsx` | admin | Consulta `activity_log`. |

**No hay** `/pedidos/kanban`, `/pedidos/picking`, `/pedidos/:id/control`. El Agente 12 las especifica en `docs/agents/12-orders-kanban.md` y `docs/estado-implementacion.md` las marca como placeholder.

`ProtectedRoute` solo exige login. El filtro de rol es de navegación, no de ruta.

### 1.2 APIs backend relevantes

Montaje en `backend/server.js`: `/api/preventas`, `/api/ingreso`, `/api/reposicion`, `/api/products`, `/api/whatsapp`, `/api/activity-log`.

**Cotizaciones Odoo (Preventas, lectura)** — `backend/routes/preventas.js`

- `GET /api/preventas/odoo-quotations` — `getPreventasQuotations(['sent'])`
- `GET /api/preventas/odoo-quotations/by-supplier` — igual + agrupado
- `POST /api/preventas/odoo-quotations/pdf` — PDF de pedido a proveedor (no cotización al cliente)
- `GET /api/preventas/ingreso-commitments` — qty de ingreso ya comprometida contra productos Preventas

**Pedidos de clientes (preventas locales)** — mismo archivo

- `GET/POST /api/preventas/customers` — partners Odoo Preventas (crear partner global)
- `GET /api/preventas/customers/:id`
- `POST/GET /api/preventas/client-orders`
- `GET/PUT /api/preventas/client-orders/:id`
- `POST /api/preventas/client-orders/:id/items`
- `PUT/DELETE /api/preventas/client-orders/:id/items/:itemId`
- `DELETE /api/preventas/client-orders/:id` — **cancela** `sale.order` Neggo y/o Preventas y borra el pedido local
- `POST /api/preventas/client-orders/:id/send-to-odoo` — crea `sale.order` draft (split Neggo / Preventas)
- `POST /api/preventas/client-orders/:id/confirm` — `action_confirm` en ambas empresas

Casi todos estos endpoints son `authenticate` **sin** `requireRole`. Cualquier usuario logueado (incluido vendedor) puede crear, confirmar y cancelar órdenes en Odoo.

**Reposición (solo empresa Neggo)** — `backend/routes/reposicion.js`  
`authenticate` + `requireRole('admin', 'operador')`

- `GET /api/reposicion?estado=pendiente|encargado|resueltos`
- `GET /api/reposicion/buscar?q=`
- `GET /api/reposicion/proveedores`
- `GET /api/reposicion/proveedor?nombre=`
- `POST /api/reposicion` — `{ odoo_id, nota? }` marca “reponer”
- `POST /api/reposicion/archivar` — archiva en Odoo + encola como agotado
- `POST /api/reposicion/activar` — desarchiva en Odoo + cierra cola
- `PATCH /api/reposicion/:id` — `{ estado, qty_decidida?, nota? }` (`pendiente` / `encargado` / `repuesto` / `descartado`)

**Archivo de productos**

- `PATCH /api/products/odoo/:odooId/archive` — body `{ company, archived }`  
  Auth: cualquier usuario autenticado (sin `requireRole`). Escribe Odoo + `locally_archived` en cache. Si `company=neggo` y se archiva, entra a reposición.

**Ingreso** — `backend/routes/ingreso.js` (muy grande). Writes Odoo (crear producto, precios, OC, foto, supplierinfo) van con `requireRole('admin')`. Lectura/match/control físico: autenticado. Match vs cotizaciones: `GET /:id/preventa-odoo-match` usa `getPreventasQuotations(['sent'])`.

### 1.3 Schema placeholder del Agente 12 (sin código)

En `backend/sql/schema.sql` existen tablas **sin servicios ni rutas**:

- `neggo_orders` — `odoo_sale_order_id`, status `nuevo|armando|armado|controlando|controlado|despachado`, `assembled_by/at`, `checked_by/at`, `dispatched_at`
- `neggo_order_items` — qty ordered/picked/checked, barcode, category (zona)
- `neggo_picking_sessions` — picking grupal por zona

Eso cubre picker/checker en papel, no 2-step de Odoo, no backorder, no igualar qty, no comprobante.

---

## 2. Qué puede hacer `odooService.js`

Archivo: `backend/services/odooService.js`. Multi-empresa vía `resolveCompanyId('neggo' | 'preventas')` + `allowed_company_ids`. En `backend/config/odoo.js`, Preventas se matchea por nombre `/preventa|precompra/i` (en Odoo se llama **Precompras**) o `ODOO_PREVENTAS_COMPANY_ID`.

### Exportadas (nombres reales)

**Productos**

- `getProducts(companyKey, { offset, limit, search, category })` — solo `active=true`
- `getProductById(productId, companyKey)`
- `updateProductPrices(productId, cost, salePrice, companyKey, categId?)` — **write** `standard_price`, `list_price`
- `updateProductQty(productId, quantityDelta, companyKey)` — **write** `qty_available` (campo computado; **no se usa** en el resto del código; no es el camino de stock de Odoo)
- `createProduct(values, companyKey)` — crea `product.template` + variante
- `getProductCategories(companyKey)`
- `setProductArchived(odooProductId, companyKey, archived=true)` — `action_archive` / `action_unarchive` en `product.template`

**Partners**

- `getPartners({ type, search })`
- `getPartnerById(partnerId)`
- `getCustomers(companyKey, { search, limit })`
- `getCustomerById(partnerId, companyKey)`
- `createCustomer(data, companyKey)` — partner **global** (`company_id: false`)
- `ensurePartner(partnerId, partnerName, companyKey)` — puede **write** `company_id: false` o crear otro partner

**Órdenes de venta**

- `createSaleOrder(partnerId, lines, companyKey)` — `sale.order` create (queda **draft**)
- `updateSaleOrderLines(odooOrderId, lines, companyKey)` — borra todas las líneas `(5,0,0)` y reescribe. Comentario: solo válido en draft
- `confirmSaleOrder(odooOrderId, companyKey)` — `action_confirm` (draft → `sale`)
- `cancelSaleOrder(odooOrderId, companyKey)` — `action_cancel`
- `getSaleOrders(partnerId, { status, from, to })` — lectura por partner, **sin companyKey**, limit 100. **Ningún caller** en el repo
- `getPreventasQuotations(states=['draft','sent'])` — lectura paginada **solo empresa Preventas**. Normaliza líneas; omite líneas sin `product_id`

**Órdenes de compra**

- `createPurchaseOrder(partnerId, lines, companyKey)`
- `addLinesToPurchaseOrder(orderId, lines, companyKey)`
- `confirmPurchaseOrder(orderId, companyKey)` — exportada, **ningún caller**

**Helpers**

- `getWeeklySoldQty(companyKey='neggo')` — suma `sale.order.line` en `sale`/`done` (7 días) + `pos.order.line` si existe. Lo usa reposición
- `readAllPages`, `normalizeQuotationLine`, `sumQtyByProduct`

### Lo que **no** hay en odooService

- `stock.picking`, `stock.move`, `stock.quant`, `qty_delivered`, `qty_invoiced`
- `account.move`, facturas, pagos, comprobantes AFIP
- `action_quotation_send`, `message_post`, mail
- Confirmar/validar pickings, backorders, `button_validate`, `action_assign`
- Lectura de cotizaciones/órdenes de la empresa **Neggo** (solo Preventas en `getPreventasQuotations`; `getSaleOrders` no filtra empresa y no se usa)
- Igualar cantidad pedida vs enviada (write de `product_uom_qty` línea a línea; hoy solo reemplazo total de líneas en draft)

---

## 3. Estados de venta/cotización hoy

### 3.1 Pedido local (Preventas App)

Tabla `preventa_client_orders.status`:

| Estado local | Cómo se llega | Efecto Odoo |
|---|---|---|
| `pendiente` | Alta | Nada |
| `cotizacion` | `POST .../send-to-odoo` | Crea 0–2 `sale.order` **draft**: `neggo_sale_order_id` (ítems `odoo_company=neggo`) y/o `odoo_sale_order_id` (Preventas o sin company). Si el pedido ya está en `cotizacion`, add/edit/delete de ítems llama `updateSaleOrderLines` (reescritura total). |
| `confirmado` | `POST .../confirm` | `action_confirm` en las órdenes existentes. UI cierra edición. |
| `cancelado` | UI lo reconoce; delete del pedido llama `cancelSaleOrder` y **borra** el registro local | `action_cancel` |

No hay estados posteriores: armado, control, despacho, facturado, pagado, comprobante enviado.

`send-to-odoo` **no** pone la cotización en `sent` de Odoo. Las pantallas `OdooQuotations` / `OdooSupplierBreakdown` / match de ingreso leen cotizaciones que alguien marcó **Enviada** en Odoo (`state=sent`). Los pedidos creados desde la app, mientras siguen draft, **no aparecen** ahí.

Confirmación: `draft` → `sale`. Si Odoo tiene 2-step delivery configurado, `action_confirm` probablemente crea pickings en Odoo; la app **no los lee ni los controla**.

### 3.2 Cotizaciones leídas de Odoo

`getPreventasQuotations` acepta cualquier lista de states; callers reales pasan `['sent']` (UI cotizaciones, breakdown, ingreso match, supplement OC). Default de la función (`draft+sent`) no se usa en rutas.

Campos de línea: `id, product_id, product_name, external_id, quantity (product_uom_qty), unit_price, subtotal`. **No** `qty_delivered`.

### 3.3 ¿Hay `stock.picking`?

**No.** Cero matches de `stock.picking`, `stock.move`, `stock.quant`, `qty_delivered`, `backorder` en JS/JSX. El “control” con barcode existe solo en **ingreso de mercadería** (`barcodeBuffer` en `IngresoPreview.jsx`), contra ítems de factura de proveedor, no contra un pedido de cliente.

### 3.4 ¿Hay factura / comprobante al cliente?

**No.**

- `account.move` aparece en specs (`docs/agents/11-inventory-intake.md`, `docs/plan-maestro.md`) y en el diagnóstico: el ingreso **no** crea factura de compra; crea `purchase.order`.
- “Comprobante” en ingreso = tipo de documento del **proveedor** (`factura` | `remito` | `nota`) + número. No es comprobante de pago al cliente.
- PDF de preventas: catálogo, orden a proveedor, breakdown. No hay PDF de factura/recibo al cliente.
- WhatsApp (Evolution): publica **productos** a grupos (Admin → WhatsApp; botón en ingreso para admin). No envía cotización, remito ni comprobante 1:1.

Agente 10 (CRM/métricas de clientes) también es placeholder: tablas `client_metrics_cache`, `client_notes`, `client_reminders` sin servicios.

---

## 4. Auth, roles y activity log

### Roles

`users.role`: `admin` | `operador` | `vendedor` (`backend/routes/users.js`, UI `Users.jsx`). Default: `operador`.

| Superficie | admin | operador | vendedor |
|---|---|---|---|
| Pedidos clientes / send-to-odoo / confirm / cancel | sí (API abierta a cualquier login) | sí | sí (nav + API) |
| Cotizaciones Odoo, pedidos x proveedor, reposición, ingreso (UI) | sí | sí | no (nav) |
| Archivar producto `PATCH /products/odoo/:id/archive` | sí | sí (si conoce la URL) | sí (API sin requireRole) |
| Reposición API | sí | sí | 403 |
| WhatsApp API y publicación desde ingreso | sí | no | no |
| Writes pesados de ingreso (OC, crear producto Odoo, precios) | sí | no (403) | no |
| Activity log UI | sí | no | no |
| Sync Preventas apply / inactivar | sí | no | no |

No hay rol “picker” / “checker”. El Agente 12 propone reutilizar `users.id` en `assembled_by` / `checked_by` y **prohibir** que el mismo user arme y controle.

### Activity log

Middleware global `backend/middleware/activityLog.js` sobre `/api`:

- Loguea si hay `req.user` y el método **no es GET** (salvo login y `/run` de scraping).
- Inserta `user_id, module, action=HTTP method, entity_type/id parseados de la URL, metadata {path, status, duration_ms}, ip`.
- Mapa de módulos: auth, users, suppliers, scraping, products, mappings, alerts, preventas, catalogs, reposicion. **ingreso, whatsapp, pricelists, preventas-sync caen en `general`.**
- Lectura: `GET /api/activity-log` (solo admin). Dashboard pide últimos 5.

Inserts explícitos (más semánticos que el middleware):

- `ingresoService.confirmIngreso` → module `ingreso_mercaderia`, action `CONFIRM`
- `priceAlertService` al aplicar/descartar alertas
- `productMappings` al crear/desactivar vínculo

Patrón a copiar para armado: insert explícito con `module` propio (`armado_pedidos` o similar), `action` de negocio (`START_PICK`, `FINISH_CHECK`, …), `entity_type/id`, metadata (qty, odoo ids). El middleware solo deja rastro HTTP.

---

## 5. Gaps vs. el módulo pedido

Pedido: replicar 2-step shipping de Odoo (armado + control), archivar/reponer productos en el camino, backorders, igualar qty enviada vs pedida en Odoo, tracking desde cotización enviada hasta mandar comprobante de pago al cliente, registrar picker y checker.

| Capacidad | Hoy | Gap |
|---|---|---|
| Origen de trabajo = cotización **enviada** (`sent`) | UI lee `sent` de Preventas; pedidos de la app quedan `draft` hasta confirmar | Decidir fuente: ¿Odoo `sent` (Neggo y/o Preventas), o `sale` post-confirm, o `preventa_client_orders`? La app no marca `sent`. |
| 2-step (pick + pack/control) | Schema Agente 12 (picking grupal por **zona de categoría**, no 2-step de Odoo). Cero código | Servicio, rutas, UI tablet. Integrar o no con `stock.picking` reales de Odoo. |
| Picker ≠ checker | Campos en DDL, no usados | Regla + UI. |
| Sync de `sale.order` confirmados a tabla local | Spec 12: `syncOrdersFromOdoo` cada 30 min | No implementado. `getSaleOrders` existe y no se usa; no lista por empresa/estado masivo. |
| Archivar / reponer si falta stock al armar | ClientOrders, OdooProducts, Reposición, WhatsApp picker ya llaman archive/reposicion | Reutilizar `setProductArchived` + `reposicion.archivarYEncolar` / `agregarReponer` desde el flujo de armado. No está enganchado a un pedido. |
| Backorder | Nada | Ni Odoo (`stock.picking` backorder) ni local (qty parcial + resto pendiente). |
| Igualar qty enviada vs pedida en Odoo | `updateSaleOrderLines` solo en **draft**, reemplazo total | Falta write línea a línea post-confirm (`product_uom_qty` y/o `qty_delivered`), o cancelar/backorder. Confirmar y después achicar líneas es operación distinta y riesgosa. |
| Tracking hasta comprobante de pago | Se corta en `confirmado` | Estados: controlado, despachado, facturado, pagado, comprobante enviado. |
| Enviar comprobante al cliente | WhatsApp = marketing a grupos | Ni `account.move` ni PDF de recibo ni WhatsApp 1:1. Habría que extender Evolution o otro canal. |
| Lectura de órdenes Neggo | Cotizaciones UI = solo Preventas | Armado de pedidos de mostrador Neggo no tiene lista equivalente. |
| Escaneo barcode | IngresoPreview USB-as-keyboard | Reusar patrón; no extraer a hook compartido. |
| Kanban | Spec 12 | No hay. |

Reutilizable sin reinventar: `odoo_products_cache` (barcode, imagen, categ), `setProductArchived`, cola `reposicion_items`, `confirmSaleOrder` / `createSaleOrder` (con cuidado), `getPreventasQuotations` (extender a Neggo + states `sale`), lector USB, activity_log, users.

Peligro de copiar el Agente 12 tal cual: su diseño es picking grupal por zona de depósito, no 2-step Odoo, no backorder, no factura. El DDL se puede reusar para picker/checker; el flujo pedido es más largo.

---

## 6. Writes peligrosos en Odoo (candidatos a reusar)

Todo pasa por el mismo `callOdoo` (`execute_kw` + API key). Un bug escribe producción.

### Ya en `odooService` (API “limpia”)

| Función | Write | Usado por | Riesgo para armado |
|---|---|---|---|
| `createSaleOrder` | create `sale.order` + líneas | `send-to-odoo` | Crea draft. Si se confirma, Odoo puede generar pickings. |
| `updateSaleOrderLines` | `write` order_line `(5,0,0)` + altas | sync de ítems en status `cotizacion` | **Muy peligroso** post-confirm: borra todas las líneas. Solo reusar en draft. Para igualar qty hace falta un write por línea, no este helper. |
| `confirmSaleOrder` | `action_confirm` | `POST .../confirm` | Dispara stock/pickings/reservas en Odoo. Idempotencia: confirmar dos veces falla. |
| `cancelSaleOrder` | `action_cancel` | DELETE client-order | Cancela venta (y pickings asociados si Odoo lo permite). Irreversible a nivel negocio. |
| `setProductArchived` | archive template + variantes | reposición, products archive, ClientOrders, WhatsApp | Saca el producto de venta/POS. Reusar para “no hay stock → archivar + cola”. |
| `updateProductPrices` | cost + list_price | ingreso confirm, price alerts | No hace falta para armado; no tocarlo. |
| `updateProductQty` | write `qty_available` | **nadie** | **No reusar.** En Odoo 19 el disponible es computado; un write así es incorrecto. Stock sale por pickings/quants. |
| `createProduct` | template + variante | ingreso create-odoo (admin) | Fuera de alcance armado. |
| `createPurchaseOrder` / `addLinesToPurchaseOrder` | OC proveedor | ingreso, preventas supplier orders | Compra, no venta. |
| `confirmPurchaseOrder` | `action_confirm` PO | nadie | No usar. |
| `ensurePartner` | puede `write company_id=false` o crear partner duplicado | send-to-odoo | Efecto colateral en maestros de clientes. |

### Writes fuera de odooService (mismo `callOdoo`)

- **Preventas sync** (`preventasSyncService.ejecutarAccion`): `product.template` `active=false`, `action_unarchive`, write precio/categ/`default_code`, create productos, write imagen. Bulk inactivar **exige** elegir proveedor.
- **Ingreso**: write imagen, barcode, default_code, categ web, `product.supplierinfo` create, precios, create product, create/add PO.
- **supplierDeleteService**: `product.supplierinfo` write partner + **unlink**.
- **preventasSync assign-vendor**: create `product.supplierinfo`.

### Writes que **haría falta** y no existen

Para igualar enviado vs pedido y 2-step, alguien tendría que llamar (aún no hay wrappers):

- `stock.picking`: `action_assign`, `button_validate`, manejo de backorder wizard
- `sale.order.line` write de `product_uom_qty` (o unlocking delivered)
- posiblemente `qty_delivered` (suele ser related/computed desde pickings)
- `account.move` create / `action_post` / envío

Hasta que existan, el camino “seguro” es: armar/controlar **en Neggo App** sobre una copia local, y al cerrar control escribir Odoo con una función **nueva y estrecha**, no `updateSaleOrderLines`.

### Superficies fáciles de disparar por error

1. `DELETE /api/preventas/client-orders/:id` — cancela en Odoo (Neggo y Preventas) y borra local. Auth: cualquier login.
2. `PATCH /api/products/odoo/:odooId/archive` — archiva template. Auth: cualquier login. Company default `neggo`.
3. `POST /api/reposicion/archivar` y `/activar` — operador/admin, escribe Odoo Neggo.
4. `POST .../confirm` — confirma sale orders; no hay sync posterior del estado Odoo si alguien confirma/cancela en Odoo a mano.

---

## Mapa mental del flujo actual (para no mezclarlo)

```
Cliente (preventas app)
  pendiente → send-to-odoo → draft sale.order (Neggo y/o Preventas)
           → confirm → sale
  [fin]

Cotización Enviada en Odoo Preventas (hecha en Odoo, no en la app)
  → pantalla Cotizaciones / Pedidos x proveedor / match en Ingreso
  → no hay armado ni factura

Ingreso proveedor
  CSV/factura → match productos → (admin) purchase.order Neggo/Preventas
  barcode = control de mercadería que entra, no de pedido que sale

Reposición Neggo
  archivar Odoo / “queda poco” → cola pendiente|encargado → repuesto|descartado

WhatsApp
  cola de posts a grupos con foto+precio de producto
```

El módulo nuevo se insertaría **después** de cotización enviada / orden confirmada, **antes** de “el cliente ya pagó y tiene comprobante”, y tendría que hablar con reposición cuando un ítem no se puede armar.

---

## Archivos índice (para el siguiente diseño)

- `backend/services/odooService.js`
- `backend/config/odoo.js`
- `backend/routes/preventas.js`
- `backend/routes/reposicion.js` + `backend/services/reposicionService.js`
- `backend/routes/products.js` (archive)
- `backend/routes/ingreso.js` + `IngresoPreview.jsx` (barcode, match cotizaciones)
- `frontend/src/pages/preventas/ClientOrders.jsx`
- `frontend/src/pages/preventas/OdooQuotations.jsx`
- `docs/agents/12-orders-kanban.md` (spec distinta, DDL reutilizable)
- `docs/skills/odoo-integration/SKILL.md` (states sale.order: draft, sent, sale, done, cancel)
- `docs/estado-implementacion.md` (Agente 12 = placeholder)
- `backend/sql/schema.sql` (`neggo_orders*`)
- `backend/middleware/activityLog.js` + `backend/middleware/auth.js`
