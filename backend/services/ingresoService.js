// Servicio de ingreso de mercadería
// Orquestracion: parse CSV -> match -> validate -> update stock/prices -> crear purchase.order

const pool = require('../config/database');
const papa = require('papaparse');
const odooService = require('./odooService');

// =============================================
// 1. PARSEO CSV
// =============================================

/**
 * Normaliza un header de CSV: minúsculas, sin acentos, sin caracteres especiales.
 * "Código" → "codigo", "Precio ($)" → "precio", "Importe ($)" → "importe"
 */
function normalizeHeader(h) {
    return h.trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Parsea un monto de la factura.
 * Formato argentino: "7.854,00" → 7854, "$ 1.234" → 1234.
 * Sin coma y con 1 o 2 decimales tras el punto es decimal: "1234.56" → 1234.56
 * (así exporta Excel con configuración en inglés; antes daba 123456).
 */
function parsePrecio(val) {
    if (val === null || val === undefined || val === '') return 0;
    let s = String(val).replace(/[$\s ]/g, '');
    if (s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (!/^-?\d+\.\d{1,2}$/.test(s)) {
        s = s.replace(/\./g, '');
    }
    return parseFloat(s) || 0;
}

/**
 * Cantidad entera. "1.000" es mil (separador de miles) y "5,00" es cinco.
 * "2,5" no es una cantidad válida: devuelve NaN en vez de truncar a 2.
 */
function parseCantidad(val) {
    const s = String(val ?? '').replace(/[\s ]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
    if (/^\d+([.,]0+)?$/.test(s)) return parseInt(s, 10);
    return NaN;
}

/**
 * Los CSV que guarda Excel en Windows suelen venir en Latin-1. Leídos como UTF-8,
 * la "ó" de "Descripción" se rompe y la columna no se reconoce.
 */
function decodeCsv(buffer) {
    const utf8 = buffer.toString('utf-8');
    return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

/**
 * Claves para buscar el código de la factura entre los SKU scrapeados del proveedor.
 * Los scrapers guardan PRE + prefijo + código ("PRECT0440209"); la factura trae "0440209".
 */
function supplierSkuKeys(codigo, supplierPrefix) {
    const norm = (s) => String(s || '').replace(/[-\s]/g, '').toUpperCase();
    const code = norm(codigo);
    const pref = norm(supplierPrefix);
    if (!code) return [];
    const keys = [code];
    if (pref && !code.startsWith(`PRE${pref}`)) keys.push(`PRE${pref}${code}`);
    return keys;
}

async function parseCSV(fileBuffer) {
    return new Promise((resolve) => {
        const csvString = decodeCsv(fileBuffer);

        papa.parse(csvString, {
            header: true,
            dynamicTyping: false,
            skipEmptyLines: true,
            transformHeader: normalizeHeader,
            complete: (results) => {
                const data   = [];
                const errors = [];

                results.data.forEach((row, idx) => {
                    try {
                        const codigo = (row.codigo || row.code || '').trim();
                        const descripcion = (row.descripcion || row.description || row.desc || '').trim();
                        const cantidadRaw = row.cantidad || row.quantity || row.cant || '';
                        const cantidad = parseCantidad(cantidadRaw);
                        const precioRaw = row.precio || row['precio unitario'] || row.unit_price || row.price || '';
                        const precioUnitario = parsePrecio(precioRaw);
                        const subtotalRaw = row.subtotal || row.importe || row.total || row.monto || '';
                        const subtotal = parsePrecio(subtotalRaw);

                        if (!codigo && !descripcion) {
                            errors.push({ row: idx + 1, error: 'Fila sin código ni descripción', data: row });
                            return;
                        }

                        if (isNaN(cantidad) || cantidad <= 0) {
                            errors.push({ row: idx + 1, error: `Cantidad inválida: "${cantidadRaw}"`, data: row });
                            return;
                        }

                        if (precioUnitario <= 0) {
                            errors.push({ row: idx + 1, error: `Precio inválido: "${precioRaw}"`, data: row });
                            return;
                        }

                        data.push({
                            codigo,
                            descripcion,
                            cantidad,
                            precio_unitario: precioUnitario,
                            subtotal: subtotal || Math.round(cantidad * precioUnitario * 100) / 100
                        });
                    } catch (err) {
                        errors.push({ row: idx + 1, error: err.message, data: row });
                    }
                });

                // Deduplicar: si el mismo artículo aparece varias veces (mismo código
                // o misma descripción si no hay código), sumar cantidades y subtotales.
                const seenKeys = new Map();
                const deduped  = [];
                for (const item of data) {
                    const key = (item.codigo || item.descripcion).toLowerCase().trim();
                    if (seenKeys.has(key)) {
                        const prev    = seenKeys.get(key);
                        prev.cantidad += item.cantidad;
                        prev.subtotal  = Math.round((prev.subtotal + item.subtotal) * 100) / 100;
                    } else {
                        seenKeys.set(key, item);
                        deduped.push(item);
                    }
                }

                resolve({
                    success: deduped.length > 0,
                    data: deduped,
                    errors,
                    total_monto: deduped.reduce((sum, item) => sum + item.subtotal, 0)
                });
            },
            error: (err) => {
                resolve({
                    success: false,
                    data: [],
                    errors: [{ error: `Parse CSV error: ${err.message}` }],
                    total_monto: 0
                });
            }
        });
    });
}

// =============================================
// 2. MATCHING: CSV items -> Odoo products (neggo)
// =============================================

/**
 * Normaliza string para comparación: minúsculas, sin acentos, solo alfanuméricos.
 */
function normalize(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Similitud de Levenshtein entre dos strings [0..1].
 */
function similarity(a, b) {
    const la = a.length, lb = b.length;
    if (la === 0) return lb === 0 ? 1 : 0;
    if (lb === 0) return 0;
    let prev = Array.from({ length: lb + 1 }, (_, i) => i);
    let curr = new Array(lb + 1);
    for (let i = 1; i <= la; i++) {
        curr[0] = i;
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return 1 - prev[lb] / Math.max(la, lb);
}

// Niveles que sugieren un producto pero quedan 'pending' hasta que una persona confirme.
// 'ref_other_prefix' se vincula solo: lo decidió el usuario (nota de prueba #26).
const MATCH_LEVELS_TO_CONFIRM = ['fuzzy_name'];

// Un parecido de nombre no se auto-confirma. Sí se confirma si el nombre
// normalizado es el mismo (mayúsculas, acentos y espacios).
function nameMatchDecision(descripcion, productName) {
    const a = normalize(descripcion);
    const b = normalize(productName);
    if (!a || !b) return null;
    if (a === b) {
        return { matchLevel: 'exact_name', estado: 'matched', confidence: 1 };
    }
    const sim = similarity(a, b);
    if (sim >= 0.72) {
        return {
            matchLevel: 'fuzzy_name',
            estado: 'pending',
            confidence: Math.round(sim * 1000) / 1000,
        };
    }
    return null;
}

// Referencia interna sin el prefijo de proveedor: "MG-BR8003021" → "BR8003021".
// Sirve cuando el producto se cargó en Odoo con el prefijo de otro proveedor.
// Devuelve null si la referencia no arranca con ninguno de los prefijos.
function refWithoutSupplierPrefix(internalRef, prefixes) {
    const ref = String(internalRef || '').replace(/[-\s]/g, '').toUpperCase();
    for (const raw of prefixes) {
        const pref = String(raw || '').replace(/[-\s]/g, '').toUpperCase();
        if (pref && ref.length > pref.length && ref.startsWith(pref)) return ref.slice(pref.length);
    }
    return null;
}

// Índice código-sin-prefijo → productos que lo tienen.
function buildRefWithoutPrefixIndex(products, prefixes) {
    const index = new Map();
    for (const p of products) {
        const key = refWithoutSupplierPrefix(p.internal_ref, prefixes);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(p);
    }
    return index;
}

// Busca el código en el índice. Solo vincula si hay un único producto (activo,
// o si no hay activos, uno solo inactivo) y el código es suficientemente largo
// para no confundir "0001" de un proveedor con el de otro.
const MIN_CODE_LEN_OTHER_PREFIX = 5;
function matchByRefWithoutPrefix(index, codigo) {
    const code = String(codigo || '').replace(/[-\s]/g, '').toUpperCase();
    if (code.length < MIN_CODE_LEN_OTHER_PREFIX) return null;
    const candidates = index.get(code) || [];
    const activos = candidates.filter(p => p.active !== false);
    const elegibles = activos.length > 0 ? activos : candidates;
    return elegibles.length === 1 ? elegibles[0] : null;
}

// Índice descripción de compra normalizada → productos que la tienen.
function buildDescPurchaseIndex(products) {
    const index = new Map();
    for (const p of products) {
        const key = normalize(p.description_purchase);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(p);
    }
    return index;
}

// La referencia del producto contradice el código de la factura: el producto
// tiene referencia y no es ese código (ni con ni sin prefijo de proveedor).
function refContradictsCode(internalRef, codigo, prefixes) {
    const ref = String(internalRef || '').replace(/[-\s]/g, '').toUpperCase();
    const code = String(codigo || '').replace(/[-\s]/g, '').toUpperCase();
    if (!ref || !code) return false;
    if (ref === code) return false;
    return refWithoutSupplierPrefix(ref, prefixes) !== code;
}

// Vincula por descripción de compra solo si la descripción es de un único
// producto y su referencia no contradice el código. Una descripción genérica
// ("BROCHES") no alcanza para elegir producto (nota de prueba #35).
function matchByDescPurchase(index, descripcion, codigo, prefixes) {
    const candidates = index.get(normalize(descripcion)) || [];
    if (candidates.length !== 1) return null;
    const p = candidates[0];
    return refContradictsCode(p.internal_ref, codigo, prefixes) ? null : p;
}

// Reparte una cantidad de preventa entre renglones del mismo código,
// sin pasar la cantidad de cada renglón. El sobrante no se asigna.
function allocatePreventaQty(rows, requestedQty) {
    const ordered = [...rows].sort((a, b) => a.id - b.id);
    const caps = ordered.map(r => Math.max(0, parseInt(r.cantidad, 10) || 0));
    const totalCap = caps.reduce((s, n) => s + n, 0);
    let remaining = Math.min(Math.max(0, parseInt(requestedQty, 10) || 0), totalCap);
    return ordered.map((r, i) => {
        const take = Math.min(remaining, caps[i]);
        remaining -= take;
        return { id: r.id, preventa_qty_confirmed: take };
    });
}

// La OC de Preventas no puede llevar más unidades que las confirmadas en el renglón.
function capPreventaShares(item) {
    const cantidad = Math.max(0, parseInt(item.cantidad, 10) || 0);
    const prevQty = Math.min(Math.max(0, parseInt(item.preventa_qty_confirmed, 10) || 0), cantidad);
    if (prevQty <= 0) return [];

    const links = Array.isArray(item.preventa_links) && item.preventa_links.length > 0
        ? item.preventa_links
        : [{
            preventas_product_id: item.preventas_product_id || null,
            preventas_product_name: item.preventas_product_name || null,
            qty: prevQty,
        }];

    const sum = links.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0);
    if (sum <= 0) return [{ ...links[0], qty: prevQty }];

    let assigned = 0;
    return links.map((l, i) => {
        const rawQty = parseInt(l.qty, 10) || 0;
        const part = i === links.length - 1
            ? prevQty - assigned
            : Math.floor(prevQty * rawQty / sum);
        assigned += part;
        return { ...l, qty: part };
    }).filter(l => l.qty > 0);
}

async function distributePreventaQty(db, ingresoId, itemId, requestedQty) {
    const { rows: [seed] } = await db.query(
        `SELECT id, codigo, cantidad FROM ingreso_items WHERE id = $1 AND ingreso_id = $2`,
        [itemId, ingresoId]
    );
    if (!seed) return [];

    const codigo = (seed.codigo || '').trim();
    const { rows } = codigo
        ? await db.query(
            `SELECT id, cantidad FROM ingreso_items
             WHERE ingreso_id = $1 AND UPPER(codigo) = UPPER($2)
             ORDER BY id`,
            [ingresoId, codigo]
        )
        : { rows: [seed] };

    const allocation = allocatePreventaQty(rows, requestedQty);
    for (const row of allocation) {
        await db.query(
            `UPDATE ingreso_items SET preventa_qty_confirmed = $1 WHERE id = $2`,
            [row.preventa_qty_confirmed, row.id]
        );
    }

    const ids = allocation.map(r => r.id);
    const { rows: updated } = await db.query(
        `SELECT id, codigo, cantidad, preventa_qty_confirmed, preventas_product_id, preventas_product_name
         FROM ingreso_items WHERE id = ANY($1::int[]) ORDER BY id`,
        [ids]
    );
    return updated;
}

/**
 * Precio de lista que se escribe en Odoo.
 * Si no se pidió aplicar precio, se conserva el de ahora. Nunca se reemplaza por el costo.
 * @returns {number|null}
 */
function listPriceForOdoo(applyPrice, newListPrice, currentList) {
    const chosen = applyPrice ? newListPrice : currentList;
    if (chosen == null || chosen === '') return null;
    const n = Number(chosen);
    return Number.isFinite(n) ? n : null;
}

/**
 * Empresas a las que había que crearles OC y no quedó id.
 * Sin partner no se pide OC: confirmar solo actualiza precios.
 * @returns {string[]}
 */
function missingPurchaseOrders({ partnerId, neggoLineCount, prevLineCount, neggoId, prevId }) {
    if (!partnerId) return [];
    const missing = [];
    if (neggoLineCount > 0 && !neggoId) missing.push('Neggo');
    if (prevLineCount > 0 && !prevId) missing.push('Preventas');
    return missing;
}

async function persistPurchaseOrderIds(ingresoId, neggoId, preventasId, db = pool) {
    if (!neggoId && !preventasId) return;
    await db.query(
        `UPDATE ingreso_mercaderia
         SET odoo_purchase_order_id = COALESCE(odoo_purchase_order_id, $2),
             odoo_purchase_order_id_preventas = COALESCE(odoo_purchase_order_id_preventas, $3)
         WHERE id = $1`,
        [ingresoId, neggoId || null, preventasId || null]
    );
}

/**
 * Para cada item CSV, intenta matchear con un producto Odoo (empresa neggo).
 * Niveles en orden (el 1, por product_mappings, se sacó: Ingresos no lee la tabla maestra):
 *   2. internal_ref exacto (codigo === internal_ref)
 *   3. internal_ref sin prefijo (internal_ref termina en codigo)
 *   4. barcode exacto
 *   5. fuzzy por nombre (umbral 0.72)
 *
 * @param {Array} items — items parseados
 * @param {number|null} supplierId
 * @returns {Promise<Array>} items enriquecidos
 */
async function matchItems(items, supplierId = null) {
    // Solo se carga el cache de Neggo. El matching es exclusivo contra Neggo.
    // La relación con Preventas se resuelve en preventa-odoo-match (pestaña Preventa).
    const { rows: odooCache } = await pool.query(
        `SELECT odoo_id, name, internal_ref, barcode, standard_price, list_price, active, description_purchase
         FROM odoo_products_cache WHERE company = 'neggo'`
    );

    // Índices Neggo
    const byRef          = new Map(); // internal_ref exacto (con guiones)
    const byRefNorm      = new Map(); // internal_ref normalizado (sin guiones/espacios)
    const byBcode        = new Map();
    for (const p of odooCache) {
        if (p.internal_ref) {
            byRef.set(p.internal_ref.toUpperCase(), p);
            const normKey = p.internal_ref.replace(/[-\s]/g, '').toUpperCase();
            if (!byRefNorm.has(normKey)) byRefNorm.set(normKey, p);
        }
        if (p.barcode)              byBcode.set(p.barcode, p);
    }
    const byDescPurchase = buildDescPurchaseIndex(odooCache);

    // Si hay supplierId, obtener el prefijo del proveedor
    let supplierPrefix = null;
    if (supplierId) {
        const { rows } = await pool.query(
            `SELECT prefix FROM suppliers WHERE id = $1 AND active = true LIMIT 1`,
            [supplierId]
        );
        if (rows.length > 0) supplierPrefix = rows[0].prefix;
    }

    // Referencias sin prefijo de proveedor (cualquiera), para el nivel 4
    const { rows: prefixRows } = await pool.query(
        `SELECT DISTINCT prefix FROM suppliers WHERE prefix IS NOT NULL AND prefix <> ''`
    );
    // Prefijos más largos primero: "MG" no debe comerse parte de un "MGX"
    const allPrefixes = prefixRows.map(r => r.prefix).sort((a, b) => b.length - a.length);
    const byRefSinPrefijo = buildRefWithoutPrefixIndex(odooCache, allPrefixes);

    const enriched = [];

    for (const item of items) {
        let matched    = null;
        let confidence = 0;
        let matchLevel = null;
        let errorMsg   = null;

        try {
            // Sentido único (nota 107): Ingresos alimenta la tabla maestra, pero no la usa para proponer.
            // Acá no se lee product_mappings, match_decisiones ni producto_reemplazos.

            // ---- Nivel 2: invoice_code_mappings (vinculación manual persistente) ----
            // Códigos vacíos, guiones o "S/COD" no se buscan — evita falsos positivos globales
            const codigoValido = item.codigo && item.codigo.trim() !== '' &&
                !['', '-', '--', 'n/a', 'na', 's/cod', 'sin codigo'].includes(item.codigo.trim().toLowerCase());
            if (!matched && supplierId && codigoValido) {
                const { rows: icmRows } = await pool.query(
                    `SELECT odoo_product_id, odoo_product_name
                     FROM invoice_code_mappings
                     WHERE supplier_id = $1
                       AND REPLACE(REPLACE(UPPER(raw_code), '-', ''), ' ', '')
                           = REPLACE(REPLACE(UPPER($2), '-', ''), ' ', '')
                     LIMIT 1`,
                    [supplierId, item.codigo]
                );

                if (icmRows.length > 0) {
                    const icm = icmRows[0];
                    // Solo usar el mapping si el producto sigue activo en Odoo.
                    // Si fue archivado, el mapping quedó obsoleto — ignorarlo y
                    // continuar a los niveles siguientes para encontrar el producto correcto.
                    matched = odooCache.find(p => p.odoo_id === icm.odoo_product_id) || null;
                    if (matched) {
                        confidence = 0.98;
                        matchLevel = 'invoice_mapping';
                    }
                }
            }

            // ---- Nivel 3: internal_ref — código normalizado con y sin prefijo ----
            // Cubre todos los casos:
            //   codigo="P113238"   + prefix="IT" → busca "ITP113238" (= "IT-P113238" normalizado) ✓
            //   codigo="ITP113238" + prefix="IT" → código ya tiene prefijo, no lo duplica ✓
            //   codigo="IT-P113238"+ prefix="IT" → normaliza a "ITP113238" ✓
            if (!matched && codigoValido) {
                const normCodigo  = item.codigo.replace(/[-\s]/g, '').toUpperCase();
                const normPrefix  = supplierPrefix ? supplierPrefix.replace(/[-\s]/g, '').toUpperCase() : '';

                // Si el código ya incluye el prefijo al inicio, no lo duplicamos
                const codigoConPref = normPrefix && !normCodigo.startsWith(normPrefix)
                    ? normPrefix + normCodigo
                    : normCodigo;

                matched =
                    byRefNorm.get(codigoConPref) ||   // prefijo + codigo normalizado
                    byRefNorm.get(normCodigo)    ||   // codigo solo normalizado
                    byRef.get(item.codigo.toUpperCase()) || // exacto original (sin normalizar)
                    null;

                if (matched) { confidence = 0.95; matchLevel = 'ref_prefix'; }
            }

            // ---- Nivel 4: internal_ref con el prefijo de OTRO proveedor ----
            //   codigo="BR8003021" + proveedor CY → encuentra "MG-BR8003021"
            // Pasa cuando el producto se dio de alta con otro proveedor o con el prefijo equivocado.
            // Va después del prefijo propio: primero se une por el proveedor del ingreso.
            if (!matched && codigoValido) {
                matched = matchByRefWithoutPrefix(byRefSinPrefijo, item.codigo);
                if (matched) { confidence = 0.9; matchLevel = 'ref_other_prefix'; }
            }

            // ---- Nivel 5: barcode ----
            if (!matched && item.codigo) {
                matched = byBcode.get(item.codigo) || null;
                if (matched) { confidence = 0.9; matchLevel = 'barcode'; }
            }

            // ---- Nivel 6: description_purchase (descripción de compra en Odoo) ----
            if (!matched && item.descripcion) {
                matched = matchByDescPurchase(
                    byDescPurchase, item.descripcion, codigoValido ? item.codigo : null, allPrefixes
                );
                if (matched) { confidence = 0.85; matchLevel = 'desc_purchase'; }
            }

            // ---- Nivel 7: nombre. Idéntico se confirma; un parecido queda para una persona. ----
            if (!matched && item.descripcion) {
                let bestSim = 0;
                let bestProduct = null;
                let bestLevel = null;

                for (const p of odooCache) {
                    const decision = nameMatchDecision(item.descripcion, p.name);
                    if (!decision) continue;
                    const prefer = decision.confidence > bestSim
                        || (decision.confidence === bestSim && decision.estado === 'matched');
                    if (prefer) {
                        bestSim = decision.confidence;
                        bestProduct = p;
                        bestLevel = decision.matchLevel;
                    }
                }

                if (bestProduct) {
                    matched = bestProduct;
                    confidence = bestSim;
                    matchLevel = bestLevel;
                }
            }

            // Niveles 8 y 9 (fallback Preventas) eliminados intencionalmente.
            // El ingreso de mercadería solo clasifica ítems respecto a Odoo Neggo.
            // La relación con Preventas es exclusiva de la pestaña Preventa
            // (calculada en tiempo real por preventa-odoo-match, no aquí).
            // Un ítem que no existe en Neggo es "nuevo" — no se matchea a Preventas.

            if (!matched) {
                errorMsg = item.codigo
                    ? `Sin coincidencia para código: ${item.codigo}`
                    : `Sin coincidencia por nombre: ${item.descripcion}`;
            }
        } catch (err) {
            errorMsg = `Error matching: ${err.message}`;
            console.error('❌ Error en matching:', err);
        }

        enriched.push({
            ...item,
            odoo_product_id:   matched ? matched.odoo_id : null,
            odoo_product_name: matched ? matched.name    : null,
            odoo_active:       matched ? (matched.active !== false) : null,
            odoo_company:      'neggo',
            confidence_match:  confidence,
            match_level:       matchLevel,
            error_match:       errorMsg,
            estado_item:       matched && !MATCH_LEVELS_TO_CONFIRM.includes(matchLevel) ? 'matched' : 'pending',
            precio_odoo_anterior: matched ? parseFloat(matched.standard_price || 0) : null,
            precio_odoo_lista:    matched ? parseFloat(matched.list_price    || 0) : null,
            supplier_product_id:   null,
            supplier_match_level:  'none',
            supplier_confidence:   0,
        });
    }

    // =============================================
    // TRIANGULACIÓN CON PRODUCTOS SCRAPEADOS DEL PROVEEDOR
    // Niveles: código exacto → código con prefijo → fuzzy nombre ≥80% + precio ±20%
    // =============================================
    if (supplierId) {
        const { rows: spRows } = await pool.query(
            `SELECT id, sku, name, raw_price, image_url
             FROM supplier_products
             WHERE supplier_id = $1 AND available = true`,
            [supplierId]
        );

        // Prefijos que los scrapers agregan al SKU (no son el código del proveedor)
        const SCRAPER_PREFIXES = ['imptk-', 'elrey-', 'mali-', 'cast-'];

        // Extrae el código base de un SKU quitando el prefijo del scraper y los guiones internos
        // "imptk-INF-1093" → "INF1093" | "elrey-360" → "360" | "CT0160018" → "CT0160018"
        function extractBaseCode(sku) {
            const lower = sku.toLowerCase();
            for (const prefix of SCRAPER_PREFIXES) {
                if (lower.startsWith(prefix)) {
                    return sku.slice(prefix.length).replace(/-/g, '').toUpperCase();
                }
            }
            return sku.replace(/-/g, '').toUpperCase();
        }

        // Índice por SKU — tres variantes:
        // 1. SKU tal cual (uppercase)
        // 2. Sin el prefijo del proveedor (IMP-, CAST-, etc.)
        // 3. Código base normalizado (sin prefijo scraper, sin guiones) ← NUEVO
        const bySpSku      = new Map();
        const bySpBaseCode = new Map();

        for (const sp of spRows) {
            if (!sp.sku) continue;
            const skuUpper  = sp.sku.toUpperCase();
            const baseCode  = extractBaseCode(sp.sku);

            bySpSku.set(skuUpper, sp);
            if (baseCode.length >= 2) bySpBaseCode.set(baseCode, sp);

            if (supplierPrefix) {
                const p = supplierPrefix.toUpperCase();
                if (skuUpper.startsWith(p + '-')) bySpSku.set(skuUpper.slice(p.length + 1), sp);
                if (skuUpper.startsWith(p))       bySpSku.set(skuUpper.slice(p.length), sp);
                // Formato actual de los scrapers: PRE + prefijo + código ("PRECT0440209" → "0440209")
                if (skuUpper.startsWith(`PRE${p}`)) {
                    const code = skuUpper.slice(p.length + 3);
                    bySpSku.set(code, sp);
                    if (code.replace(/-/g, '').length >= 2) bySpBaseCode.set(code.replace(/-/g, ''), sp);
                }
            }
        }

        for (let i = 0; i < enriched.length; i++) {
            const item = enriched[i];
            let spMatch = null;
            let spLevel = 'none';
            let spConf  = 0;

            // Nivel A: código exacto en todas sus variantes
            // Primero exacto, luego con prefijo proveedor, luego normalizado (sin guiones)
            if (item.codigo) {
                const code     = item.codigo.toUpperCase();
                const normCode = code.replace(/-/g, ''); // también normalizar el código de la boleta
                const p        = supplierPrefix?.toUpperCase() || '';

                spMatch = bySpSku.get(code)
                    || bySpSku.get(`${p}-${code}`)
                    || bySpSku.get(`${p}${code}`)
                    || bySpBaseCode.get(normCode)   // ← código factura vs código base del SKU
                    || bySpBaseCode.get(code)        // ← sin normalizar por si el código tiene letras+nums
                    || null;

                if (spMatch) { spLevel = 'exact_code'; spConf = 1.0; }
            }

            // Nivel B: fuzzy nombre ≥80% + precio dentro de ±20%
            if (!spMatch && item.descripcion && spRows.length > 0) {
                const normDesc = normalize(item.descripcion);
                let bestSim = 0;
                let bestSp  = null;
                for (const sp of spRows) {
                    const sim = similarity(normDesc, normalize(sp.name));
                    if (sim > bestSim) { bestSim = sim; bestSp = sp; }
                }
                if (bestSim >= 0.80 && bestSp) {
                    const priceOk = !bestSp.raw_price || !item.precio_unitario
                        || Math.abs(bestSp.raw_price - item.precio_unitario) / item.precio_unitario <= 0.20;
                    if (priceOk || bestSim >= 0.92) {
                        spMatch = bestSp;
                        spLevel = 'fuzzy';
                        spConf  = Math.round(bestSim * 1000) / 1000;
                    }
                }
            }

            enriched[i] = {
                ...item,
                supplier_product_id:  spMatch ? spMatch.id  : null,
                supplier_match_level: spLevel,
                supplier_confidence:  spConf,
            };
        }
    }

    return enriched;
}

// =============================================
// 3. VALIDACIÓN: Verificar consistencia con Odoo
// =============================================

/**
 * Valida items matched: verifica existencia en cache, marca alerta de precio.
 */
async function validateItems(items) {
    const validated = [];

    for (const item of items) {
        const v = { ...item };

        if (!item.odoo_product_id || item.estado_item !== 'matched') {
            validated.push(v);
            continue;
        }

        // Precio viene de matchItems ya. Verificar alerta de diferencia.
        if (v.precio_odoo_anterior !== null && v.precio_odoo_anterior > 0) {
            const pctDiff = Math.abs(v.precio_unitario - v.precio_odoo_anterior) / v.precio_odoo_anterior;
            v.alerta_precio_diferente = pctDiff > 0.01;
        }

        // Calcular precio_odoo_nuevo (costo que viene de la factura)
        v.precio_odoo_nuevo = v.precio_unitario;

        validated.push(v);
    }

    return validated;
}

// =============================================
// 4. CREAR INGRESO PREVIEW (sin confirmar)
// =============================================

async function createIngresoPreview(items, supplierId, comprobanteTipo, comprobantNumero, userId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const totalMonto = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);
        const ingresoResult = await client.query(
            `INSERT INTO ingreso_mercaderia
             (comprobante_numero, comprobante_tipo, supplier_id, estado, items_count, total_monto, created_by_user_id)
             VALUES ($1, $2, $3, 'pending', $4, $5, $6)
             RETURNING id`,
            [comprobantNumero || null, comprobanteTipo, supplierId || null, items.length, totalMonto, userId]
        );

        const ingresoId = ingresoResult.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO ingreso_items
                 (ingreso_id, codigo, descripcion, cantidad, precio_unitario, subtotal,
                  odoo_product_id, odoo_product_name, confidence_match, error_match,
                  estado_item, odoo_active, odoo_company,
                  cantidad_odoo_anterior, precio_odoo_anterior, precio_odoo_nuevo, precio_odoo_lista,
                  alerta_precio_diferente,
                  supplier_product_id, supplier_match_level, supplier_confidence,
                  match_level)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                [
                    ingresoId,
                    item.codigo            || null,
                    item.descripcion,
                    item.cantidad,
                    item.precio_unitario,
                    item.subtotal,
                    item.odoo_product_id   || null,
                    item.odoo_product_name || null,
                    item.confidence_match  || 0,
                    item.error_match       || null,
                    item.estado_item       || 'pending',
                    item.odoo_active !== undefined ? item.odoo_active : null,
                    item.odoo_company      || 'neggo',
                    item.cantidad_odoo_anterior  || null,
                    item.precio_odoo_anterior    || null,
                    item.precio_odoo_nuevo       || null,
                    item.precio_odoo_lista       || null,
                    item.alerta_precio_diferente || false,
                    item.supplier_product_id     || null,
                    item.supplier_match_level    || 'none',
                    item.supplier_confidence     || 0,
                    item.match_level             || null,
                ]
            );
        }

        await client.query('COMMIT');

        return {
            success: true,
            ingresoId,
            preview: {
                ingresoId,
                comprobante_numero: comprobantNumero,
                comprobante_tipo:   comprobanteTipo,
                total_monto:        totalMonto,
                items_count:        items.length,
                summary: {
                    matched:  items.filter(i => i.estado_item === 'matched').length,
                    pending:  items.filter(i => i.estado_item === 'pending').length,
                    rejected: items.filter(i => i.estado_item === 'rejected').length,
                    activos:  items.filter(i => i.estado_item === 'matched' && i.odoo_active !== false).length,
                    inactivos: items.filter(i => i.estado_item === 'matched' && i.odoo_active === false).length,
                    nuevos:    items.filter(i => i.estado_item === 'pending').length
                }
            }
        };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error creating ingreso preview:', err);
        throw err;
    } finally {
        client.release();
    }
}

// =============================================
// 5. CONFIRMAR INGRESO (aplicar cambios + purchase.order)
// =============================================

/**
 * Confirma el ingreso:
 * - Actualiza costos/precios en Odoo según flags apply_cost / apply_price por item
 * - Reactiva productos inactivos usando product.template (no product.product)
 * - Crea purchase.order en Odoo con todos los items matched
 *
 * @param {number} ingresoId
 * @param {number} userId
 * @param {number|null} odooPartnerId — partner Odoo del proveedor (para purchase.order)
 * @returns {Promise<object>}
 */

/**
 * Dado el codigo de la boleta y el prefijo del proveedor, devuelve el odoo_id
 * del producto equivalente en la empresa Preventas.
 * Usa la misma clave que preventa-odoo-match: PRE + prefijo + baseCode(codigo).
 * Esto aprovecha la relación existente en lugar de ir por el internal_ref de Neggo.
 */
async function findPreventasProductId(codigo, supplierPrefix, client) {
    const db = client || pool;
    if (!codigo) return null;

    const norm = s => (s || '').replace(/[-\s]/g, '').toUpperCase();
    const base = norm(codigo);
    const pref = norm(supplierPrefix);

    const candidates = [
        `PRE${pref}${base}`,
        `PRE${base}`,
    ].filter((v, i, a) => v.length > 3 && a.indexOf(v) === i);

    // Busca en: internal_ref, ext_id_clean (ir.model.data), y código {braces} del nombre + prefijo.
    // El mismo matching multi-fuente que usa preventa-odoo-match.
    const { rows } = await db.query(
        `SELECT odoo_id FROM odoo_products_cache
         WHERE company = 'preventas' AND active = true
           AND (
               REPLACE(REPLACE(UPPER(COALESCE(internal_ref, '')), '-', ''), ' ', '') = ANY($1)
               OR ext_id_clean = ANY($1)
               OR 'PRE' || $2 || UPPER(REGEXP_REPLACE(
                   COALESCE(SUBSTRING(name FROM '[{]([^}]+)[}]'), ''),
                   '[^A-Z0-9]', '', 'g'
               )) = ANY($1)
           )
         LIMIT 1`,
        [candidates, pref]
    );
    return rows[0]?.odoo_id || null;
}

async function confirmIngreso(ingresoId, userId, odooPartnerId = null) {
    const client = await pool.connect();
    let createdNeggoId = null;
    let createdPrevId = null;

    try {
        await client.query('BEGIN');

        const ingresoResult = await client.query(
            `SELECT im.*, s.name as supplier_name, s.default_discount, s.prefix as supplier_prefix,
                    COALESCE(s.markup_neggo, 0)     AS markup_neggo,
                    COALESCE(s.markup_preventas, 0) AS markup_preventas
             FROM ingreso_mercaderia im
             LEFT JOIN suppliers s ON s.id = im.supplier_id
             WHERE im.id = $1
             -- Bloquea el ingreso: un doble clic en Confirmar espera al primero y
             -- después ve 'confirmado', en vez de crear la OC dos veces en Odoo
             FOR UPDATE OF im`,
            [ingresoId]
        );

        if (ingresoResult.rows.length === 0) {
            throw new Error(`Ingreso ${ingresoId} no encontrado`);
        }

        const ingreso = ingresoResult.rows[0];
        if (ingreso.estado === 'confirmado') {
            await client.query('COMMIT');
            return {
                success: true,
                already_confirmed: true,
                updated_products_count: 0,
                price_changes: [],
                odoo_purchase_order_id: ingreso.odoo_purchase_order_id,
                odoo_purchase_order_id_preventas: ingreso.odoo_purchase_order_id_preventas,
            };
        }
        const supplierMarkup   = parseFloat(ingreso.markup_neggo || 0);
        const supplierDiscount = parseFloat(ingreso.default_discount || 0);
        const costoEnvio       = parseFloat(ingreso.costo_envio      || 0);
        const supplierPrefix   = ingreso.supplier_prefix || '';

        const itemsResult = await client.query(
            `SELECT * FROM ingreso_items WHERE ingreso_id = $1`,
            [ingresoId]
        );

        const items = itemsResult.rows;

        // Divisor para prorratear el envío: total de la factura completa,
        // no solo los ítems matcheados — cada ítem paga su parte proporcional
        // sin importar si va a Neggo, Preventas, etc.
        const totalFactura = parseFloat(ingreso.total_monto || 0);

        let updatedProductsCount = 0;
        const priceChanges       = [];
        const purchaseLinesNeggo      = []; // ítems con unidades para Neggo
        const purchaseLinesPreventas  = []; // ítems con unidades confirmadas para preventa

        for (const item of items) {
            const isPendingConPreventa = item.estado_item === 'pending'
                && (item.preventa_qty_confirmed > 0 || item.preventas_product_id);

            // Procesar: ítems matcheados a Neggo, O ítems pending con plan de preventa
            if (!isPendingConPreventa && (item.estado_item !== 'matched' || !item.odoo_product_id)) continue;

            // Ítems pending que solo van a Preventas (no existen en Neggo)
            if (isPendingConPreventa && item.estado_item === 'pending') {
                const shares = capPreventaShares(item);
                if (shares.length > 0) {
                    const packSizeP     = Math.max(1, parseInt(item.pack_size || 1, 10));
                    const rawCost       = parseFloat(item.precio_unitario || 0) / packSizeP;
                    const discount      = item.discount_override !== null
                        ? parseFloat(item.discount_override) : supplierDiscount;
                    const newCostBase   = discount > 0
                        ? Math.round(rawCost * (1 - discount / 100) * 100) / 100
                        : rawCost;
                    const participacionP = (totalFactura > 0 && parseFloat(item.subtotal) > 0)
                        ? parseFloat(item.subtotal) / totalFactura
                        : 0;
                    const envioUnitarioP = (costoEnvio > 0 && parseInt(item.cantidad) > 0)
                        ? Math.round(costoEnvio * participacionP / (parseInt(item.cantidad) * packSizeP) * 100) / 100
                        : 0;
                    const newCost       = Math.round((newCostBase + envioUnitarioP) * 100) / 100;
                    for (const link of shares) {
                        const productId = link.preventas_product_id
                            || await findPreventasProductId(item.codigo, supplierPrefix, client);
                        if (productId) {
                            purchaseLinesPreventas.push({
                                product_id: productId,
                                name:       link.preventas_product_name || item.preventas_product_name || item.odoo_product_name || item.descripcion,
                                quantity:   link.qty * packSizeP,
                                unit_price: newCost,
                            });
                            updatedProductsCount++;
                        } else {
                            console.log(`⚠️ Sin producto Preventas para "${item.descripcion}" (pending) — se omite de la OC`);
                        }
                    }
                }
                continue;
            }

            const itemCompany = item.odoo_company || 'neggo';
            const shares   = capPreventaShares(item);
            const prevQty  = shares.reduce((sum, link) => sum + link.qty, 0);
            const totalQty = parseInt(item.cantidad, 10);
            const neggoQty = Math.max(0, totalQty - prevQty);

            // Calcular costos (sin try/catch — falla rápido si los datos son inválidos)
            const packSize = Math.max(1, parseInt(item.pack_size || 1, 10));
            const rawCost = parseFloat(item.precio_unitario) / packSize;

            const discount = item.discount_override !== null
                ? parseFloat(item.discount_override)
                : supplierDiscount;

            const newCostBase = discount > 0
                ? Math.round(rawCost * (1 - discount / 100) * 100) / 100
                : rawCost;

            const participacion = (totalFactura > 0 && item.subtotal > 0)
                ? parseFloat(item.subtotal) / totalFactura
                : 0;
            const envioUnitario = (costoEnvio > 0 && parseInt(item.cantidad) > 0)
                ? Math.round(costoEnvio * participacion / (parseInt(item.cantidad) * packSize) * 100) / 100
                : 0;
            const newCost = Math.round((newCostBase + envioUnitario) * 100) / 100;

            const markup = item.markup_override !== null
                ? parseFloat(item.markup_override)
                : supplierMarkup;

            const newListPrice = markup > 0
                ? Math.ceil(newCost * (1 + markup / 100))
                : null;

            // PASO 1 — Agregar a OC SIEMPRE, independiente de si la actualización de precios falla.
            // Los productos inactivos también van a la OC (Odoo acepta PO en borrador con inactivos).
            if (itemCompany === 'preventas') {
                purchaseLinesPreventas.push({
                    product_id: item.odoo_product_id,
                    name:       item.odoo_product_name || item.descripcion,
                    quantity:   totalQty * packSize,
                    unit_price: newCost
                });
            } else {
                if (neggoQty > 0) {
                    purchaseLinesNeggo.push({
                        product_id: item.odoo_product_id,
                        name:       item.odoo_product_name || item.descripcion,
                        quantity:   neggoQty * packSize,
                        unit_price: newCost
                    });
                }
                for (const link of shares) {
                    const productId = link.preventas_product_id
                        || await findPreventasProductId(item.codigo, supplierPrefix, client);
                    if (productId) {
                        purchaseLinesPreventas.push({
                            product_id: productId,
                            name:       link.preventas_product_name || item.preventas_product_name || item.odoo_product_name || item.descripcion,
                            quantity:   link.qty * packSize,
                            unit_price: newCost,
                        });
                    } else {
                        console.log(`⚠️ Sin producto Preventas para "${item.descripcion}" (codigo: ${item.codigo}) — se omite de la OC Preventas`);
                    }
                }
            }

            // PASO 2 — Actualizar precios en Odoo (puede fallar para inactivos — no bloquea la OC).
            try {
                let appliedCost = null;
                let appliedPrice = null;
                const company = itemCompany === 'preventas' ? 'preventas' : 'neggo';

                if (item.apply_cost && newCost > 0) {
                    const priceToApply = listPriceForOdoo(item.apply_price, newListPrice, item.precio_odoo_lista);
                    await odooService.updateProductPrices(item.odoo_product_id, newCost, priceToApply, company);
                    appliedCost  = newCost;
                    appliedPrice = priceToApply;
                    priceChanges.push({
                        product_id:   item.odoo_product_id,
                        product_name: item.odoo_product_name,
                        old_cost:     item.precio_odoo_anterior,
                        new_cost:     newCost,
                        new_price:    newListPrice,
                        company
                    });
                } else if (item.apply_price && newListPrice !== null) {
                    const costoParaOdoo = parseFloat(item.precio_odoo_anterior) || newCost;
                    if (costoParaOdoo > 0) {
                        await odooService.updateProductPrices(item.odoo_product_id, costoParaOdoo, newListPrice, company);
                        appliedCost  = costoParaOdoo;
                        appliedPrice = newListPrice;
                    }
                    priceChanges.push({
                        product_id:   item.odoo_product_id,
                        product_name: item.odoo_product_name,
                        old_price:    item.precio_odoo_lista,
                        new_price:    newListPrice,
                        company
                    });
                }

                // Actualizar cache local y el item para que el reload muestre valores correctos.
                // Si no se aplicó precio de lista, no se pisa el que ya estaba.
                if (appliedCost !== null) {
                    if (appliedPrice != null) {
                        await client.query(
                            `UPDATE odoo_products_cache SET standard_price = $1, list_price = $2 WHERE odoo_id = $3 AND company = $4`,
                            [appliedCost, appliedPrice, item.odoo_product_id, company]
                        );
                        await client.query(
                            `UPDATE ingreso_items SET precio_odoo_anterior = $1, precio_odoo_lista = $2 WHERE id = $3`,
                            [appliedCost, appliedPrice, item.id]
                        );
                    } else {
                        await client.query(
                            `UPDATE odoo_products_cache SET standard_price = $1 WHERE odoo_id = $2 AND company = $3`,
                            [appliedCost, item.odoo_product_id, company]
                        );
                        await client.query(
                            `UPDATE ingreso_items SET precio_odoo_anterior = $1 WHERE id = $2`,
                            [appliedCost, item.id]
                        );
                    }
                }
            } catch (priceErr) {
                console.error(`⚠️ No se pudo actualizar precio del item ${item.id} (${item.odoo_product_name}): ${priceErr.message}`);
            }

            updatedProductsCount++;
        }

        const { rows: ocCols } = await client.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'ingreso_mercaderia'
               AND column_name IN ('odoo_purchase_order_id', 'odoo_purchase_order_id_preventas')`
        );
        if (ocCols.length < 2) {
            throw new Error('Faltan las columnas de la orden de compra. Reiniciá el backend para actualizar la base antes de confirmar.');
        }

        // Si un intento anterior ya creó la OC y falló el guardado, se reutiliza.
        let odooPurchaseOrderId = ingreso.odoo_purchase_order_id || null;
        let odooPurchaseOrderIdPreventas = ingreso.odoo_purchase_order_id_preventas || null;

        if (odooPartnerId && purchaseLinesNeggo.length > 0 && !odooPurchaseOrderId) {
            try {
                createdNeggoId = await odooService.createPurchaseOrder(
                    odooPartnerId, purchaseLinesNeggo, 'neggo'
                );
                odooPurchaseOrderId = createdNeggoId;
                console.log(`✅ OC Neggo creada: ${odooPurchaseOrderId} (${purchaseLinesNeggo.length} líneas)`);
            } catch (err) {
                console.error(`⚠️ No se pudo crear OC Neggo: ${err.message}`);
            }
        }

        if (odooPartnerId && purchaseLinesPreventas.length > 0 && !odooPurchaseOrderIdPreventas) {
            try {
                createdPrevId = await odooService.createPurchaseOrder(
                    odooPartnerId, purchaseLinesPreventas, 'preventas'
                );
                odooPurchaseOrderIdPreventas = createdPrevId;
                console.log(`✅ OC Preventas creada: ${odooPurchaseOrderIdPreventas} (${purchaseLinesPreventas.length} líneas)`);
            } catch (err) {
                console.error(`⚠️ No se pudo crear OC Preventas: ${err.message}`);
            }
        }

        const missingOrders = missingPurchaseOrders({
            partnerId: odooPartnerId,
            neggoLineCount: purchaseLinesNeggo.length,
            prevLineCount: purchaseLinesPreventas.length,
            neggoId: odooPurchaseOrderId,
            prevId: odooPurchaseOrderIdPreventas,
        });
        if (missingOrders.length > 0) {
            throw new Error(
                `No se pudo crear la orden de compra de ${missingOrders.join(' y ')}. El ingreso sigue pendiente.`
            );
        }

        // Actualizar estado del ingreso
        await client.query(
            `UPDATE ingreso_mercaderia
             SET estado = 'confirmado',
                 confirmed_by_user_id = $1,
                 confirmed_at = NOW(),
                 odoo_purchase_order_id = $2,
                 odoo_purchase_order_id_preventas = $3,
                 odoo_partner_id = $4
             WHERE id = $5`,
            [userId, odooPurchaseOrderId, odooPurchaseOrderIdPreventas, odooPartnerId, ingresoId]
        );

        // Activity log
        await client.query(
            `INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
             VALUES ($1, 'ingreso_mercaderia', 'CONFIRM', 'ingreso_mercaderia', $2, $3)`,
            [userId, ingresoId, JSON.stringify({
                updated_products:              updatedProductsCount,
                price_changes:                 priceChanges.length,
                odoo_purchase_order_id:        odooPurchaseOrderId,
                odoo_purchase_order_id_preventas: odooPurchaseOrderIdPreventas
            })]
        );

        await client.query('COMMIT');

        return {
            success: true,
            updated_products_count:           updatedProductsCount,
            price_changes:                    priceChanges,
            odoo_purchase_order_id:           odooPurchaseOrderId,
            odoo_purchase_order_id_preventas: odooPurchaseOrderIdPreventas
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (createdNeggoId || createdPrevId) {
            try {
                await persistPurchaseOrderIds(ingresoId, createdNeggoId, createdPrevId);
                console.error(`⚠️ OC guardada para no duplicarla en Odoo (Neggo ${createdNeggoId || '—'}, Preventas ${createdPrevId || '—'}). El confirm se puede reintentar.`);
            } catch (saveErr) {
                console.error('❌ No se pudo guardar el id de la OC ya creada:', saveErr.message);
            }
        }
        console.error('❌ Error confirming ingreso:', err);
        throw err;
    } finally {
        client.release();
    }
}

// =============================================
// Revisión de vínculos hechos a mano (nota 107)
// Al confirmar, los renglones con producto de Odoo u oferta elegidos a mano se tildan una sola vez
// antes de entrar a la tabla maestra. Lo revisado se guarda en ingreso_items (sentido único: acá
// no se lee la tabla maestra) y no vuelve a marcarse: mismo proveedor + código + producto de Odoo.
// =============================================

// Renglones manuales del ingreso con oferta web + producto de Neggo, y si el par ya se revisó antes
async function renglonesManualesConOferta(ingresoId, db = pool) {
    const { rows } = await db.query(
        `SELECT ii.id AS item_id, ii.codigo, ii.descripcion, ii.precio_unitario,
                ii.odoo_product_id, ii.odoo_product_name, opc.internal_ref, opc.has_image,
                ii.match_level, ii.supplier_match_level,
                sp.id AS supplier_product_id, sp.sku, sp.name AS oferta_nombre, sp.raw_price AS oferta_precio,
                EXISTS (
                    SELECT 1 FROM ingreso_items prev
                    JOIN ingreso_mercaderia pim ON pim.id = prev.ingreso_id AND pim.estado = 'confirmado'
                    WHERE pim.supplier_id = im.supplier_id AND prev.id <> ii.id
                      AND prev.odoo_product_id = ii.odoo_product_id
                      AND prev.vinculo_revisado_at IS NOT NULL
                      AND regexp_replace(UPPER(COALESCE(prev.codigo, '')), '[^A-Z0-9]', '', 'g')
                          = regexp_replace(UPPER(COALESCE(ii.codigo, '')), '[^A-Z0-9]', '', 'g')
                ) AS ya_revisado
         FROM ingreso_items ii
         JOIN ingreso_mercaderia im ON im.id = ii.ingreso_id
         JOIN supplier_products sp ON sp.id = ii.supplier_product_id AND sp.source = 'web'
         LEFT JOIN odoo_products_cache opc ON opc.odoo_id = ii.odoo_product_id AND opc.company = 'neggo'
         WHERE ii.ingreso_id = $1 AND ii.estado_item = 'matched' AND ii.odoo_product_id IS NOT NULL
           AND COALESCE(ii.odoo_company, 'neggo') = 'neggo'
           AND (ii.match_level = 'manual' OR ii.supplier_match_level = 'manual')
         ORDER BY ii.id`,
        [ingresoId]
    );
    return rows;
}

// Lo que se muestra en el paso "Revisá los vínculos hechos a mano"
async function vinculosARevisar(ingresoId) {
    return (await renglonesManualesConOferta(ingresoId)).filter(r => !r.ya_revisado);
}

/**
 * Guarda la revisión antes de confirmar: los tildados y los que ya se habían revisado en otro
 * ingreso quedan revisados; los destildados no (se vuelven a marcar la próxima vez).
 * @param {number} ingresoId
 * @param {number[]|null} tildados — ids de renglones; sin revisión no se tilda nada nuevo
 * @param {number} userId
 */
async function marcarVinculosRevisados(ingresoId, tildados, userId) {
    const renglones = await renglonesManualesConOferta(ingresoId);
    const elegidos = new Set((tildados || []).map(Number));
    const revisados = renglones.filter(r => r.ya_revisado || elegidos.has(r.item_id)).map(r => r.item_id);

    await pool.query(
        `UPDATE ingreso_items SET vinculo_revisado_at = NULL, vinculo_revisado_por = NULL WHERE ingreso_id = $1`,
        [ingresoId]
    );
    if (revisados.length > 0) {
        await pool.query(
            `UPDATE ingreso_items SET vinculo_revisado_at = NOW(), vinculo_revisado_por = $2
             WHERE ingreso_id = $1 AND id = ANY($3::int[])`,
            [ingresoId, userId, revisados]
        );
    }
    return { revisados: revisados.length, sin_revisar: renglones.length - revisados.length };
}

// =============================================
// EXPORTS
// =============================================

module.exports = {
    vinculosARevisar,
    marcarVinculosRevisados,
    parseCSV,
    parsePrecio,
    parseCantidad,
    decodeCsv,
    supplierSkuKeys,
    matchItems,
    validateItems,
    createIngresoPreview,
    confirmIngreso,
    findPreventasProductId,
    nameMatchDecision,
    MATCH_LEVELS_TO_CONFIRM,
    refWithoutSupplierPrefix,
    buildRefWithoutPrefixIndex,
    matchByRefWithoutPrefix,
    buildDescPurchaseIndex,
    matchByDescPurchase,
    allocatePreventaQty,
    capPreventaShares,
    distributePreventaQty,
    persistPurchaseOrderIds,
    listPriceForOdoo,
    missingPurchaseOrders,
};
