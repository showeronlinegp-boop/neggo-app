# Agente 04 — Proveedores y reglas de negocio

## Objetivo
Implementar CRUD de proveedores, CRUD de reglas por categoría (con mapeo dual por empresa),
motor de cálculo de precios, herramienta de importación desde Excel, y mecanismo de
categorías pendientes de mapeo.

## Skills a leer antes de empezar
- `docs/skills/business-rules/SKILL.md` (completa)

## Dependencias
- Agentes 01-02 completados

## Schema

### supplier_category_rules — DUAL EMPRESA
La tabla tiene DOS columnas destino: una para Neggo y otra para Preventas.
Una misma categoría origen puede mapearse a nombres distintos en cada empresa.

```sql
CREATE TABLE IF NOT EXISTS supplier_category_rules (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    source_category VARCHAR(200) NOT NULL,
        -- categoría tal como viene del scraping
    dest_category_neggo VARCHAR(200),
        -- categoría destino en empresa Neggo (null = no aplica)
    dest_category_preventas VARCHAR(200),
        -- categoría destino en empresa Preventas (null = no aplica)
    ignored BOOLEAN DEFAULT false,
        -- true = esta categoría se descarta, no genera productos ni alertas
    discount_override NUMERIC(5,2),
        -- si es NULL, usa el default del supplier
    markup_override NUMERIC(5,2),
        -- si es NULL, usa el default del supplier
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, source_category)
);

CREATE INDEX IF NOT EXISTS idx_cat_rules_supplier ON supplier_category_rules(supplier_id);
```

### pending_category_mappings — CATEGORÍAS NUEVAS SIN REGLA
Cuando el scraping detecta una categoría que no tiene regla, la inserta acá.
El admin la resuelve desde el panel de proveedores.

```sql
CREATE TABLE IF NOT EXISTS pending_category_mappings (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    source_category VARCHAR(200) NOT NULL,
    sample_products JSONB DEFAULT '[]',
        -- array con hasta 5 nombres de productos de esa categoría (para contexto)
    status VARCHAR(20) DEFAULT 'pending',
        -- 'pending', 'mapped', 'ignored'
    resolved_at TIMESTAMP,
    resolved_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, source_category)
);

CREATE INDEX IF NOT EXISTS idx_pcm_supplier ON pending_category_mappings(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcm_status ON pending_category_mappings(status);
```

## Tareas

### 1. CRUD proveedores
Crear `backend/routes/suppliers.js`:
- `GET /api/suppliers` — Lista con filtros (active, search, status)
- `POST /api/suppliers` — Crear proveedor
- `PUT /api/suppliers/:id` — Editar
- `GET /api/suppliers/:id` — Detalle con stats (productos, último scraping)
- `GET /api/suppliers/unmapped-summary` — Total de categorías pending por proveedor
  (este endpoint ya lo llama el Layout para el badge naranja)

### 2. CRUD reglas por categoría
Crear `backend/routes/supplierRules.js`:
- `GET /api/suppliers/:id/rules` — Todas las reglas del proveedor
- `POST /api/suppliers/:id/rules` — Crear regla
  Body: { source_category, dest_category_neggo, dest_category_preventas, discount_override, markup_override, ignored }
- `PUT /api/suppliers/:id/rules/:ruleId` — Editar
- `DELETE /api/suppliers/:id/rules/:ruleId` — Eliminar

### 3. Gestión de categorías pendientes
Agregar a `backend/routes/suppliers.js`:
- `GET /api/suppliers/:id/pending-categories` — Lista las categorías pendientes del proveedor
  con sample_products para dar contexto
- `POST /api/suppliers/:id/pending-categories/:pendingId/resolve` — Resolver:
  - Si `action = 'map'`: crea la regla en supplier_category_rules + marca pending como 'mapped'
    Body: { dest_category_neggo, dest_category_preventas, discount_override, markup_override }
  - Si `action = 'ignore'`: marca la regla como ignored=true + marca pending como 'ignored'

### 4. Motor de reglas
Actualizar `backend/services/rulesEngine.js`:

```javascript
// getCategoryRule ahora acepta company para devolver el dest correcto
async function getCategoryRule(pool, supplierId, sourceCategory, company) {
    const result = await pool.query(`
        SELECT id, supplier_id, source_category,
               dest_category_neggo, dest_category_preventas,
               discount_override, markup_override, ignored, active
        FROM supplier_category_rules
        WHERE supplier_id = $1 AND source_category = $2 AND active = true
        LIMIT 1
    `, [supplierId, sourceCategory]);

    const rule = result.rows[0];
    if (!rule) return null;

    return {
        ...rule,
        // dest_category normalizado según empresa solicitante
        dest_category: company === 'neggo'
            ? rule.dest_category_neggo
            : rule.dest_category_preventas
    };
}
```

Endpoint: `GET /api/products/supplier/:id/calculate-prices` — Preview de precios para
ambas empresas. Usa `getCategoryRule` con cada empresa.

### 5. Importación desde Excel
Crear `POST /api/suppliers/:id/rules/import-excel`:
- Acepta archivo .xlsx (Maestro Preventas.xlsx)
- Lee hoja "Proveedor": prefijo, formato precio, flag publicación
- Lee hoja "Maestro": reglas por categoría.
  **ATENCIÓN**: El Excel puede tener una sola columna destino. Si es así, usar ese valor
  tanto para dest_category_neggo como para dest_category_preventas. El admin puede editar
  después desde la UI.
- Upsert en las tablas correspondientes
- Retorna resumen: cuántas reglas creadas/actualizadas
- Usar librería `xlsx` (SheetJS)

## Criterios de éxito
- [ ] CRUD de proveedores funciona con todos los campos
- [ ] CRUD de reglas con dual-categoría (neggo + preventas) funciona
- [ ] `calculatePrices` retorna dest_category correcto según empresa
- [ ] Preview muestra diferencia entre Neggo y Preventas
- [ ] Import desde Excel carga proveedores y reglas correctamente
- [ ] `GET /api/suppliers/unmapped-summary` retorna conteo correcto para badge del sidebar
- [ ] Categorías pendientes se pueden resolver (mapear o ignorar) desde la API
