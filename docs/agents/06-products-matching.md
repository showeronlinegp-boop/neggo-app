# Agente 06 — Matching de productos y alertas de precio

## Objetivo
Implementar el motor de matching automático (por referencia interna y por nombre), la gestión
manual de vínculos, y el sistema de alertas de precio con comportamiento diferenciado por empresa:
Preventas se actualiza automáticamente, Neggo requiere aprobación manual.

## Skills a leer
- `docs/skills/business-rules/SKILL.md` (sección Matching y Alertas)
- `docs/skills/odoo-integration/SKILL.md` (para leer productos del cache)

## Dependencias
- Agentes 01-05 completados (proveedores, scraping, cache Odoo)

## Lógica de alertas por empresa

Un producto de proveedor puede estar vinculado a productos de AMBAS empresas al mismo tiempo.
Cuando cambia el precio:

- **Vinculado a Preventas** → actualizar automáticamente en Odoo + registrar en price_alerts
  con `status = 'auto_applied'` (para trazabilidad, no aparece en la cola de revisión)
- **Vinculado a Neggo** → crear alerta con `status = 'pending'` (espera aprobación del admin)
- **Vinculado a ambas** → ambas acciones en la misma detección

## Tareas

### 1. Servicio de matching
Crear `backend/services/matchingService.js`:
- `autoMatchByRef(supplierId)` — Para cada producto del proveedor, buscar match en
  odoo_products_cache por referencia interna (prefijo + SKU). Crear product_mappings
  con match_type='auto_ref', confidence=1.0
- `autoMatchByName(supplierId, threshold)` — Fuzzy matching por nombre normalizado.
  Umbral default 0.7 para sugerir, 0.9 para auto-vincular. match_type='auto_fuzzy'
- `runAutoMatch(supplierId)` — Ejecuta ambos en secuencia (ref primero, luego fuzzy
  para los que no matchearon)
- `getUnmappedProducts(supplierId)` — Productos sin vínculo a Odoo

### 2. Rutas de mappings
Crear `backend/routes/productMappings.js`:
- `GET /api/mappings` — Filtros: supplier, odoo_company, unmapped=true, search
- `POST /api/mappings` — Crear vínculo manual (match_type='manual', confidence=1.0)
- `DELETE /api/mappings/:id` — Eliminar vínculo
- `POST /api/mappings/auto-match` — Body: { supplierId }. Ejecuta matching, retorna resumen

### 3. Servicio de alertas — LÓGICA POR EMPRESA
Crear `backend/services/priceAlertService.js`:

```javascript
/**
 * Procesa un cambio de precio detectado por el scraper.
 * Divide los productos vinculados por empresa y aplica la lógica correcta:
 * - preventas: actualiza Odoo automáticamente + registra como auto_applied
 * - neggo: crea alerta pending para revisión manual
 */
async function processPrice Change(pool, supplierProductId, oldPrice, newPrice, odooService, rulesEngine) {
    const pctChange = ((newPrice - oldPrice) / oldPrice) * 100;

    // Solo genera alerta de Neggo si el cambio supera el 2%
    const NEGGO_THRESHOLD = 2;

    // Obtener todos los vínculos del producto
    const { rows: mappings } = await pool.query(`
        SELECT pm.odoo_product_id, pm.odoo_company, pm.odoo_internal_ref,
               opc.name, opc.standard_price, opc.list_price
        FROM product_mappings pm
        JOIN odoo_products_cache opc
          ON opc.odoo_id = pm.odoo_product_id AND opc.company = pm.odoo_company
        WHERE pm.supplier_product_id = $1 AND pm.active = true
    `, [supplierProductId]);

    // Obtener datos del supplier_product para el rulesEngine
    const { rows: [sp] } = await pool.query(`
        SELECT sp.*, s.default_discount, s.default_markup, s.prefix
        FROM supplier_products sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.id = $1
    `, [supplierProductId]);

    for (const mapping of mappings) {
        if (mapping.odoo_company === 'preventas') {
            // PREVENTAS: actualizar automáticamente
            const categoryRule = await rulesEngine.getCategoryRule(
                pool, sp.supplier_id, sp.source_category, 'preventas'
            );
            const prices = rulesEngine.calculatePrices(
                { raw_price: newPrice }, sp, categoryRule, 'preventas'
            );
            await odooService.updateProductPrice(
                mapping.odoo_product_id, prices.cost, prices.sale_price, 'preventas'
            );
            // Registrar para trazabilidad
            await pool.query(`
                INSERT INTO price_alerts
                    (supplier_product_id, alert_type, old_price, new_price, pct_change,
                     linked_odoo_products, status, company)
                VALUES ($1, $2, $3, $4, $5, $6, 'auto_applied', 'preventas')
            `, [
                supplierProductId,
                newPrice > oldPrice ? 'price_increase' : 'price_decrease',
                oldPrice, newPrice, pctChange,
                JSON.stringify([{ odoo_id: mapping.odoo_product_id, ...mapping }])
            ]);

        } else if (mapping.odoo_company === 'neggo') {
            // NEGGO: solo crear alerta si el cambio supera el umbral
            if (Math.abs(pctChange) < NEGGO_THRESHOLD) continue;

            await pool.query(`
                INSERT INTO price_alerts
                    (supplier_product_id, alert_type, old_price, new_price, pct_change,
                     linked_odoo_products, status, company)
                VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'neggo')
            `, [
                supplierProductId,
                newPrice > oldPrice ? 'price_increase' : 'price_decrease',
                oldPrice, newPrice, pctChange,
                JSON.stringify([{ odoo_id: mapping.odoo_product_id, ...mapping }])
            ]);
        }
    }
}

/**
 * Aprobar una alerta de Neggo: recalcular con reglas + actualizar Odoo.
 */
async function approveAlert(pool, alertId, userId, odooService, rulesEngine) { ... }

/**
 * Descartar una alerta de Neggo.
 */
async function dismissAlert(pool, alertId, userId, notes) { ... }

/**
 * Resumen para el dashboard.
 * Solo cuenta alertas 'pending' de Neggo (las auto_applied no requieren acción).
 */
async function getAlertSummary(pool) { ... }
```

### 4. Rutas de alertas
Crear `backend/routes/priceAlerts.js`:
- `GET /api/alerts` — Filtros: status, type, supplier, company.
  Por defecto solo trae `status=pending` (Neggo). Para ver historial de Preventas: `company=preventas`
- `PUT /api/alerts/:id/approve` — Solo aplica a alertas de Neggo pending
- `PUT /api/alerts/:id/dismiss` — Con nota opcional
- `GET /api/alerts/summary` — Retorna `{ pending: N }` (solo Neggo, para el badge del sidebar)

### 5. Historial de precios
En `backend/routes/products.js`:
- `GET /api/products/supplier/:id/price-history` — Historial con paginación
- `GET /api/products/supplier` — Lista con filtros (supplier, category, search, available)

## Schema — campo company en price_alerts
```sql
-- Migración: agregar company a la tabla existente
ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS company VARCHAR(20);
-- Las alertas existentes sin company son de Neggo (comportamiento anterior)
UPDATE price_alerts SET company = 'neggo' WHERE company IS NULL;
```

## Criterios de éxito
- [ ] Auto-match por referencia vincula correctamente con prefijo coincidente
- [ ] Fuzzy matching sugiere vínculos con confianza > 0.7
- [ ] Creación manual de vínculos funciona
- [ ] Cambio de precio en producto vinculado a Preventas → actualiza Odoo automáticamente
- [ ] Cambio de precio en producto vinculado a Neggo (>2%) → crea alerta pending
- [ ] Cambio en producto vinculado a AMBAS → aplica las dos lógicas
- [ ] Aprobar alerta de Neggo actualiza costo y precio en Odoo
- [ ] Badge del sidebar solo cuenta alertas pending de Neggo
- [ ] Las actualizaciones automáticas de Preventas aparecen en historial
