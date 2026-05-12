'use strict';

/**
 * ElReyScraper — El Rey (catálogo SmartyCart tokenizado)
 * URL base: https://catalog.smartycart.com.ar/token/{token}
 *
 * Estructura DOM confirmada:
 *   div.itemWrapper
 *     div.item
 *       div.item-image > a.lnkGallery[href] > img.item-image-primary[src]
 *       div.item-details
 *         h5.item-name
 *         span.reference        ← SKU/código
 *         span.discountPrice    ← precio con descuento
 *         span.origDiscountPrice ← precio lista original
 */

const BaseScraper = require('./baseScraper');

class ElReyScraper extends BaseScraper {

    get baseUrl() {
        return (this.supplier.website_url || '').replace(/\/$/, '');
    }

    get domain() {
        return new URL(this.baseUrl).origin;
    }

    // ==========================================================
    // Obtener categorías desde el menú del sitio
    // ==========================================================

    async getCategories() {
        const base = this.baseUrl;
        const categories = [
            { url: `${base}/?category_id=9732`, name: 'Hogar y Bazar' },
            { url: `${base}/?category_id=9728`, name: 'Artículos Kiosco' },
            { url: `${base}/?category_id=7335`, name: 'General' },
            { url: `${base}/?category_id=9730`, name: 'Insecticidas' },
            { url: `${base}/?category_id=9727`, name: 'Perfumería' },
        ];
        console.log(`📦 ${categories.length} categorías configuradas para ${this.supplier.name}`);
        return categories;
    }

    // ==========================================================
    // Scrapear una categoría con paginación ?page=N
    // ==========================================================

    async scrapeCategory(page, category) {
        const products = [];
        let pageNum = 1;
        let emptyStreak = 0;

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        while (true) {
            const url = this._buildPageUrl(category.url, pageNum);
            console.log(`📦 "${category.name}" pág. ${pageNum}: ${url}`);

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, 1500));

                const hasItems = await page.waitForSelector('div.itemWrapper', { timeout: 10000 })
                    .then(() => true)
                    .catch(() => false);

                if (!hasItems) {
                    emptyStreak++;
                    if (emptyStreak >= 2) {
                        console.log(`📦 Fin de paginación en "${category.name}" pág. ${pageNum}`);
                        break;
                    }
                    pageNum++;
                    continue;
                }

                const pageProducts = await page.evaluate((domain) => {
                    return Array.from(document.querySelectorAll('div.itemWrapper'))
                        .map(wrapper => {
                            try {
                                const nameEl = wrapper.querySelector('h5.item-name');
                                const name = nameEl ? nameEl.textContent.trim() : null;
                                if (!name) return null;

                                const skuEl = wrapper.querySelector('span.reference');
                                const sku = skuEl ? skuEl.textContent.trim() : null;

                                const priceEl = wrapper.querySelector('span.discountPrice');
                                const rawPriceText = priceEl ? priceEl.textContent.trim() : null;

                                const listPriceEl = wrapper.querySelector('span.origDiscountPrice');
                                const listPriceText = listPriceEl ? listPriceEl.textContent.trim() : null;

                                const imgEl = wrapper.querySelector('img.item-image-primary');
                                const imgSrc = imgEl
                                    ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || null)
                                    : null;
                                const imageUrl = imgSrc
                                    ? (imgSrc.startsWith('/') ? domain + imgSrc : imgSrc)
                                    : null;

                                const linkEl = wrapper.querySelector('a.lnkGallery');
                                const href = linkEl ? linkEl.getAttribute('href') : null;
                                const productUrl = href
                                    ? (href.startsWith('/') ? domain + href : href)
                                    : null;

                                return { name, sku, rawPriceText, listPriceText, imageUrl, productUrl };
                            } catch (e) {
                                return null;
                            }
                        })
                        .filter(Boolean);
                }, this.domain);

                if (pageProducts.length === 0) {
                    emptyStreak++;
                    if (emptyStreak >= 2) {
                        console.log(`📦 Fin de paginación en "${category.name}" pág. ${pageNum}`);
                        break;
                    }
                } else {
                    emptyStreak = 0;
                    for (const raw of pageProducts) {
                        products.push({
                            sku:             raw.sku,
                            name:            raw.name,
                            raw_price:       this.parsePrice(raw.rawPriceText),
                            offer_price:     raw.listPriceText ? this.parsePrice(raw.listPriceText) : null,
                            image_url:       raw.imageUrl,
                            product_url:     raw.productUrl,
                            source_category: category.name,
                            barcode:         null,
                        });
                    }
                    console.log(`✅ "${category.name}" pág. ${pageNum}: ${pageProducts.length} productos`);
                }

            } catch (err) {
                console.error(`❌ Error en "${category.name}" pág. ${pageNum}:`, err.message);
                this.errors.push({ category: category.name, page: pageNum, error: err.message });
                break;
            }

            pageNum++;
            if (pageNum > 100) {
                console.log(`⚠️ Límite de 100 páginas en "${category.name}"`);
                break;
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        return products;
    }

    // ==========================================================
    // Helper
    // ==========================================================

    _buildPageUrl(categoryUrl, pageNum) {
        if (pageNum === 1) return categoryUrl;
        const url = new URL(categoryUrl);
        url.searchParams.set('page', pageNum);
        return url.toString();
    }
}

module.exports = ElReyScraper;
