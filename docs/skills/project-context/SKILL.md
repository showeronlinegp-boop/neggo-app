---
name: project-context
description: Contexto de negocio de Neggo Mayorista. Leer SIEMPRE antes de cualquier implementación. Cubre las dos empresas (Neggo y Preventas), roles de usuario, proveedores, y flujos operativos principales.
---

# Contexto del proyecto Neggo App

## El negocio

Neggo Mayorista es un distribuidor multi-rubro (librería, juguetes, accesorios de celular, moda, perfumería) con base en Pergamino, Buenos Aires, Argentina. Opera desde un depósito y un local físico, con 2-5 empleados.

## Dos empresas en Odoo

Neggo opera con **dos empresas** configuradas en Odoo 19 (plan Custom, neggo.odoo.com):

### Empresa Neggo
- Stock propio en depósito
- Compra mercadería, la almacena y la revende
- Los productos tienen referencia interna con prefijo del proveedor (ej: `CAST-VT500`)
- Fórmula de precios: `costo = precio_proveedor × (1 - descuento%)`, `venta = costo × (1 + markup%)`

### Empresa Preventas
- Crossdocking: no tiene stock, revende directamente de importadores
- Los productos tienen referencia interna con prefijo `PRE` + prefijo proveedor (ej: `PRECAST-VT500`)
- Fórmula de precios: `costo = precio_proveedor × (1 - descuento%)`, `venta = precio_proveedor × (1 + markup%)`
- **Diferencia clave**: en Preventas el markup se aplica sobre el precio del proveedor, no sobre el costo

### Solapamiento
- Los proveedores son los mismos para ambas empresas
- Un producto puede existir en ambas empresas con distintos precios
- Un producto puede tener múltiples proveedores

## Proveedores (10-30)

Mayoristas/importadores argentinos con webs scrapeables. Cada proveedor tiene:
- **Prefijo único** (ej: CAST, MALI, IMP, REY)
- **Descuento global** por defecto (% sobre precio de lista)
- **Markup global** por defecto (% de ganancia)
- **Reglas por categoría** que sobreescriben los valores globales
- **Formato de precio**: argentino (1.000,00) o inverso (1,000.00)
- **Flag "Se publica"**: si los productos aparecen en catálogos

Los scrapers actuales son Selenium + Chrome, corriendo en Windows. Se migran a Puppeteer + browserless/chrome en Docker.

## Usuarios y roles

| Rol | Acceso |
|-----|--------|
| admin | Todo. Gestión de usuarios, reglas, configuración |
| operador | Pedidos, armado, control, ingreso mercadería |
| vendedor | Ventas, clientes, catálogos, preventas |

## Flujos operativos principales

### Flujo de Preventas (prioridad 1)
1. Scrapers actualizan catálogo de proveedores
2. Cliente pide productos (por WhatsApp, presencial)
3. Operador carga pedido del cliente en la app
4. App agrupa items por proveedor → genera órdenes de compra
5. Se envía OC a Odoo como purchase.order
6. Se genera catálogo PDF para difundir a clientes

### Flujo de alertas de precio
1. Scraper detecta cambio de precio
2. Sistema registra en historial y crea alerta
3. Admin revisa alerta con comparativa entre proveedores
4. Admin aprueba (actualiza Odoo) o descarta

### Flujo de matching de productos
1. Scraper trae productos con SKU/código
2. Sistema intenta match automático por referencia interna (prefijo + código)
3. Si no matchea, intenta fuzzy matching por nombre
4. Los que no matchean quedan pendientes para vinculación manual

## Módulos de Odoo activos
- Inventario/Stock
- Ventas/Cotizaciones
- Compras
- Facturación/Contabilidad

## Acceso desde dispositivos
La app corre en Docker en una PC Windows (16GB RAM) en red WiFi local. Se accede desde celulares, tablets y PCs via `http://IP_FIJA:80`. La app es una PWA instalable.
