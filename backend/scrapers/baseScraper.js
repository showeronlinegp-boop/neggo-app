const puppeteer = require('puppeteer-core');
const { processPriceChange } = require('../services/priceAlertService');

/**
 * BaseScraper — clase base para todos los scrapers de proveedores.
 * Cada scraper concreto debe extender esta clase e implementar:
 *   - async getCategories(page)  → [{ url, name }]
 *   - async scrapeCategory(page, category) → [{ name, sku, raw_price, offer_price, image_url, product_url, barcode, source_category }]
 */
class BaseScraper {
    constructor(supplier, pool, options = {}) {
        this.supplier = supplier; // row de la tabla suppliers
        this.pool = pool;
        this.products = [];
        this.errors = [];
        this.runId = null;
        // Modo dry-run: no persiste nada en DB, solo retorna productos
        this.dryRun = options.dryRun || false;
        // Callback para streaming de productos en tiempo real (usado en preview SSE)
        this.onProduct = options.onProduct || null;
    }

    // =============================================
    // Métodos que cada scraper DEBE implementar
    // =============================================

    async getCategories(page) {
        throw new Error(`${this.constructor.name} debe implementar getCategories(page)`);
    }

    async scrapeCategory(page, category) {
        throw new Error(`${this.constructor.name} debe implementar scrapeCategory(page, category)`);
    }

    // =============================================
    // Parseo de precios
    // =============================================

    /**
     * Parsea un texto de precio a float.
     * Soporta dos formatos según this.supplier.price_format:
     *   'ar'  → "1.234,56" (punto = miles, coma = decimal)
     *   'inv' → "1,234.56" (coma = miles, punto = decimal)
     */
    parsePrice(priceText) {
        if (!priceText) return null;

        // Limpiar: solo dígitos, puntos, comas y guión para negativo
        const cleaned = String(priceText).replace(/[^\d.,\-]/g, '').trim();
        if (!cleaned || cleaned === '-') return null;

        let normalized;
        const format = this.supplier.price_format || 'ar';

        if (format === 'ar') {
            // "1.234,56" → eliminar puntos (miles), reemplazar coma por punto
            normalized = cleaned.replace(/\./g, '').replace(',', '.');
        } else {
            // 'inv': "1,234.56" → eliminar comas (miles)
            normalized = cleaned.replace(/,/g, '');
        }

        const parsed = parseFloat(normalized);
        return isNaN(parsed) ? null : parsed;
    }

    // =============================================
    // Gestión de runs en DB
    // =============================================

    /**
     * Inserta un nuevo scraping_run y guarda el ID en this.runId.
     * En modo dry-run no ejecuta nada en DB.
     * @param {number|string} triggeredBy — user ID o null (scraping automático)
     */
    async createRun(triggeredBy) {
        if (this.dryRun) {
            this.runId = 'preview';
            console.log(`📦 [DRY-RUN] Preview iniciado para proveedor "${this.supplier.name}"`);
            return 'preview';
        }
        const { rows } = await this.pool.query(
            `INSERT INTO scraping_runs (supplier_id, status, triggered_by, started_at)
             VALUES ($1, 'running', $2, NOW())
             RETURNING id`,
            [this.supplier.id, triggeredBy || null]
        );
        this.runId = rows[0].id;
        console.log(`📦 Run ${this.runId} iniciado para proveedor "${this.supplier.name}"`);
        return this.runId;
    }

    /**
     * Actualiza el run con el estado final y estadísticas.
     * En modo dry-run no ejecuta nada en DB.
     * @param {string} status — 'completed' | 'failed' | 'partial'
     * @param {object} stats  — { found, newProducts, updated, priceChanges }
     */
    async updateRun(status, stats = {}) {
        if (this.dryRun) return;
        await this.pool.query(
            `UPDATE scraping_runs SET
                status = $1,
                products_found = $2,
                products_new = $3,
                products_updated = $4,
                price_changes = $5,
                errors = $6,
                finished_at = NOW()
             WHERE id = $7`,
            [
                status,
                stats.found || 0,
                stats.newProducts || 0,
                stats.updated || 0,
                stats.priceChanges || 0,
                JSON.stringify(this.errors),
                this.runId
            ]
        );
        console.log(`✅ Run ${this.runId} finalizado con status "${status}"`);
    }

    // =============================================
    // Upsert de productos
    // =============================================

    /**
     * Inserta o actualiza productos en supplier_products.
     * Si el raw_price cambió, inserta en price_history.
     * Si el cambio de precio supera el 1%, crea una price_alert.
     *
     * @param {Array} products — lista de productos scrapeados
     * @returns {{ new: number, updated: number, priceChanges: number }}
     */
    async upsertProducts(products) {
        let newCount = 0;
        let updatedCount = 0;
        let priceChanges = 0;
        let duplicateCount = 0;

        for (const product of products) {
            try {
                // SKU final: "PRE" + prefix + código limpio (solo alfanumérico, sin guiones ni especiales)
                const cleanCode = (product.sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                const finalSku = `PRE${this.supplier.prefix}${cleanCode}`;
                const nameKey = (product.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                // Campos opcionales: los scrapers web no los mandan (disponible, fuente web)
                const available = product.available !== false;
                const source = product.source || 'web';
                const neggoOdooId = product.neggo_odoo_id || null;

                // Buscar si ya existe el producto para este supplier + sku
                const { rows: existing } = await this.pool.query(
                    `SELECT id, raw_price FROM supplier_products
                     WHERE supplier_id = $1 AND sku = $2`,
                    [this.supplier.id, finalSku]
                );

                if (existing.length === 0) {
                    // Antes de insertar, verificar duplicado por name_key
                    // (mismo producto levantado desde otra sección del catálogo).
                    // No aplica a la fuente Neggo: las variantes comparten nombre y son productos distintos.
                    const { rows: existingByName } = source === 'neggo' ? { rows: [] } : await this.pool.query(
                        `SELECT id, raw_price FROM supplier_products
                         WHERE supplier_id = $1 AND name_key = $2
                         LIMIT 1`,
                        [this.supplier.id, nameKey]
                    );

                    if (existingByName.length > 0) {
                        // Duplicado por nombre — actualizar el existente, no crear uno nuevo
                        const dup = existingByName[0];
                        const oldPrice = dup.raw_price ? parseFloat(dup.raw_price) : null;
                        const newPrice = product.raw_price;
                        const priceChanged = oldPrice !== null && newPrice !== null && oldPrice !== newPrice;

                        await this.pool.query(
                            `UPDATE supplier_products SET
                                raw_price = $1, offer_price = $2, image_url = $3,
                                product_url = $4, source_category = $5, barcode = $6,
                                available = $8, source = $9, neggo_odoo_id = $10,
                                last_scraped_at = NOW(), updated_at = NOW()
                             WHERE id = $7`,
                            [
                                newPrice, product.offer_price || null, product.image_url || null,
                                product.product_url || null, product.source_category || null,
                                product.barcode || null, dup.id,
                                available, source, neggoOdooId
                            ]
                        );
                        duplicateCount++;

                        if (priceChanged) {
                            await this.pool.query(
                                `INSERT INTO price_history
                                    (supplier_product_id, price, offer_price, available, scraped_at)
                                 VALUES ($1, $2, $3, true, NOW())`,
                                [dup.id, newPrice, product.offer_price || null]
                            );
                            try {
                                await processPriceChange(dup.id, oldPrice, newPrice);
                                priceChanges++;
                            } catch (alertErr) {
                                console.error(`⚠️ Error procesando alerta de precio para "${product.name}":`, alertErr.message);
                            }
                        }
                    } else {
                    // Producto nuevo — INSERT
                    await this.pool.query(
                        `INSERT INTO supplier_products
                            (supplier_id, sku, name, raw_price, offer_price, image_url,
                             product_url, source_category, barcode, available, last_scraped_at, name_key,
                             source, neggo_odoo_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, NOW(), $10, $12, $13)`,
                        [
                            this.supplier.id,
                            finalSku,
                            product.name,
                            product.raw_price,
                            product.offer_price || null,
                            product.image_url || null,
                            product.product_url || null,
                            product.source_category || null,
                            product.barcode || null,
                            nameKey,
                            available,
                            source,
                            neggoOdooId
                        ]
                    );
                    newCount++;
                    }
                } else {
                    // Producto existente — UPDATE con ON CONFLICT como backup
                    const existingProduct = existing[0];
                    const oldPrice = existingProduct.raw_price
                        ? parseFloat(existingProduct.raw_price)
                        : null;
                    const newPrice = product.raw_price;

                    // Detectar cambio de precio
                    const priceChanged = oldPrice !== null
                        && newPrice !== null
                        && oldPrice !== newPrice;

                    await this.pool.query(
                        `UPDATE supplier_products SET
                            name = $1,
                            raw_price = $2,
                            offer_price = $3,
                            image_url = $4,
                            product_url = $5,
                            source_category = $6,
                            barcode = $7,
                            available = $10,
                            source = $11,
                            neggo_odoo_id = $12,
                            last_scraped_at = NOW(),
                            updated_at = NOW(),
                            name_key = $9
                         WHERE id = $8`,
                        [
                            product.name,
                            newPrice,
                            product.offer_price || null,
                            product.image_url || null,
                            product.product_url || null,
                            product.source_category || null,
                            product.barcode || null,
                            existingProduct.id,
                            nameKey,
                            available,
                            source,
                            neggoOdooId
                        ]
                    );
                    updatedCount++;

                    if (priceChanged) {
                        // Insertar en historial
                        await this.pool.query(
                            `INSERT INTO price_history
                                (supplier_product_id, price, offer_price, available, scraped_at)
                             VALUES ($1, $2, $3, true, NOW())`,
                            [existingProduct.id, newPrice, product.offer_price || null]
                        );

                        // Delegar la lógica de alertas al priceAlertService
                        // que distingue automáticamente Preventas (auto) vs Neggo (manual)
                        try {
                            await processPriceChange(existingProduct.id, oldPrice, newPrice);
                            priceChanges++;
                        } catch (alertErr) {
                            console.error(`⚠️ Error procesando alerta de precio para "${product.name}":`, alertErr.message);
                        }
                    }
                }
            } catch (err) {
                console.error(`❌ Error procesando producto "${product.name}" (sku: ${product.sku}):`, err.message);
                this.errors.push({
                    product: product.sku || product.name,
                    error: err.message
                });
            }
        }

        // Actualizar last_scraped_at del supplier
        await this.pool.query(
            'UPDATE suppliers SET last_scraped_at = NOW() WHERE id = $1',
            [this.supplier.id]
        );

        if (duplicateCount > 0) {
            console.log(`⚠️ ${duplicateCount} productos ignorados por duplicado de nombre`);
        }
        console.log(`📦 Upsert finalizado: ${newCount} nuevos, ${updatedCount} actualizados, ${duplicateCount} duplicados, ${priceChanges} cambios de precio`);
        return { new: newCount, updated: updatedCount, priceChanges, duplicates: duplicateCount };
    }

    // =============================================
    // Marcar no disponibles al finalizar el run
    // =============================================

    /**
     * Elimina los productos que no aparecieron en este run.
     * Si el scraper no los vio esta vez, ya no existen en el proveedor.
     * La cascada borra price_history, product_mappings y preventas_sync_state asociados.
     * Debe llamarse UNA SOLA VEZ al finalizar el run completo (no por cada upsert).
     * @param {Date} runStartedAt — timestamp capturado antes de iniciar los upserts
     */
    async markUnavailableSince(runStartedAt) {
        if (this.dryRun) return 0;
        const { rowCount } = await this.pool.query(
            `DELETE FROM supplier_products
             WHERE supplier_id = $1
               AND last_scraped_at < $2`,
            [this.supplier.id, runStartedAt]
        );
        if (rowCount > 0) {
            console.log(`🗑️ ${rowCount} productos eliminados (no aparecieron en este run)`);
        }
        return rowCount;
    }

    // =============================================
    // Limpieza de duplicados existentes
    // =============================================

    /**
     * Colapsa productos duplicados por (supplier_id, name_key).
     * Prioridad para conservar: 1) tiene match en Odoo, 2) SKU más corto, 3) ID más bajo.
     * Los descartados quedan con available = false.
     */
    async cleanupDuplicates() {
        if (this.dryRun) return 0;
        const { rowCount } = await this.pool.query(`
            WITH ranked AS (
                SELECT sp.id,
                    ROW_NUMBER() OVER (
                        PARTITION BY sp.supplier_id, sp.name_key
                        ORDER BY
                            (EXISTS (
                                SELECT 1 FROM preventas_sync_state pss
                                WHERE pss.supplier_product_id = sp.id
                            ))::INT DESC,
                            LENGTH(sp.sku) ASC,
                            sp.id ASC
                    ) AS rn
                FROM supplier_products sp
                WHERE sp.supplier_id = $1
                  AND sp.available = true
                  AND sp.name_key IS NOT NULL
                  AND sp.name_key != ''
            )
            UPDATE supplier_products
            SET available = false, updated_at = NOW()
            WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
        `, [this.supplier.id]);

        if (rowCount > 0) {
            console.log(`🧹 ${rowCount} duplicados colapsados para "${this.supplier.name}"`);
        }
        return rowCount;
    }

    // =============================================
    // Detección de categorías pendientes de mapeo
    // =============================================

    /**
     * Al finalizar el scraping, detecta categorías que no tienen regla activa
     * en supplier_category_rules y las registra en pending_category_mappings.
     * Esto alimenta el badge naranja del sidebar y el panel de resolución.
     */
    async detectPendingCategories() {
        if (this.dryRun) return;

        try {
            // Todas las categorías únicas que se scrapearon
            const { rows: scraped } = await this.pool.query(`
                SELECT DISTINCT source_category
                FROM supplier_products
                WHERE supplier_id = $1 AND source_category IS NOT NULL
            `, [this.supplier.id]);

            if (scraped.length === 0) return;

            // Categorías que ya tienen regla (activa O ignorada — cualquiera cuenta)
            const { rows: mapped } = await this.pool.query(`
                SELECT source_category FROM supplier_category_rules
                WHERE supplier_id = $1
            `, [this.supplier.id]);

            const mappedSet = new Set(mapped.map(r => r.source_category));
            let pendingDetected = 0;

            for (const { source_category } of scraped) {
                if (mappedSet.has(source_category)) continue;

                // Hasta 5 productos de muestra para dar contexto al admin
                const { rows: samples } = await this.pool.query(`
                    SELECT name FROM supplier_products
                    WHERE supplier_id = $1 AND source_category = $2
                    LIMIT 5
                `, [this.supplier.id, source_category]);

                await this.pool.query(`
                    INSERT INTO pending_category_mappings
                        (supplier_id, source_category, sample_products, status)
                    VALUES ($1, $2, $3, 'pending')
                    ON CONFLICT (supplier_id, source_category)
                    DO UPDATE SET
                        sample_products = EXCLUDED.sample_products
                    WHERE pending_category_mappings.status = 'pending'
                `, [
                    this.supplier.id,
                    source_category,
                    JSON.stringify(samples.map(s => s.name))
                ]);

                pendingDetected++;
                console.log(`⚠️ Categoría sin mapeo detectada: "${source_category}"`);
            }

            if (pendingDetected > 0) {
                console.log(`⚠️ ${pendingDetected} categorías nuevas sin mapeo para proveedor "${this.supplier.name}"`);
            }
        } catch (err) {
            console.error('⚠️ Error en detectPendingCategories:', err.message);
            // No propagar — no debe interrumpir el scraping
        }
    }

    // =============================================
    // Orquestador principal
    // =============================================

    /**
     * Ejecuta el scraping completo:
     *  1. Crea el run en DB
     *  2. Conecta a browserless via CHROME_WS_ENDPOINT
     *  3. Obtiene categorías
     *  4. Scrapea cada categoría (si una falla, continúa con las demás)
     *  5. Hace upsert de todos los productos
     *  6. Actualiza el run con los resultados
     *  7. Retorna las estadísticas
     *
     * @param {number|string} triggeredBy — user ID o null
     * @returns {{ runId, found, new, updated, priceChanges, errors }}
     */
    async run(triggeredBy) {
        await this.createRun(triggeredBy);

        let browser = null;

        try {
            const wsEndpoint = process.env.CHROME_WS_ENDPOINT;
            if (!wsEndpoint) {
                throw new Error('CHROME_WS_ENDPOINT no configurado');
            }

            console.log(`📦 Conectando a browserless: ${wsEndpoint}`);
            browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

            // Obtener categorías
            const categoriesPage = await browser.newPage();
            await categoriesPage.setDefaultNavigationTimeout(30000);
            let categories = [];

            try {
                categories = await this.getCategories(categoriesPage);
                console.log(`📦 ${categories.length} categorías encontradas para "${this.supplier.name}"`);
            } catch (err) {
                console.error(`❌ Error obteniendo categorías:`, err.message);
                this.errors.push({ phase: 'getCategories', error: err.message });
            } finally {
                await categoriesPage.close().catch(() => {});
            }

            // Scrapear cada categoría
            for (const category of categories) {
                const page = await browser.newPage();
                await page.setDefaultNavigationTimeout(30000);

                try {
                    console.log(`📦 Scrapeando categoría: "${category.name}" — ${category.url}`);
                    const categoryProducts = await this.scrapeCategory(page, category);
                    console.log(`✅ ${categoryProducts.length} productos en "${category.name}"`);
                    this.products.push(...categoryProducts);

                    // En modo preview, emitir cada producto via callback para SSE
                    if (this.onProduct) {
                        for (const p of categoryProducts) {
                            this.onProduct(p);
                        }
                    }
                } catch (err) {
                    console.error(`❌ Error en categoría "${category.name}":`, err.message);
                    this.errors.push({
                        category: category.name,
                        url: category.url,
                        error: err.message
                    });
                } finally {
                    await page.close().catch(() => {});
                }
            }

            // En dry-run: no persistir nada, retornar los productos directamente
            if (this.dryRun) {
                console.log(`📦 [DRY-RUN] Preview finalizado: ${this.products.length} productos encontrados`);
                return {
                    runId: null,
                    status: 'preview',
                    found: this.products.length,
                    newProducts: 0,
                    updated: 0,
                    priceChanges: 0,
                    products: this.products,
                    errors: this.errors
                };
            }

            // Upsert de todos los productos acumulados
            const runStartedAt = new Date();
            const upsertStats = await this.upsertProducts(this.products);

            // 0 productos = algo falló (web caída, login, selectores): nunca 'completed', así no borra nada
            const finalStatus = this.products.length === 0
                ? 'failed'
                : this.errors.length > 0
                    ? 'partial'
                    : 'completed';

            // Eliminar los que no aparecieron SOLO si el run recorrió todo sin errores
            const markedUnavailable = finalStatus === 'completed'
                ? await this.markUnavailableSince(runStartedAt)
                : 0;

            const stats = {
                found: this.products.length,
                newProducts: upsertStats.new,
                updated: upsertStats.updated,
                priceChanges: upsertStats.priceChanges,
                unavailable: markedUnavailable,
            };

            await this.updateRun(finalStatus, stats);

            // Colapsar duplicados por nombre (misma producto, distintas secciones de catálogo)
            await this.cleanupDuplicates();

            // Detectar categorías nuevas sin mapeo (alimenta el badge del sidebar)
            await this.detectPendingCategories();

            return {
                runId: this.runId,
                status: finalStatus,
                ...stats,
                errors: this.errors
            };

        } catch (err) {
            console.error(`❌ Error fatal en scraper "${this.supplier.name}":`, err.message);
            this.errors.push({ phase: 'run', error: err.message });

            await this.updateRun('failed', {
                found: this.products.length,
                newProducts: 0,
                updated: 0,
                priceChanges: 0
            }).catch(() => {});

            throw err;

        } finally {
            if (browser) {
                await browser.disconnect().catch(() => {});
            }
        }
    }
}

module.exports = BaseScraper;
