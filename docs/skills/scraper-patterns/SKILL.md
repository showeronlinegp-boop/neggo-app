---
name: scraper-patterns
description: Patrones de scraping identificados en los scrapers existentes de Neggo. Leer antes de crear o modificar scrapers. Cubre la migración de Selenium a Puppeteer, patrones por tipo de sitio, y manejo de errores.
---

# Patrones de scraping

## Arquitectura target

Los scrapers actuales corren en Windows con Selenium + ChromeDriver local.
Se migran a Puppeteer conectado a `browserless/chrome` container en Docker.

```javascript
const puppeteer = require('puppeteer');

// Conectar al container browserless
const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://chrome:3000'
});
```

## Clase base: BaseScraper

Todos los scrapers heredan de BaseScraper que provee:

```javascript
class BaseScraper {
    constructor(supplier, browser, db) {
        this.supplier = supplier;     // row de tabla suppliers
        this.browser = browser;       // instancia Puppeteer
        this.db = db;                 // pool PostgreSQL
        this.products = [];
        this.errors = [];
        this.runId = null;
    }

    // --- MÉTODOS A IMPLEMENTAR POR CADA SCRAPER ---
    async getCategories() { throw new Error('Implementar'); }
    // Retorna: [{ url, name }]

    async scrapeCategoryPage(page, category, pageNum) { throw new Error('Implementar'); }
    // Retorna: { products: [{ name, sku, price, image_url, product_url, category }], hasMore: bool }

    // --- MÉTODOS HEREDADOS ---
    async run() { /* Orquesta el scraping completo */ }
    async handlePagination(page, category) { /* Loop de páginas */ }
    async scrollForLazy(page) { /* Scroll + wait para lazy loading */ }
    async saveToDB() { /* Upsert en supplier_products */ }
    async detectPriceChanges() { /* Compara con price_history, crea alertas */ }
    parsePrice(text) { /* Usa el price_format del supplier */ }
    async logRun(status, stats) { /* Registra en scraping_runs */ }
}
```

## Proveedores y sus patrones

### Cast (WooCommerce)
- **Tipo**: Catálogo público WooCommerce, sin login
- **Paginación**: `/page/N/` en la URL. Detectar fin por: redirección al home, contenido repetido
- **Productos en listado**: `li.product` con h2 para nombre, span.woocommerce-Price-amount para precio
- **SKU**: requiere navegar a la página de detalle del producto (`span.sku`)
- **Out of stock**: clase `outofstock` en el `<li>`
- **Imágenes**: `img.attachment-woocommerce_thumbnail`, revisar `data-src` para lazy loading
- **Categorías**: URLs hardcodeadas por categoría (19 categorías)

### Mali (Login + Wishlist)
- **Tipo**: OpenCart con login requerido
- **Login**: POST a `/index.php?route=account/login` con email/password
- **Datos**: scrapea lista de favoritos (wishlist), no catálogo completo
- **Paginación**: parámetro `page=N` en URL de wishlist

### El Rey (Catálogo Smarty con token)
- **Tipo**: Catálogo Smarty público, la URL lleva un token: `https://catalog.smarty.com.ar/token/{token}/?category_id={id}`
- **Scraper**: `elrey.js` delega en `elrey_scraper.py` (Selenium). El token sale de `scrape_config.token` o `ELREY_TOKEN` (si no, el default del script); las categorías, de `scrape_config.category_ids`
- **Selectores**: `div.itemWrapper`, `h5.item-name`, `span.reference` (SKU), `span.discountPrice`

### Impotekno (Catálogo público)
- **Tipo**: Sitio con categorías y paginación estándar

### Nurcell (Catálogo público, proveedor "Babu" en DB/Odoo, prefijo BB)
- **Tipo**: Misma plataforma PHP que Impotekno, pero el HTML llega completo desde el servidor (sin JS)
- **URL**: `catalogo2022x3.php?rub=99999` trae todo el catálogo en una sola página
- **Scraper**: `nurcell_scraper.py` con urllib + BeautifulSoup (no usa Chromium)
- **Selectores**: `div.caja_producto`, `#descrip h1` (nombre relleno con `___`), `#texto` (Codigo/Rubro), `strong.caja_precio_noimptk`
- **SKU**: código normalizado → `PREBB{codigo}` coincide con el external_id de Precompras

### Neggo-Odoo (Self-scraping)
- **Tipo**: Scrapeo del propio shop de Odoo (neggo.odoo.com/shop)
- **Selectores Odoo**: `div.o_wsale_product_grid_wrapper`, `.o_wsale_products_item_title a`, `.oe_currency_value`
- **Paginación**: `/shop/page/N`, detectar fin por número de página activa repetido
- **Uso**: generar catálogos con descuento para Preventas
- **NOTA**: Post-migración, este scraper puede reemplazarse por lectura directa via API JSON-RPC

## Migración Selenium → Puppeteer

| Selenium | Puppeteer |
|----------|-----------|
| `driver.get(url)` | `await page.goto(url, { waitUntil: 'networkidle2' })` |
| `driver.find_element(By.CSS_SELECTOR, sel)` | `await page.$(sel)` |
| `driver.find_elements(By.CSS_SELECTOR, sel)` | `await page.$$(sel)` |
| `element.text` | `await page.$eval(sel, el => el.textContent)` |
| `element.get_attribute('src')` | `await page.$eval(sel, el => el.getAttribute('src'))` |
| `WebDriverWait(...).until(EC.presence_of...)` | `await page.waitForSelector(sel, { timeout: 10000 })` |
| `driver.execute_script('window.scrollTo...')` | `await page.evaluate(() => window.scrollTo(...))` |
| `BeautifulSoup(driver.page_source, 'html.parser')` | `const html = await page.content()` (pero mejor usar page.$eval) |

## Output esperado por producto

```javascript
{
    sku: 'VT500',              // código del proveedor
    name: 'Vaso Térmico 500ml',
    price: 10000.00,           // ya parseado a float
    offer_price: null,         // si hay precio de oferta
    image_url: 'https://...',
    product_url: 'https://...', // link a la página del producto
    category: 'Vasos Térmicos', // categoría original del proveedor
    barcode: null,             // EAN si está disponible
    available: true
}
```

## Manejo de errores y resiliencia

- **Timeout por página**: 15 segundos máximo. Si falla, registrar error y continuar
- **Detección de fin de paginación**: 3 métodos (redirección al home, contenido repetido, no hay productos)
- **Rate limiting**: 1-3 segundos entre páginas, configurable por proveedor
- **Máximo de scrapers simultáneos**: 2 (por RAM del container Chrome)
- **Retry**: 1 reintento por página fallida con 5 segundos de espera
- **Screenshots en error**: guardar screenshot para debugging si falla un scraper
