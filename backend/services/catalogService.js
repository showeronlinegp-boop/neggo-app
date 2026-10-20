// Servicio de generación de catálogos PDF por categoría destino
// Diseño idéntico al script 2-generador_catalogos.py:
//   - Header limpio: logo + categoría + línea gris (sin barra de color)
//   - Grid 2×2, 9cm×11.5cm por celda
//   - Imagen centrada (7cm×6.5cm) → nombre → SKU → precio naranja

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const pool = require('../config/database');
const { calculatePrices } = require('./rulesEngine');

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

// ── Descarga de imagen ─────────────────────────────────────────────────────────
async function fetchImage(url) {
    if (!url) return null;
    try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 12000);
        const res  = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'NeggoApp/1.0' }
        });
        clearTimeout(tid);
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch (err) {
        console.warn(`⚠️ fetchImage falló para ${url}: ${err.message}`);
        return null;
    }
}

// Descarga imágenes con concurrencia limitada para evitar timeouts por saturación
async function fetchImagesConcurrent(items, concurrency = 4) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fetchImage(items[i].image_url);
        }
    }

    const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(pool);
    return results;
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

// ── Obtener productos por categoría destino ────────────────────────────────────
async function getProductsByDestCategory(destCategory, type = 'preventas') {
    // La columna de destino depende de la empresa objetivo del catálogo
    const destCol = type === 'neggo' ? 'dest_category_neggo' : 'dest_category_preventas';

    const { rows } = await pool.query(`
        SELECT
            sp.id, sp.name, sp.sku, sp.raw_price, sp.image_url, sp.source_category,
            s.id          AS supplier_id,
            s.name        AS supplier_name,
            s.default_discount,
            s.default_markup,
            s.markup_neggo,
            s.markup_preventas,
            scr.discount_override,
            scr.markup_override,
            scr.markup_neggo_override,
            scr.markup_preventas_override
        FROM supplier_products sp
        JOIN suppliers s
            ON s.id = sp.supplier_id
            AND s.active = true
            AND s.is_published = true
        JOIN supplier_category_rules scr
            ON scr.supplier_id = sp.supplier_id
            AND scr.source_category = sp.source_category
            AND scr.active = true
            AND COALESCE(scr.ignored, false) = false
            AND scr.${destCol} = $1
        WHERE sp.available = true
            AND sp.raw_price IS NOT NULL
            AND sp.raw_price > 0
        ORDER BY s.name ASC, sp.name ASC
    `, [destCategory]);
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

    const products = await getProductsByDestCategory(destCategory, type);
    if (products.length === 0) {
        throw new Error(`No hay productos disponibles para la categoría "${destCategory}"`);
    }

    console.log(`📦 Generando catálogo "${destCategory}" (${type}): ${products.length} productos`);

    // Calcular precios (síncrono, liviano)
    const priced = products.map(p => {
        const supplier = {
            default_discount: p.default_discount,
            default_markup:   p.default_markup,
            markup_neggo:     p.markup_neggo,
            markup_preventas: p.markup_preventas,
        };
        const rule = {
            discount_override:         p.discount_override,
            markup_override:           p.markup_override,
            markup_neggo_override:     p.markup_neggo_override,
            markup_preventas_override: p.markup_preventas_override,
        };
        return { ...p, salePrice: calculatePrices(p, supplier, rule, type).sale_price };
    });

    // Descargar imágenes con concurrencia limitada (12 a la vez) — balance entre velocidad y no saturar
    const imageBuffers = await fetchImagesConcurrent(priced, 12);

    const enriched = priced.map((p, i) => ({
        name: p.name,
        sku:  p.sku,
        salePrice: p.salePrice,
        imageBuffer: imageBuffers[i],
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
    const destCol = type === 'neggo' ? 'dest_category_neggo' : 'dest_category_preventas';

    const { rows } = await pool.query(`
        SELECT DISTINCT scr.${destCol} AS dest_category
        FROM supplier_category_rules scr
        JOIN suppliers s ON s.id = scr.supplier_id AND s.active = true AND s.is_published = true
        WHERE scr.active = true
          AND COALESCE(scr.ignored, false) = false
          AND scr.${destCol} IS NOT NULL
        ORDER BY 1 ASC
    `);

    const categories = rows.map(r => r.dest_category);
    if (categories.length === 0) throw new Error('No hay categorías destino configuradas');

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

module.exports = { generateCatalog, generateAllCatalogs };
