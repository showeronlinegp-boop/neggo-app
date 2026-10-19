// Servicio de generación de catálogos PDF por categoría de Odoo
// Productos, precios y categorías salen de odoo_products_cache (sync de Odoo) y las
// imágenes de product.template, siempre de la empresa elegida (Neggo o Preventas).
// Diseño idéntico al script 2-generador_catalogos.py:
//   - Header limpio: logo + categoría + línea gris (sin barra de color)
//   - Grid 2×2, 9cm×11.5cm por celda
//   - Imagen centrada (7cm×6.5cm) → nombre → SKU → precio naranja

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');

// ── Medidas (1cm = 28.3465pt) ──────────────────────────────────────────────────
const CM = 28.3465;

const PAGE_W  = 595.28;   // A4
const PAGE_H  = 841.89;

const MAR_L   = 1.5 * CM; // 42.52pt
const MAR_R   = 1.5 * CM;
const MAR_TOP = 4.0 * CM; // 113.39pt — área de contenido empieza aquí
const MAR_BOT = 2.0 * CM; // 56.69pt

const COL_W   = 9.0 * CM; // 255.12pt — ancho de columna (2 columnas = usable width)
const ROW_H   = 11.5 * CM; // 326pt — altura de fila

const INNER_W = 8.5 * CM; // 240.95pt — ancho interno de cada celda
const IMG_W   = 7.0 * CM; // 198.45pt — ancho imagen
const IMG_H   = 6.5 * CM; // 184.25pt — alto imagen
const NAME_H  = 2.0 * CM; // 56.69pt
const CODE_H  = 1.0 * CM; // 28.35pt
const PRICE_H = 1.0 * CM; // 28.35pt

const CONTENT_Y = MAR_TOP; // y donde empieza la grilla

// ── Colores ────────────────────────────────────────────────────────────────────
const PRIMARY   = '#003366';
const SECONDARY = '#FF6600';
const DARK_TEXT = '#333333';
const GRAY_TEXT = '#666666';
const LINE_GRAY = '#DADADA';

// Logo en el volumen montado en el contenedor (/app/storage). Si no está,
// el header usa el texto "neggo".
const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(__dirname, '..', 'storage');
const LOGO_PATH    = path.join(STORAGE_ROOT, 'neggo_logo.png');
const STORAGE_DIR  = path.join(__dirname, '..', 'storage', 'catalogs');
const PRODUCTS_PER_PAGE = 4;

// Entero con punto de miles ($1.234). No usa toLocaleString: en node:20-alpine
// el locale es-AR no está instalado y el precio sale con coma de miles.
function formatPrice(amount) {
    const n = Math.ceil(Number(amount));
    const safe = Number.isFinite(n) ? n : 0;
    const sign = safe < 0 ? '-' : '';
    const grouped = String(Math.abs(safe)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}$${grouped}`;
}

// ── Imágenes desde Odoo ────────────────────────────────────────────────────────
// Se piden en lotes por product.template: image_512 alcanza para impresión sin traer
// el original. Las variantes comparten la imagen de su template.
const IMG_BATCH = 40;

async function fetchOdooImages(templateIds, company, concurrency = 3) {
    const map = {};
    const unique = [...new Set(templateIds.filter(Boolean))];
    if (unique.length === 0) return map;

    const ids = await getCompanyIds();
    const context = ids[company] ? { allowed_company_ids: [ids[company]] } : {};

    const batches = [];
    for (let i = 0; i < unique.length; i += IMG_BATCH) batches.push(unique.slice(i, i + IMG_BATCH));

    let cursor = 0;
    async function worker() {
        while (cursor < batches.length) {
            const batch = batches[cursor++];
            try {
                const rows = await callOdoo('product.template', 'read', [batch], { fields: ['image_512'], context });
                for (const r of rows || []) {
                    if (r.image_512) map[r.id] = Buffer.from(r.image_512, 'base64');
                }
            } catch (err) {
                console.warn(`⚠️ No se pudieron traer imágenes de Odoo (lote de ${batch.length}): ${err.message}`);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
    return map;
}

// ── Header (logo + categoría + línea) ─────────────────────────────────────────
function drawHeader(doc, categoryName) {
    const logoH   = 1.5 * CM;  // 42.52pt
    const logoW   = 4.0 * CM;  // 113.39pt
    const logoTop = (MAR_TOP - logoH - 1.6 * CM); // centra en el espacio del header

    // Logo o texto de fallback
    let logoOk = false;
    if (fs.existsSync(LOGO_PATH)) {
        try {
            doc.image(LOGO_PATH, MAR_L, logoTop, {
                width: logoW,
                height: logoH,
                fit: [logoW, logoH],
                align: 'left',
                valign: 'center'
            });
            logoOk = true;
        } catch { /* cae al texto */ }
    }
    if (!logoOk) {
        doc.font('Helvetica-Bold')
           .fontSize(28)
           .fillColor(SECONDARY)
           .text('neggo', MAR_L, logoTop, { continued: false });
    }

    // Nombre de la categoría debajo del logo
    const catY = logoTop + logoH + 4;
    doc.font('Helvetica')
       .fontSize(14)
       .fillColor(GRAY_TEXT)
       .text(categoryName, MAR_L, catY, { continued: false });

    // Línea separadora horizontal
    const lineY = CONTENT_Y - 6;
    doc.moveTo(MAR_L, lineY)
       .lineTo(PAGE_W - MAR_R, lineY)
       .strokeColor(LINE_GRAY)
       .lineWidth(0.5)
       .stroke();
}

// ── Placeholder cuando no hay imagen ──────────────────────────────────────────
function drawPlaceholder(doc, x, y, w, h) {
    doc.rect(x, y, w, h)
       .fillAndStroke('#F0F0F0', '#DDDDDD');
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor(GRAY_TEXT)
       .text('sin imagen', x, y + h / 2 - 5, { width: w, align: 'center' });
}

// ── Dibujar una tarjeta de producto ───────────────────────────────────────────
//   Layout exacto del script Python:
//   [imagen 7×6.5cm centrada]
//   [nombre 2cm, font 10, centrado]
//   [SKU 1cm, font 8, gris, centrado]
//   [precio 1cm, font 14 bold, naranja, centrado]
async function drawCard(doc, product, col, row) {
    // Esquina superior izquierda de la celda externa (9cm)
    const cellX = MAR_L + col * COL_W;
    const cellY = CONTENT_Y + row * ROW_H;

    // Padding horizontal para centrar la celda interna (8.5cm) dentro de la columna (9cm)
    const padX = (COL_W - INNER_W) / 2; // ≈ 7pt

    // ── Imagen ──
    const imgX = cellX + padX + (INNER_W - IMG_W) / 2; // centrada dentro de 8.5cm
    const imgY = cellY + 8; // pequeño padding superior

    if (product.imageBuffer) {
        try {
            doc.image(product.imageBuffer, imgX, imgY, {
                width: IMG_W,
                height: IMG_H,
                fit: [IMG_W, IMG_H],
                align: 'center',
                valign: 'center'
            });
        } catch {
            drawPlaceholder(doc, imgX, imgY, IMG_W, IMG_H);
        }
    } else {
        drawPlaceholder(doc, imgX, imgY, IMG_W, IMG_H);
    }

    // ── Nombre ──
    const nameY = imgY + IMG_H + 6;
    doc.font('Helvetica')
       .fontSize(10)
       .fillColor(DARK_TEXT)
       .text(product.name, cellX + padX, nameY, {
           width: INNER_W,
           height: NAME_H,
           align: 'center',
           ellipsis: true
       });

    // ── SKU / código ──
    if (product.sku) {
        const codeY = nameY + NAME_H;
        doc.font('Helvetica')
           .fontSize(8)
           .fillColor(GRAY_TEXT)
           .text(product.sku, cellX + padX, codeY, {
               width: INNER_W,
               height: CODE_H,
               align: 'center',
               ellipsis: true
           });
    }

    // ── Precio ──
    const priceY = nameY + NAME_H + CODE_H;
    doc.font('Helvetica-Bold')
       .fontSize(14)
       .fillColor(SECONDARY)
       .text(formatPrice(product.salePrice), cellX + padX, priceY, {
           width: INNER_W,
           align: 'center'
       });
}

// ── Productos de Odoo por categoría ───────────────────────────────────────────
// Entran los activos, publicados, con precio de venta y no archivados localmente
const PRODUCT_FILTER = `
    company = $1
    AND active = true
    AND locally_archived = false
    AND is_published = true
    AND list_price > 0
    AND NULLIF(TRIM(categ_name), '') IS NOT NULL
`;

async function getProductsByCategory(category, company) {
    const { rows } = await pool.query(`
        SELECT odoo_id, template_id, name, internal_ref, list_price, has_image
        FROM odoo_products_cache
        WHERE ${PRODUCT_FILTER}
          AND categ_name = $2
        ORDER BY name ASC
    `, [company, category]);
    return rows;
}

/**
 * Categorías de Odoo que tienen productos para catálogo, con su cantidad.
 * @param {'preventas'|'neggo'} company
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
async function getCatalogCategories(company) {
    const { rows } = await pool.query(`
        SELECT categ_name AS name, COUNT(*)::int AS count
        FROM odoo_products_cache
        WHERE ${PRODUCT_FILTER}
        GROUP BY categ_name
        ORDER BY categ_name ASC
    `, [company]);
    return rows;
}

// ── Función principal ──────────────────────────────────────────────────────────

/**
 * Genera un PDF de catálogo para una categoría destino.
 * Diseño idéntico al script 2-generador_catalogos.py.
 *
 * @param {object} opts
 * @param {string} opts.destCategory  — Ej: "Bazar"
 * @param {string} [opts.type]        — 'preventas' | 'neggo'
 * @param {number} opts.createdBy     — ID del usuario
 */
async function generateCatalog({ destCategory, type = 'preventas', createdBy }) {
    if (!['preventas', 'neggo'].includes(type)) {
        throw new Error(`Tipo inválido: "${type}". Usar 'preventas' o 'neggo'`);
    }

    const products = await getProductsByCategory(destCategory, type);
    if (products.length === 0) {
        throw new Error(`No hay productos de Odoo publicados y con precio en la categoría "${destCategory}"`);
    }

    console.log(`📦 Generando catálogo "${destCategory}" (${type}): ${products.length} productos`);

    // Precio de venta tal cual está en Odoo; imágenes desde product.template
    const images = await fetchOdooImages(products.filter(p => p.has_image).map(p => p.template_id), type);

    const enriched = products.map(p => ({
        name: p.name,
        sku:  p.internal_ref,
        salePrice: Number(p.list_price),
        imageBuffer: (p.template_id && images[p.template_id]) || null,
    }));

    const withImages = enriched.filter(p => p.imageBuffer).length;
    console.log(`🖼️  Imágenes descargadas: ${withImages}/${enriched.length}`);

    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    const timestamp = Date.now();
    const slug      = destCategory.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const fileName  = `${timestamp}_${slug}_${type}.pdf`;
    const filePath  = path.join(STORAGE_DIR, fileName);

    const totalPages = Math.ceil(enriched.length / PRODUCTS_PER_PAGE);

    const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
            Title:   `Catálogo ${destCategory}`,
            Author:  'Neggo',
            Subject: type === 'preventas' ? 'Catálogo Preventas' : 'Catálogo Neggo',
        }
    });

    const ws = fs.createWriteStream(filePath);
    doc.pipe(ws);

    let pageNum = 1;

    for (let i = 0; i < enriched.length; i++) {
        const pos = i % PRODUCTS_PER_PAGE;

        // Nueva página
        if (pos === 0 && i > 0) {
            doc.addPage();
            pageNum++;
        }

        // Header en cada página nueva
        if (pos === 0) {
            drawHeader(doc, destCategory);
        }

        const col = pos % 2;
        const row = Math.floor(pos / 2);
        await drawCard(doc, enriched[i], col, row);
    }

    // Pie de página en la última página
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor(GRAY_TEXT)
       .text(
           `Neggo Mayorista — Pergamino, Buenos Aires — ${new Date().getFullYear()}`,
           MAR_L,
           PAGE_H - MAR_BOT + 8,
           { width: PAGE_W - MAR_L - MAR_R, align: 'center' }
       );

    doc.end();
    await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
    });

    const fileSize = fs.statSync(filePath).size;

    const { rows } = await pool.query(
        `INSERT INTO catalogs (name, type, category, file_path, product_count, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
            `Catálogo ${destCategory} — ${type === 'preventas' ? 'Preventas' : 'Neggo'}`,
            type,
            destCategory,
            filePath,
            enriched.length,
            createdBy
        ]
    );

    const catalogId = rows[0].id;
    console.log(`✅ Catálogo id=${catalogId} — ${fileName} — ${enriched.length} productos — ${(fileSize / 1024).toFixed(1)}KB`);

    return { catalogId, filePath, fileName, productCount: enriched.length, fileSize, category: destCategory, type, totalPages };
}

// ── Generar todos los catálogos ────────────────────────────────────────────────
async function generateAllCatalogs({ type = 'preventas', createdBy }) {
    const categories = (await getCatalogCategories(type)).map(c => c.name);
    if (categories.length === 0) throw new Error('No hay categorías de Odoo con productos publicados');

    console.log(`📦 Generando ${categories.length} catálogos en batch (${type})...`);

    const results = [];
    for (const cat of categories) {
        try {
            const result = await generateCatalog({ destCategory: cat, type, createdBy });
            results.push({ category: cat, success: true, ...result });
        } catch (err) {
            console.warn(`⚠️ Omitida "${cat}": ${err.message}`);
            results.push({ category: cat, success: false, error: err.message });
        }
    }

    const ok = results.filter(r => r.success).length;
    console.log(`✅ Batch: ${ok}/${categories.length} catálogos generados`);
    return results;
}

module.exports = { generateCatalog, generateAllCatalogs, getCatalogCategories };
