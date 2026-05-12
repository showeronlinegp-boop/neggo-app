---
name: database-schema
description: Referencia rápida del schema de PostgreSQL del proyecto Neggo App. Leer antes de escribir cualquier query, crear tablas, o diseñar endpoints que lean/escriban datos. El SQL completo está en backend/sql/schema.sql.
---

# Database schema — Referencia rápida

El DDL completo está en `backend/sql/schema.sql`. Esta skill es un mapa rápido de las tablas y sus relaciones.

## Tablas core

| Tabla | Propósito | Relaciones clave |
|-------|-----------|-----------------|
| `users` | Usuarios de la app | — |
| `activity_log` | Registro de cada acción | → users |

## Tablas de proveedores y reglas

| Tabla | Propósito | Relaciones clave |
|-------|-----------|-----------------|
| `suppliers` | Proveedores (Cast, Mali, etc.) | — |
| `supplier_category_rules` | Reglas de dto/markup por categoría | → suppliers |

**Cascada de reglas**: `supplier_category_rules.discount_override` > `suppliers.default_discount`. Si el override es NULL, se usa el default del proveedor. Igual para markup.

## Tablas de productos scrapeados

| Tabla | Propósito | Relaciones clave |
|-------|-----------|-----------------|
| `supplier_products` | Productos obtenidos del scraping | → suppliers |
| `price_history` | Historial de cambios de precio | → supplier_products |
| `price_alerts` | Alertas de cambio pendientes de revisión | → supplier_products, → users |
| `scraping_runs` | Log de ejecuciones de scrapers | → suppliers, → users |

**Unique constraint**: `supplier_products(supplier_id, sku)` — un SKU es único por proveedor.

## Tablas de vínculos con Odoo

| Tabla | Propósito | Relaciones clave |
|-------|-----------|-----------------|
| `product_mappings` | Vínculo N:N entre producto scrapeado y producto Odoo | → supplier_products |
| `odoo_products_cache` | Cache local de productos de Odoo | — (sync periódico) |

**Multi-empresa**: `product_mappings.odoo_company` es 'neggo' o 'preventas'. `odoo_products_cache.company` idem.
**Unique constraint**: `product_mappings(supplier_product_id, odoo_product_id, odoo_company)`.

## Tablas de Preventas

| Tabla | Propósito | Relaciones clave |
|-------|-----------|-----------------|
| `preventa_client_orders` | Pedidos de clientes | → users |
| `preventa_client_order_items` | Items de cada pedido | → client_orders, → supplier_products |
| `preventa_supplier_orders` | Órdenes de compra a proveedores | → suppliers, → users |
| `preventa_supplier_order_items` | Items de cada OC | → supplier_orders, → supplier_products, → client_order_items |
| `catalogs` | Catálogos PDF generados | → suppliers, → users |

**Trazabilidad**: `preventa_supplier_order_items.client_order_item_id` vincula cada item comprado al pedido del cliente original.

## Campos comunes

Todas las tablas tienen:
- `id SERIAL PRIMARY KEY`
- `created_at TIMESTAMP DEFAULT NOW()`

Las que se editan también tienen `updated_at TIMESTAMP DEFAULT NOW()`.

## Índices

Cada foreign key tiene un índice explícito. Además:
- `supplier_products(name)` — para búsqueda por nombre
- `supplier_products(sku)` — para matching por código
- `odoo_products_cache(internal_ref)` — para matching por referencia
- `odoo_products_cache(name)` — para búsqueda
- `price_alerts(status)` — para filtrar pendientes
- `activity_log(created_at DESC)` — para paginación temporal
