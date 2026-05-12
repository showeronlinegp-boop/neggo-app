# Agente 13 — Marketing: imágenes + catálogos + calendario + IA (Fase 4)

## Objetivo
Generador de imágenes individuales de producto (1080x1350), catálogos PDF con templates
configurables, calendario de publicaciones tipo Kanban, e IA (GPT-4o-mini) para sugerir
textos y productos a publicar.

## Skills a leer
- `docs/skills/project-context/SKILL.md` (branding Neggo)

## Dependencias
- Fase 1 completa + Agentes 10-12

## Schema nuevo

```sql
CREATE TABLE IF NOT EXISTS marketing_calendar (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    scheduled_date DATE NOT NULL,
    channel VARCHAR(30) NOT NULL,
        -- 'instagram', 'whatsapp', 'facebook'
    status VARCHAR(20) DEFAULT 'planificado',
        -- planificado, en_diseno, listo, publicado
    content_type VARCHAR(20),            -- 'image', 'catalog', 'post'
    category VARCHAR(200),
    product_ids JSONB DEFAULT '[]',      -- IDs de supplier_products o odoo_products
    ai_suggestion TEXT,                  -- texto sugerido por IA
    generated_file_path VARCHAR(500),
    created_by INTEGER REFERENCES users(id),
    published_by INTEGER REFERENCES users(id),
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,           -- 'image', 'catalog'
    config JSONB NOT NULL,
        -- image:   { width, height, bgColor, logoPosition, priceColor, fontFamily }
        -- catalog: { productsPerPage, showCode, showPrice, headerStyle }
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_generated (
    id SERIAL PRIMARY KEY,
    calendar_id INTEGER REFERENCES marketing_calendar(id),
    type VARCHAR(20) NOT NULL,           -- 'image', 'catalog_pdf'
    template_id INTEGER REFERENCES marketing_templates(id),
    file_path VARCHAR(500) NOT NULL,
    product_count INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mc_date ON marketing_calendar(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_mc_status ON marketing_calendar(status);
CREATE INDEX IF NOT EXISTS idx_mc_channel ON marketing_calendar(channel);
```

## Tareas

### 1. Generador de imágenes individuales
Crear `backend/services/imageService.js`:

- `generateProductImage(productId, templateId)` — Genera imagen 1080x1350
  - Usar librería `sharp` para composición
  - Descargar imagen del producto desde `image_url` (supplier_products)
  - Superponer: fondo del template, imagen del producto centrada, logo Neggo,
    nombre del producto, código/SKU, precio calculado con fórmula Neggo
  - Fuentes: Montserrat, Nunito (incluir en `/app/assets/fonts/`)
  - Guardar en `/storage/marketing/images/`

- `generateBulkImages(category, templateId)` — Todos los productos de una categoría
  que tengan image_url disponible

### 2. Generador de catálogos PDF (extender el existente)
En `backend/services/catalogService.js`:
- Reutilizar la base existente
- Agregar soporte de templates configurables desde `marketing_templates`
- Templates para Neggo (precio con fórmula Neggo) distintos a Preventas
- Guardar en `/storage/marketing/catalogs/`

### 3. Servicio de IA para marketing
Crear `backend/services/marketingAiService.js`:

- `suggestProducts(category, count)` — GPT-4o-mini analiza y retorna lista sugerida:
  - Productos con mejor margen (sale_price - cost más alto)
  - Productos nuevos (scraped hace menos de 7 días)
  - Productos con bajada de precio reciente (cruzar con price_history)
  - Retorna: `[{ product, reason, priority }]`

- `generateCaption(product, channel)` — Genera texto de publicación adaptado al canal:
  - Instagram: con hashtags, tono comercial aspiracional, emoji
  - WhatsApp: directo, precio destacado, sin hashtags
  - Facebook: intermedio, informativo

- `suggestWeeklyPlan(categories)` — GPT-4o-mini genera plan para los próximos 7 días:
  distribución por canal y categoría

### 4. Rutas
Crear `backend/routes/marketing.js`:

```
GET  /api/marketing/calendar?month=&channel=       — entradas del calendario
POST /api/marketing/calendar                        — crear entrada
PUT  /api/marketing/calendar/:id                    — editar
PUT  /api/marketing/calendar/:id/status             — cambiar estado Kanban
POST /api/marketing/calendar/:id/generate           — generar imagen o catálogo

POST /api/marketing/ai/suggest-products             — { category, count }
POST /api/marketing/ai/generate-caption             — { productId, channel }
POST /api/marketing/ai/weekly-plan                  — { categories }

GET  /api/marketing/templates
POST /api/marketing/templates
PUT  /api/marketing/templates/:id

GET  /api/marketing/images?category=               — imágenes generadas
POST /api/marketing/images/generate                — generar imagen individual
POST /api/marketing/images/bulk                    — generación masiva por categoría
```

### 5. Páginas frontend

**`pages/marketing/MarketingCalendar.jsx`** — ruta `/marketing/calendario`
- Vista mensual con días como columnas
- Por día: cards de publicaciones planificadas con color por estado
- Drag-and-drop para cambiar fecha (PC) / tap para editar (mobile)
- Modal para crear/editar entrada: título, canal, fecha, tipo de contenido, productos

**`pages/marketing/ImageGenerator.jsx`** — ruta `/marketing/imagenes`
- Selector de categoría + template
- Grid de productos con checkbox de selección
- Preview de imagen generada antes de confirmar
- Botón "Generar masivo" para toda la categoría
- Galería de imágenes generadas con descarga

**`pages/marketing/AiMarketing.jsx`** — ruta `/marketing/ia`
- Sección "Sugerencias": selector de categoría → lista de productos sugeridos con razón
- Sección "Generar texto": selector de producto + canal → texto generado editable
- Sección "Plan semanal": selector de categorías → genera plan para 7 días

**`pages/marketing/Templates.jsx`** — ruta `/marketing/templates`
- Lista de templates (imagen y catálogo)
- Editor de config: sliders/pickers para colores, layout, tipografía
- Preview del template

### 6. Navegación
Agregar en `Layout.jsx` sección "Marketing":
```javascript
{ icon: '📅', label: 'Calendario',  path: '/marketing/calendario', roles: ['admin'] },
{ icon: '🖼️', label: 'Imágenes',    path: '/marketing/imagenes',   roles: ['admin'] },
{ icon: '🤖', label: 'IA Marketing', path: '/marketing/ia',         roles: ['admin'] },
```

## Criterios de éxito
- [ ] Imágenes 1080x1350 se generan con logo Neggo, producto y precio calculado
- [ ] Catálogos PDF con template configurable (neggo vs preventas)
- [ ] IA sugiere productos con razón explícita (margen, novedad, precio)
- [ ] IA genera textos adaptados a Instagram, WhatsApp, Facebook
- [ ] Calendario Kanban funciona con estados visuales y colores por canal
- [ ] Generación masiva por categoría funciona
- [ ] Imágenes se guardan en /storage/marketing/ y son descargables
