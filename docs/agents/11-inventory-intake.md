# Agente 11 — Ingreso de mercadería: CSV + matching + gestión en Odoo (Fase 3)

## Objetivo
Procesamiento de remitos/facturas en formato CSV, matching de items con Odoo, gestión de
fotos de productos, y creación automática de account.move (factura de compra) en Odoo.

## Skills a leer
- `docs/skills/odoo-integration/SKILL.md`

## Dependencias
- Fase 1 completa + Agente 10

## Deuda técnica documentada
OCR sobre fotos de facturas papel (GPT-4o-mini) está pendiente para una fase futura.
El módulo actual trabaja con CSV exportado del sistema del proveedor o tipeo manual.
Cuando se implemente OCR:
- El endpoint `POST /api/invoices/upload` recibirá imágenes en lugar de CSV
- El servicio OCR enviará las fotos a GPT-4o-mini con el prompt de extracción
- El flujo posterior (matching, triangulación, confirmación) se reutiliza sin cambios

## Schema

```sql
CREATE TABLE IF NOT EXISTS invoice_imports (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    source_file VARCHAR(500),        -- nombre del archivo CSV subido
    status VARCHAR(20) DEFAULT 'review',
        -- 'review': items listos para revisar
        -- 'completed': confirmado y aplicado en Odoo
        -- 'failed': error al procesar
    odoo_account_move_id INTEGER,    -- account.move creado en Odoo
    total_detected NUMERIC(12,2),    -- suma del CSV
    total_confirmed NUMERIC(12,2),   -- suma de items confirmados
    processed_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_import_items (
    id SERIAL PRIMARY KEY,
    invoice_import_id INTEGER REFERENCES invoice_imports(id) ON DELETE CASCADE,
    raw_code VARCHAR(100),           -- código extraído del CSV (puede ser null)
    raw_name VARCHAR(500) NOT NULL,  -- nombre extraído del CSV
    raw_quantity INTEGER,
    raw_price NUMERIC(12,2),
    odoo_product_id INTEGER,         -- producto matcheado en Odoo (null si no matcheó)
    match_type VARCHAR(20),          -- 'auto_ref', 'auto_fuzzy', 'manual', null
    match_confidence NUMERIC(4,2),
    confirmed BOOLEAN DEFAULT false,
    action VARCHAR(20) DEFAULT 'update',
        -- 'update': actualizar costo/precio del existente
        -- 'create': crear producto nuevo en Odoo
        -- 'reactivate': reactivar producto archivado
        -- 'skip': ignorar este item
    photo_path VARCHAR(500),         -- si se subió foto
    photo_uploaded_to_odoo BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ii_import ON invoice_import_items(invoice_import_id);
CREATE INDEX IF NOT EXISTS idx_imports_supplier ON invoice_imports(supplier_id);
CREATE INDEX IF NOT EXISTS idx_imports_status ON invoice_imports(status);
```

**Nota:** Esta tabla reemplaza a `ingreso_mercaderia` e `ingreso_items`. Migrar los datos
existentes o arrancar limpio según el estado real de la DB.

## Tareas

### 1. Servicio de parseo CSV
El servicio existente `backend/services/ingresoService.js` ya tiene lógica de parseo CSV.
Refactorizar para que:
- Soporte columnas flexibles: codigo/code, descripcion/description, cantidad/quantity,
  precio/price, subtotal/importe
- Maneje formato numérico español ("7.854,00" → 7854.00)
- Retorne array de `{ raw_code, raw_name, raw_quantity, raw_price }`

### 2. Servicio de matching de items
Crear `backend/services/invoiceMatchingService.js`:

- `matchInvoiceItems(items, supplierId)` — Para cada item:
  1. Si tiene código → buscar por referencia interna en odoo_products_cache (match_type: 'auto_ref', confidence: 1.0)
  2. Si no tiene código o no matcheó → fuzzy por nombre (match_type: 'auto_fuzzy')
  3. confidence < 0.8 → quedan para revisión manual
- Retorna items con odoo_product_id y match_confidence

### 3. Triangulación referencial
Para cada item matcheado, calcular y retornar 3 precios:
- **Factura**: precio del CSV
- **Web**: raw_price en supplier_products (última vez scrapeado)
- **Odoo**: standard_price actual en odoo_products_cache

Solo informativo, nunca bloquea el flujo.

### 4. Gestión de fotos de productos
- Al procesar cada item, el operador puede subir foto (desde cámara o archivo)
- El operador decide si sube a Odoo (checkbox "Subir a Odoo")
- Si sube: enviar via API a Odoo campo image_1920 (base64)
- Fallback: mostrar image_url del supplier_product si existe

### 5. Acciones por item y creación en Odoo
- **update**: actualizar standard_price (costo) y list_price (precio venta con fórmula Neggo)
- **create**: crear product.product en Odoo Neggo con los datos del item
- **reactivate**: reactivar producto archivado (active=True)
- **skip**: no hacer nada con este item

Al confirmar: crear `account.move` (factura de compra) en Odoo empresa Neggo con los
items confirmados.

### 6. Rutas
En `backend/routes/ingreso.js` (refactorizar el existente):

```
POST /api/ingreso/upload                     — subir CSV (multer)
POST /api/ingreso/:id/process                — ejecutar matching en los items
GET  /api/ingreso/:id                        — detalle con items + triangulación
PUT  /api/ingreso/:id/items/:itemId          — editar item (match, acción, confirmar)
POST /api/ingreso/:id/confirm                — confirmar todo + crear account.move en Odoo
POST /api/ingreso/:id/items/:itemId/photo    — subir foto de producto
GET  /api/ingreso                            — listar con filtros
```

### 7. Página frontend
Las páginas `IngresoUpload.jsx` e `IngresoPreview.jsx` ya existen, refactorizar para:

**IngresoUpload.jsx** (`/ingreso/new`):
- Selector de proveedor + número de comprobante
- Drag-and-drop o botón para subir CSV
- Preview de primeras filas para confirmar que el CSV es correcto
- Botón "Procesar" → POST /api/ingreso/upload + /process

**IngresoPreview.jsx** (`/ingreso/:id`):
- Tabla de items extraídos del CSV, editable
- Columnas: código, nombre, cantidad, precio factura | precio web | precio Odoo (triangulación)
- Indicador de confianza del match (verde ≥0.9, amarillo 0.7-0.9, rojo <0.7)
- Selector de acción por item (update/create/reactivate/skip)
- Checkbox "Subir foto a Odoo" + botón para capturar/subir foto por item
- Botón "Confirmar todo" → crea account.move en Odoo

## Criterios de éxito
- [ ] CSV se parsea correctamente con columnas flexibles y formato español
- [ ] Matching automático vincula items con productos Odoo
- [ ] Items dudosos (confidence < 0.8) quedan para revisión manual
- [ ] Triangulación muestra 3 precios side-by-side
- [ ] account.move se crea en Odoo correctamente con items confirmados
- [ ] Fotos se suben a Odoo cuando el operador lo indica
- [ ] Historial de ingresos listable con filtros
