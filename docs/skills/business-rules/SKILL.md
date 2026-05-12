---
name: business-rules
description: Reglas de negocio para cálculo de precios, matching de productos y gestión de proveedores. Leer antes de implementar cualquier cálculo de costo/precio, matching automático, o lógica de alertas.
---

# Reglas de negocio

## Cálculo de precios

### Cascada de reglas
1. Se busca la regla de categoría específica para el proveedor + categoría del producto
2. Si existe y tiene `discount_override` → usar ese descuento. Si no → usar `default_discount` del proveedor
3. Igual para markup: `markup_override` > `default_markup`

### Fórmulas por empresa

```
NEGGO:
  costo = precio_proveedor × (1 - descuento / 100)
  precio_venta = costo × (1 + markup / 100)
  precio_venta = REDONDEAR_ARRIBA(precio_venta)  // Math.ceil

PREVENTAS:
  costo = precio_proveedor × (1 - descuento / 100)
  precio_venta = precio_proveedor × (1 + markup / 100)
  precio_venta = REDONDEAR_ARRIBA(precio_venta)  // Math.ceil
```

### Ejemplo numérico
Proveedor Cast, categoría "Vasos Térmicos":
- Precio proveedor: $10.000
- Descuento categoría: 15%
- Markup categoría: 40%

```
NEGGO:
  costo = 10000 × 0.85 = $8.500
  venta = 8500 × 1.40 = $11.900

PREVENTAS:
  costo = 10000 × 0.85 = $8.500
  venta = 10000 × 1.40 = $14.000
```

### Parseo de precios
Formato argentino (default): "1.200,50" → remover puntos, coma por punto → 1200.50
Formato inverso: "1,200.50" → remover comas → 1200.50

```javascript
function parsePrice(text, format) {
    const s = String(text).replace('$', '').trim();
    if (format === 'inv') return parseFloat(s.replace(/,/g, ''));
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}
```

## Matching de productos

### Nivel 1: Match por referencia interna (confianza: 1.0)
- Extraer prefijo del proveedor del campo `internal_ref` del producto Odoo
- Si Odoo tiene `CAST-VT500` y el scraper trae SKU `VT500` del proveedor Cast → match
- Para Preventas: `PRECAST-VT500` → extraer después de `PRE` + prefijo → `VT500` → match

```javascript
function matchByRef(odooRef, supplierPrefix, supplierSku) {
    if (!odooRef || !supplierSku) return false;
    const cleanRef = odooRef.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanSku = supplierSku.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prefix = supplierPrefix.toUpperCase();
    // Match directo: REF contiene PREFIX+SKU
    return cleanRef.includes(prefix + cleanSku);
}
```

### Nivel 2: Match por nombre (confianza: 0.5-0.9)
- Normalizar ambos nombres (lowercase, quitar acentos, quitar caracteres especiales)
- Calcular similitud con algoritmo de Levenshtein o trigram matching
- Umbral mínimo: 0.7 para sugerir, 0.9 para auto-vincular
- Siempre requiere revisión humana si < 0.9

### Nivel 3: Match manual (confianza: 1.0)
- El usuario vincula manualmente desde la UI
- Se guarda con `match_type = 'manual'`

## Alertas de precio

### Tipos de alerta
| Tipo | Condición |
|------|-----------|
| `price_decrease` | Nuevo precio < precio anterior |
| `price_increase` | Nuevo precio > precio anterior |
| `out_of_stock` | Producto disponible → no disponible |
| `back_in_stock` | Producto no disponible → disponible |

### Datos de la alerta
- Producto del proveedor (nombre, SKU, proveedor)
- Precio anterior y nuevo con % de cambio
- Productos Odoo vinculados (de ambas empresas) con sus costos/precios actuales
- Comparativa: si hay múltiples proveedores para el mismo producto, mostrar todos los precios

### Estados
- `pending`: recién creada, esperando revisión
- `approved`: admin aprobó → se actualizó Odoo
- `dismissed`: admin descartó

### Al aprobar una alerta de precio
1. Recalcular costo y precio de venta con las reglas vigentes
2. Actualizar `standard_price` (costo) y `list_price` (venta) en Odoo via JSON-RPC
3. Actualizar para ambas empresas si el producto está vinculado en ambas
4. Registrar en activity_log

## Reglas por proveedor

### Campos del proveedor
- `name`: nombre para mostrar
- `prefix`: prefijo para códigos (CAST, MALI, IMP, REY, etc.)
- `website_url`: URL base del sitio
- `scraper_key`: clave en el registry de scrapers
- `price_format`: 'ar' (argentino) o 'inv' (inverso)
- `is_published`: si se incluye en catálogos
- `default_discount`: descuento global (%)
- `default_markup`: markup global (%)

### Campos de regla por categoría
- `source_category`: categoría tal como viene del scraping
- `dest_category`: categoría estandarizada en Neggo
- `discount_override`: sobreescribe el default (NULL = usar default)
- `markup_override`: sobreescribe el default (NULL = usar default)

### Migración desde Excel
El "Maestro Preventas.xlsx" tiene dos hojas:
- **Hoja "Proveedor"**: Nombre, Prefijo, Precio Inverso (bool), Se publica
- **Hoja "Maestro"**: Nombre (proveedor), Categoría Origen, Categoría Destino, Descuento Proveedor, Markup
