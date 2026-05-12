# Agente 07 — Módulo Preventas

## Objetivo
Implementar el flujo completo de Preventas: carga de pedidos de clientes, generación de órdenes a proveedores, envío a Odoo, y generación de catálogos PDF.

## Skills a leer
- `docs/skills/business-rules/SKILL.md` (fórmula Preventas)
- `docs/skills/odoo-integration/SKILL.md` (crear purchase.order)
- `docs/skills/project-context/SKILL.md` (flujo de Preventas)

## Dependencias
- Agentes 01-06 completados

## Tareas

### 1. Pedidos de clientes
Crear `backend/routes/preventas.js` y `backend/services/preventasService.js`:

**Carga de pedidos:**
- `POST /api/preventas/client-orders` — Crear pedido con datos del cliente
- `POST /api/preventas/client-orders/:id/items` — Agregar item al pedido (seleccionar de supplier_products, calcular precio con rulesEngine para empresa 'preventas')
- `GET /api/preventas/client-orders` — Lista con filtros (status, search, fecha)
- `GET /api/preventas/client-orders/:id` — Detalle con items e imágenes
- `PUT /api/preventas/client-orders/:id` — Actualizar status/notas

### 2. Generación de órdenes a proveedores
- `POST /api/preventas/generate-supplier-orders` — Body: { clientOrderIds: [1,2,3] }
  - Agrupa todos los items de los pedidos seleccionados por proveedor
  - Crea preventa_supplier_orders con sus items
  - Vincula cada item con su client_order_item (trazabilidad)
  - Retorna resumen: N órdenes generadas para N proveedores

### 3. Gestión de órdenes a proveedores
- `GET /api/preventas/supplier-orders` — Lista con filtros (supplier, status)
- `PUT /api/preventas/supplier-orders/:id` — Actualizar status
- `POST /api/preventas/supplier-orders/:id/send-to-odoo` — Crea purchase.order en Odoo via odooService.createPurchaseOrder() con company = preventas. Guarda el odoo_purchase_order_id

### 4. Generador de catálogos PDF
Crear `backend/services/catalogService.js`:
- `generateCatalog({ type, supplierId, category })` — Genera PDF con PDFKit
- Layout: 4 productos por página, logo Neggo, nombre + código + imagen + precio
- Los precios se calculan con rulesEngine para la empresa correspondiente
- Guardar PDF en /storage/catalogs/ y registrar en tabla catalogs

Rutas:
- `POST /api/catalogs/generate` — Body: { type, supplierId, category }
- `GET /api/catalogs` — Lista de catálogos generados
- `GET /api/catalogs/:id/download` — Descarga del PDF

### 5. Listado de compras por proveedor
- `GET /api/preventas/shopping-list/:supplierId` — Genera listado consolidado de todos los items pendientes de compra para un proveedor, agrupado por producto con cantidades sumadas

## Criterios de éxito
- [ ] Se puede crear un pedido de cliente y agregar items con imágenes
- [ ] Los precios se calculan correctamente con fórmula Preventas
- [ ] La generación de OC agrupa items por proveedor correctamente
- [ ] El envío a Odoo crea purchase.order visible en el ERP
- [ ] El catálogo PDF se genera con layout correcto (4 por página, logo, precios)
- [ ] La trazabilidad item-cliente → item-proveedor funciona
