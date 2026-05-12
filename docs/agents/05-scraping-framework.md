# Agente 05 — Framework de scraping

## Objetivo
Crear el framework de scraping con clase base, migrar los scrapers existentes (Cast, Mali,
Impotekno, El Rey) de Selenium a Puppeteer, implementar el panel de control, y detectar
automáticamente categorías nuevas sin mapeo.

## Skills a leer antes de empezar
- `docs/skills/scraper-patterns/SKILL.md` (completa)

## Dependencias
- Agentes 01-04 completados (especialmente proveedores y pending_category_mappings en DB)

## Tareas

### 1. Clase base BaseScraper
Crear `backend/scrapers/baseScraper.js` siguiendo la skill scraper-patterns.
Métodos abstractos: `getCategories()`, `scrapeCategoryPage(page, category, pageNum)`.
Métodos heredados: `run()`, `handlePagination()`, `scrollForLazy()`, `saveToDB()`,
`detectPriceChanges()`, `parsePrice()`, `logRun()`.

#### Detección de categorías pendientes (NUEVO)
Agregar método `detectPendingCategories()` que se ejecuta al finalizar cada scraping:

```javascript
async detectPendingCategories() {
    // Obtener todas las source_category únicas que se scrapearon en esta ejecución
    const { rows: scraped } = await pool.query(`
        SELECT DISTINCT source_category
        FROM supplier_products
        WHERE supplier_id = $1 AND source_category IS NOT NULL
    `, [this.supplier.id]);

    // Obtener categorías que YA tienen regla (activa o ignorada)
    const { rows: mapped } = await pool.query(`
        SELECT source_category FROM supplier_category_rules
        WHERE supplier_id = $1
    `, [this.supplier.id]);

    const mappedSet = new Set(mapped.map(r => r.source_category));

    for (const { source_category } of scraped) {
        if (mappedSet.has(source_category)) continue;

        // Obtener hasta 5 productos de muestra para dar contexto al admin
        const { rows: samples } = await pool.query(`
            SELECT name FROM supplier_products
            WHERE supplier_id = $1 AND source_category = $2
            LIMIT 5
        `, [this.supplier.id, source_category]);

        const sampleProducts = samples.map(s => s.name);

        // Upsert en pending_category_mappings (no duplicar si ya existe)
        await pool.query(`
            INSERT INTO pending_category_mappings
                (supplier_id, source_category, sample_products, status)
            VALUES ($1, $2, $3, 'pending')
            ON CONFLICT (supplier_id, source_category)
            DO UPDATE SET
                sample_products = EXCLUDED.sample_products
            WHERE pending_category_mappings.status = 'pending'
        `, [this.supplier.id, source_category, JSON.stringify(sampleProducts)]);
    }
}
```

Llamar `detectPendingCategories()` al final de `run()`, antes de `logRun()`.

### 2. Migrar scrapers existentes
Crear un archivo por proveedor en `backend/scrapers/`:
- `cast.js` — WooCommerce, paginación /page/N/, SKU en página de detalle
- `mali.js` — OpenCart con login, scrapea wishlist
- `impotekno.js` — Catálogo público con categorías
- `elrey.js` — Catálogo público con categorías
- `neggoOdoo.js` — Scraping del shop Odoo propio

Cada scraper extiende BaseScraper e implementa los métodos específicos.
REFERENCIA: Los scrapers originales están en la carpeta del proyecto. Respetar la lógica
de detección de fin de paginación y los selectores CSS de cada sitio.

### 3. Registry de scrapers
Crear `backend/scrapers/registry.js`:
- Mapa de `scraper_key` → clase del scraper
- `getScraperForSupplier(supplier)` — Retorna instancia del scraper correcto
- Si no hay scraper para el proveedor, retorna null

### 4. Servicio de scraping
Crear `backend/services/scrapingService.js`:
- `runScraper(supplierId, triggeredBy)` — Conecta a Chrome, crea instancia, ejecuta,
  guarda resultados, detecta cambios de precio, detecta categorías pendientes
- `getRunHistory(supplierId)` — Historial de ejecuciones
- `getRunDetail(runId)` — Detalle con errores
- Control de concurrencia: máx 2 scrapers simultáneos (semáforo)

### 5. Rutas
Crear `backend/routes/scraping.js`:
- `POST /api/scraping/:supplierId/run` — Ejecutar scraper (admin)
- `GET /api/scraping/runs` — Historial con filtros
- `GET /api/scraping/runs/:runId` — Detalle

### 6. Scheduler de scraping
Actualizar `backend/jobs/scheduler.js`:
- Para cada proveedor con `scrape_schedule` configurado, registrar cron job
- El schedule se lee de la DB al iniciar el servidor

## Criterios de éxito
- [ ] El scraper de Cast extrae productos correctamente
- [ ] Los productos se guardan en supplier_products con precios parseados
- [ ] Los cambios de precio generan alertas en price_alerts
- [ ] El panel muestra estado del scraping en tiempo real
- [ ] Máximo 2 scrapers corren simultáneamente
- [ ] scraping_runs registra cada ejecución con stats
- [ ] Al finalizar el scraping, las categorías sin mapeo aparecen en pending_category_mappings
- [ ] El badge naranja del sidebar refleja el total de categorías pendientes
