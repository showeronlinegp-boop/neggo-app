// Servicio de matching y recomputo para Sync Preventas
// Estrategias (en orden de prioridad):
//   exact_sku    (100) — sp.sku = opc.external_id (comparación exacta)
//   exact_sku    (95)  — UPPER(sp.sku) = opc.ext_id_clean (normalizado, tolera paréntesis/guiones en Odoo)
//   barcode      (99)  — EAN/UPC coincide
//   internal_ref (90)  — opc.internal_ref = SUBSTRING(sku, 4)  [strip PRE]
//   internal_ref (88)  — opc.internal_ref = código sin PRE+prefix
//   name_key     (85)  — ext_id_clean = PRE+prefix+name_key
//   fuzzy_name   (var) — similitud trigrama ≥ 0.75 (requiere pg_trgm)
//   bracket_code (87)  — código entre {} o () del nombre scraper vs nombre Odoo

const LOCK_KEY = 987654321; // pg advisory lock
const PRICE_TOL = 0.0001;

// ─── SQL fragments ─────────────────────────────────────────────────────────────

const ESTADO_CASE = `
    CASE
        WHEN opc.active = false AND sp.available = true  THEN 'activar'
        WHEN opc.active = true  AND sp.available = false THEN 'inactivar'
        WHEN opc.active = true AND sp.available = true
             AND p.costo IS NOT NULL AND opc.standard_price IS NOT NULL
             AND opc.standard_price > 0
             AND ABS(p.costo - opc.standard_price) / opc.standard_price > ${PRICE_TOL}
             AND p.costo > opc.standard_price  THEN 'precio_sube'
        WHEN opc.active = true AND sp.available = true
             AND p.costo IS NOT NULL AND opc.standard_price IS NOT NULL
             AND opc.standard_price > 0
             AND ABS(p.costo - opc.standard_price) / opc.standard_price > ${PRICE_TOL}
             AND p.costo < opc.standard_price  THEN 'precio_baja'
        ELSE 'sin_cambios'
    END`;

const PRECIO_LATERAL = `
    CROSS JOIN LATERAL (SELECT
        CASE WHEN sp.raw_price IS NOT NULL THEN
            ROUND(sp.raw_price * (1 - COALESCE(scr.discount_override, s.default_discount, 0) / 100.0 + 0.015), 2)
        END AS costo,
        CASE WHEN sp.raw_price IS NOT NULL THEN
            ROUND(sp.raw_price * 1.015 * (1 + COALESCE(scr.markup_preventas_override, s.markup_preventas, 0) / 100.0), 2)
        END AS precio_preventas
    ) p`;

// ─── Step 1: estrategias determinísticas ──────────────────────────────────────

const MATCH_SQL = `
WITH candidates AS (

    -- 1. SKU exacto (100)
    SELECT sp.id AS sp_id, opc.odoo_id, 'exact_sku'::VARCHAR AS match_type, 100::NUMERIC AS score
    FROM supplier_products sp
    JOIN odoo_products_cache opc
        ON opc.external_id = sp.sku AND opc.company = 'preventas'

    UNION ALL

    -- 2. SKU vs ext_id_clean (95)
    --    Resuelve casos donde Odoo tiene paréntesis/guiones en external_id
    --    pero el SKU scrapeado ya viene normalizado sin esos caracteres
    SELECT sp.id, opc.odoo_id, 'exact_sku', 95
    FROM supplier_products sp
    JOIN odoo_products_cache opc
        ON  opc.ext_id_clean IS NOT NULL
        AND opc.ext_id_clean = UPPER(sp.sku)
        AND opc.company = 'preventas'

    UNION ALL

    -- 4. Código de barras EAN/UPC (99)
    SELECT sp.id, opc.odoo_id, 'barcode', 99
    FROM supplier_products sp
    JOIN odoo_products_cache opc
        ON  opc.barcode = sp.barcode
        AND opc.company = 'preventas'
        AND opc.barcode IS NOT NULL AND LENGTH(opc.barcode) >= 8
    WHERE sp.barcode IS NOT NULL AND LENGTH(sp.barcode) >= 8

    UNION ALL

    -- 5. Ref. interna = SUBSTRING(sku, 4) — quita "PRE"  (90)
    --    Ejemplo: sku=PRECAST12345, strip PRE → CAST12345, internal_ref=CAST12345
    SELECT sp.id, opc.odoo_id, 'internal_ref', 90
    FROM supplier_products sp
    JOIN odoo_products_cache opc
        ON  opc.internal_ref IS NOT NULL AND TRIM(opc.internal_ref) != ''
        AND UPPER(TRIM(opc.internal_ref)) = UPPER(SUBSTRING(sp.sku FROM 4))
        AND opc.company = 'preventas'

    UNION ALL

    -- 6. Ref. interna = código sin PRE+prefix  (88)
    --    Ejemplo: sku=PRECAST12345, prefix=CAST, strip PRECAST → 12345, internal_ref=12345
    SELECT sp.id, opc.odoo_id, 'internal_ref', 88
    FROM supplier_products sp
    JOIN suppliers sx ON sx.id = sp.supplier_id
    JOIN odoo_products_cache opc
        ON  opc.internal_ref IS NOT NULL AND TRIM(opc.internal_ref) != ''
        AND UPPER(TRIM(opc.internal_ref)) = UPPER(SUBSTRING(sp.sku FROM 4 + LENGTH(sx.prefix)))
        AND opc.company = 'preventas'

    UNION ALL

    -- 7. Name key: ext_id_clean = PRE+prefix+name_key  (85)
    SELECT sp.id, opc.odoo_id, 'name_key', 85
    FROM supplier_products sp
    JOIN suppliers sx ON sx.id = sp.supplier_id
    JOIN odoo_products_cache opc
        ON  sp.name_key IS NOT NULL AND opc.ext_id_clean IS NOT NULL
        AND opc.ext_id_clean = 'PRE' || sx.prefix || sp.name_key
        AND opc.company = 'preventas'

),

-- Mejor match por producto scraper (puntaje más alto gana)
best_by_sp AS (
    SELECT DISTINCT ON (sp_id) sp_id, odoo_id, match_type, score
    FROM candidates
    ORDER BY sp_id, score DESC, match_type
),

-- Mejor match por producto Odoo (evita que dos scrapers reclamen el mismo)
best_match AS (
    SELECT DISTINCT ON (odoo_id) sp_id, odoo_id, match_type, score
    FROM best_by_sp
    ORDER BY odoo_id, score DESC
)

INSERT INTO preventas_sync_state
    (supplier_product_id, odoo_product_id, supplier_id, match_type, match_score, estado, costo, precio_preventas, computed_at)
SELECT
    bm.sp_id,
    bm.odoo_id,
    s.id,
    bm.match_type,
    bm.score,
    ${ESTADO_CASE},
    p.costo,
    p.precio_preventas,
    NOW()
FROM best_match bm
JOIN supplier_products sp    ON sp.id = bm.sp_id
JOIN odoo_products_cache opc ON opc.odoo_id = bm.odoo_id AND opc.company = 'preventas'
LEFT JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules scr
    ON  scr.supplier_id     = sp.supplier_id
    AND scr.source_category = sp.source_category
    AND scr.active = true
${PRECIO_LATERAL}
`;

// ─── Step 2: fuzzy por nombre (requiere pg_trgm) ────────────────────────────

const FUZZY_SQL = `
INSERT INTO preventas_sync_state
    (supplier_product_id, odoo_product_id, supplier_id, match_type, match_score, estado, costo, precio_preventas, computed_at)
-- ON CONFLICT DO NOTHING evita duplicados cuando dos scrapers matchean el mismo producto Odoo
SELECT
    sp.id,
    best.odoo_id,
    s.id,
    'fuzzy_name',
    ROUND((best.sim * 100)::NUMERIC, 2),
    CASE
        WHEN opc.active = false AND sp.available = true  THEN 'activar'
        WHEN opc.active = true  AND sp.available = false THEN 'inactivar'
        WHEN opc.active = true AND sp.available = true
             AND p.costo IS NOT NULL AND opc.standard_price IS NOT NULL
             AND opc.standard_price > 0
             AND ABS(p.costo - opc.standard_price) / opc.standard_price > ${PRICE_TOL}
             AND p.costo > opc.standard_price  THEN 'precio_sube'
        WHEN opc.active = true AND sp.available = true
             AND p.costo IS NOT NULL AND opc.standard_price IS NOT NULL
             AND opc.standard_price > 0
             AND ABS(p.costo - opc.standard_price) / opc.standard_price > ${PRICE_TOL}
             AND p.costo < opc.standard_price  THEN 'precio_baja'
        ELSE 'sin_cambios'
    END,
    p.costo,
    p.precio_preventas,
    NOW()
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules scr
    ON  scr.supplier_id     = sp.supplier_id
    AND scr.source_category = sp.source_category
    AND scr.active = true
LEFT JOIN LATERAL (
    SELECT opc2.odoo_id, similarity(LOWER(sp.name), LOWER(opc2.name)) AS sim
    FROM odoo_products_cache opc2
    WHERE opc2.company = 'preventas'
      AND NOT EXISTS (
          SELECT 1 FROM preventas_sync_state pss2 WHERE pss2.odoo_product_id = opc2.odoo_id
      )
      AND similarity(LOWER(sp.name), LOWER(opc2.name)) >= 0.75
    ORDER BY sim DESC
    LIMIT 1
) best ON true
JOIN odoo_products_cache opc ON opc.odoo_id = best.odoo_id AND opc.company = 'preventas'
${PRECIO_LATERAL}
WHERE sp.available = true
  AND best.odoo_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM preventas_sync_state pss WHERE pss.supplier_product_id = sp.id
  )
ON CONFLICT DO NOTHING
`;

// ─── Step 3 (bis): código extraído de {} o () del nombre del scraper ──────────
// Ejemplos:  "PLANCHA {ITP113238}"  → busca ITP113238 en internal_ref de Odoo
//            "AURICULAR (BT-720)"   → busca BT-720 en internal_ref de Odoo
// Solo aplica a productos que aún no tienen match.

const BRACKET_CODE_SQL = `
INSERT INTO preventas_sync_state
    (supplier_product_id, odoo_product_id, supplier_id, match_type, match_score, estado, costo, precio_preventas, computed_at)
SELECT
    sp.id,
    opc.odoo_id,
    s.id,
    'bracket_code',
    87,
    ${ESTADO_CASE},
    p.costo,
    p.precio_preventas,
    NOW()
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules scr
    ON  scr.supplier_id     = sp.supplier_id
    AND scr.source_category = sp.source_category
    AND scr.active = true
CROSS JOIN LATERAL (
    -- Extrae código entre {} (prioridad) o entre () sin espacios internos
    SELECT UPPER(TRIM(COALESCE(
        (REGEXP_MATCH(sp.name, '[{]([^}]{3,50})[}]',          'i'))[1],
        (REGEXP_MATCH(sp.name, '[(]([A-Z0-9][A-Z0-9._/-]{2,30})[)]', 'i'))[1]
    ))) AS code
) ex
-- Busca ese código EXACTO (word boundary) en el nombre de productos Odoo sin match,
-- del MISMO PROVEEDOR. El proveedor Odoo viene del campo vendor_name (traído de Odoo).
-- Comparación normalizada: elimina espacios/puntuación para tolerar variaciones de nombre.
-- \m = inicio de palabra, \M = fin de palabra → WD81 NO coincide con WD810.
JOIN odoo_products_cache opc
    ON  ex.code IS NOT NULL
    AND LENGTH(ex.code) >= 4
    AND opc.company = 'preventas'
    AND opc.name ~* ('\m' || ex.code || '\M')
    AND opc.vendor_name IS NOT NULL
    AND UPPER(REGEXP_REPLACE(opc.vendor_name, '[^A-Z0-9]', '', 'g'))
        LIKE '%' || UPPER(REGEXP_REPLACE(s.name, '[^A-Z0-9]', '', 'g')) || '%'
    AND NOT EXISTS (
        SELECT 1 FROM preventas_sync_state pss2 WHERE pss2.odoo_product_id = opc.odoo_id
    )
${PRECIO_LATERAL}
WHERE NOT EXISTS (
    SELECT 1 FROM preventas_sync_state pss WHERE pss.supplier_product_id = sp.id
)
ON CONFLICT DO NOTHING
`;

// ─── Step 3: solo en Odoo ──────────────────────────────────────────────────────

const SOLO_ODOO_SQL = `
INSERT INTO preventas_sync_state (odoo_product_id, estado, computed_at)
SELECT opc.odoo_id, 'solo_odoo', NOW()
FROM odoo_products_cache opc
WHERE opc.company = 'preventas'
  AND opc.active IS NOT FALSE
  AND NOT EXISTS (
      SELECT 1 FROM preventas_sync_state pss WHERE pss.odoo_product_id = opc.odoo_id
  )
`;

// ─── Step 4: solo en scraper ──────────────────────────────────────────────────

const SOLO_SCRAPER_SQL = `
INSERT INTO preventas_sync_state
    (supplier_product_id, supplier_id, estado, costo, precio_preventas, computed_at)
SELECT
    sp.id,
    s.id,
    'solo_scraper',
    CASE WHEN sp.raw_price IS NOT NULL THEN
        ROUND(sp.raw_price * (1 - COALESCE(scr.discount_override, s.default_discount, 0) / 100.0 + 0.015), 2)
    END,
    CASE WHEN sp.raw_price IS NOT NULL THEN
        ROUND(sp.raw_price * 1.015 * (1 + COALESCE(scr.markup_preventas_override, s.markup_preventas, 0) / 100.0), 2)
    END,
    NOW()
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id
LEFT JOIN supplier_category_rules scr
    ON  scr.supplier_id     = sp.supplier_id
    AND scr.source_category = sp.source_category
    AND scr.active = true
WHERE sp.available = true
  AND NOT EXISTS (
      SELECT 1 FROM preventas_sync_state pss WHERE pss.supplier_product_id = sp.id
  )
`;

// ─── Estado del recomputo (para status endpoint) ──────────────────────────────

let _recomputing = false;
function isRecomputing() { return _recomputing; }

// ─── recomputeAll ─────────────────────────────────────────────────────────────
// Estrategia shadow table: construye en tabla temporal, swap atómico al final.
// La tabla principal queda readable durante todo el proceso (sin bloqueos de lectura).
// Orden de matching:
//   1. exact_sku / barcode / internal_ref / name_key  (MATCH_SQL)
//   2. fuzzy nombre                                   (FUZZY_SQL)
//   3. código en {} / ()  — ÚLTIMO método, solo sobrantes (BRACKET_CODE_SQL)

async function recomputeAll(pool) {
    if (_recomputing) throw new Error('Ya hay un recomputo en progreso');

    const client = await pool.connect();
    try {
        const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1)', [LOCK_KEY]);
        if (!lockRows[0].pg_try_advisory_lock) {
            throw new Error('Ya hay un recomputo en progreso');
        }

        _recomputing = true;
        const start = Date.now();
        console.log('📦 Preventas Sync: iniciando recomputo de relaciones...');

        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm').catch(() => {});
        const { rows: trgmRows } = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
        const hasTrgm = trgmRows.length > 0;

        // Limpiar shadow table de una corrida anterior fallida
        await client.query('DROP TABLE IF EXISTS preventas_sync_state_building');

        // Shadow table con SERIAL propio + índices únicos (necesarios para ON CONFLICT DO NOTHING)
        await client.query(`
            CREATE TABLE preventas_sync_state_building (
                id                  SERIAL PRIMARY KEY,
                supplier_product_id INTEGER,
                odoo_product_id     INTEGER,
                supplier_id         INTEGER,
                match_type          VARCHAR(30),
                match_score         NUMERIC(5,2),
                estado              VARCHAR(30) NOT NULL,
                costo               NUMERIC(12,2),
                precio_preventas    NUMERIC(12,2),
                computed_at         TIMESTAMP DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE UNIQUE INDEX ON preventas_sync_state_building(supplier_product_id)
            WHERE supplier_product_id IS NOT NULL
        `);
        await client.query(`
            CREATE UNIQUE INDEX ON preventas_sync_state_building(odoo_product_id)
            WHERE odoo_product_id IS NOT NULL
        `);

        // Redirige todos los INSERT/NOT EXISTS a la shadow table
        const b = sql => sql.replace(/\bpreventas_sync_state\b/g, 'preventas_sync_state_building');

        // Paso 1: matches determinísticos
        await client.query(b(MATCH_SQL));

        // Paso 2: fuzzy por nombre
        if (hasTrgm) {
            try {
                await client.query(b(FUZZY_SQL));
            } catch (err) {
                console.warn('⚠️ Fuzzy matching falló (no crítico):', err.message);
            }
        }

        // Paso 3: código en {} / () — ÚLTIMO método, solo sobrantes
        try {
            await client.query(b(BRACKET_CODE_SQL));
        } catch (err) {
            console.warn('⚠️ Bracket code matching falló (no crítico):', err.message);
        }

        // Paso 4-5: solo_odoo y solo_scraper
        await client.query(b(SOLO_ODOO_SQL));
        await client.query(b(SOLO_SCRAPER_SQL));

        // Swap atómico — bloquea la tabla principal por milisegundos
        await client.query('BEGIN');
        await client.query('TRUNCATE preventas_sync_state RESTART IDENTITY');
        await client.query(`
            INSERT INTO preventas_sync_state
                (supplier_product_id, odoo_product_id, supplier_id,
                 match_type, match_score, estado, costo, precio_preventas, computed_at)
            SELECT supplier_product_id, odoo_product_id, supplier_id,
                   match_type, match_score, estado, costo, precio_preventas, computed_at
            FROM preventas_sync_state_building
        `);
        await client.query('COMMIT');

        await client.query('DROP TABLE preventas_sync_state_building');

        const elapsed = Date.now() - start;
        const { rows: stats }   = await client.query(`SELECT estado, COUNT(*)::INTEGER AS cnt FROM preventas_sync_state GROUP BY estado`);
        const { rows: mtStats } = await client.query(`SELECT COALESCE(match_type,'sin_match') AS mt, COUNT(*)::INTEGER AS cnt FROM preventas_sync_state GROUP BY mt`);

        const summary = { elapsed_ms: elapsed, total: 0 };
        for (const r of stats) { summary[r.estado] = r.cnt; summary.total += r.cnt; }
        const mtLog = mtStats.map(r => `${r.mt}:${r.cnt}`).join(' ');
        console.log(`✅ Preventas Sync: ${summary.total} total — ${mtLog} — ${elapsed}ms`);

        return summary;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        await client.query('DROP TABLE IF EXISTS preventas_sync_state_building').catch(() => {});
        throw err;
    } finally {
        _recomputing = false;
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        client.release();
    }
}

// Disparo asincrónico — no bloquea al llamador
function scheduleRecompute(pool) {
    setImmediate(async () => {
        try {
            await recomputeAll(pool);
        } catch (err) {
            if (!err.message.includes('en progreso')) {
                console.error('❌ Preventas Sync recomputo background:', err.message);
            }
        }
    });
}

module.exports = { recomputeAll, scheduleRecompute, isRecomputing };
