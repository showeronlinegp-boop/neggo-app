const bcrypt = require('bcryptjs');
const pool = require('./config/database');

// Inicializar datos que requieren lógica de Node (ej: bcrypt hash)
async function initDatabase() {
    try {
        // Verificar si ya existe el admin
        const { rows } = await pool.query(
            "SELECT id FROM users WHERE username = 'admin'"
        );

        if (rows.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(
                `INSERT INTO users (username, password_hash, display_name, role)
                 VALUES ('admin', $1, 'Administrador', 'admin')`,
                [hash]
            );
            console.log('✅ Usuario admin creado (password: admin123)');
        }

        // =============================================
        // Migraciones en caliente (idempotentes)
        // =============================================
        await pool.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'staging'`);
        await pool.query(`ALTER TABLE suppliers ADD CONSTRAINT IF NOT EXISTS suppliers_status_check CHECK (status IN ('staging','active','inactive'))`).catch(() => {});
        await pool.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS scrape_config JSONB DEFAULT '{}'`);

        // Crear índice de status si no existe
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status)`).catch(() => {});

        // Actualizar constraint de scraping_runs.status (incluye 'cancelled' y 'paused')
        await pool.query(`
            ALTER TABLE scraping_runs DROP CONSTRAINT IF EXISTS scraping_runs_status_check
        `).catch(() => {});
        await pool.query(`
            ALTER TABLE scraping_runs ADD CONSTRAINT scraping_runs_status_check
            CHECK (status IN ('running','completed','failed','partial','cancelled','paused'))
        `).catch(() => {});

        // Columna de checkpoint para pause/resume
        await pool.query(`
            ALTER TABLE scraping_runs ADD COLUMN IF NOT EXISTS completed_categories JSONB DEFAULT '[]'
        `).catch(() => {});

        // Limpiar runs que quedaron en 'running' de sesiones anteriores (backend reiniciado)
        const { rowCount: staleCount } = await pool.query(`
            UPDATE scraping_runs
            SET status = 'failed', finished_at = NOW()
            WHERE status = 'running'
        `).catch(() => ({ rowCount: 0 }));
        if (staleCount > 0) {
            console.log(`⚠️ ${staleCount} run(s) fantasma marcados como 'failed' (backend reiniciado)`);
        }

        // Crear tabla sync_log si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sync_log (
                id SERIAL PRIMARY KEY,
                company VARCHAR(20) NOT NULL UNIQUE,
                last_sync TIMESTAMP,
                records_synced INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        // Agregar UNIQUE a company si la tabla ya existía sin el constraint
        await pool.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'sync_log_company_key'
                ) THEN
                    ALTER TABLE sync_log ADD CONSTRAINT sync_log_company_key UNIQUE (company);
                END IF;
            END $$;
        `).catch(() => {});

        // Fuentes de scraping (migración 019): web vs Neggo interno + habilitación por proveedor
        await pool.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS scrape_enabled BOOLEAN NOT NULL DEFAULT false`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_suppliers_scrape_enabled ON suppliers(scrape_enabled)`);
        await pool.query(`ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'web'`);
        await pool.query(`ALTER TABLE supplier_products ADD CONSTRAINT supplier_products_source_check CHECK (source IN ('web', 'neggo'))`).catch(() => {});
        await pool.query(`ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS neggo_odoo_id INTEGER`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_sp_neggo_odoo ON supplier_products(neggo_odoo_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_sp_source ON supplier_products(source)`);
        await pool.query(`
            INSERT INTO app_config (key, value) VALUES ('preventas_inactivar_max_dias', '7')
            ON CONFLICT (key) DO NOTHING
        `);

        // Notas de prueba (migración 021). La tabla existe siempre; las rutas solo con TEST_NOTES_ENABLED=1
        await pool.query(`
            CREATE TABLE IF NOT EXISTS test_notes (
                id           SERIAL PRIMARY KEY,
                tipo         VARCHAR(20) NOT NULL DEFAULT 'error'
                             CHECK (tipo IN ('error', 'mejora', 'duda')),
                estado       VARCHAR(20) NOT NULL DEFAULT 'abierta'
                             CHECK (estado IN ('abierta', 'en_curso', 'consulta', 'para_revisar', 'corregida', 'descartada')),
                texto        TEXT NOT NULL,
                respuesta    TEXT,
                modo         TEXT[] NOT NULL DEFAULT '{}',
                ruta         VARCHAR(500),
                pantalla     VARCHAR(200),
                selector     VARCHAR(2000),
                elemento     VARCHAR(300),
                pos_x        NUMERIC(8,4),
                pos_y        NUMERIC(10,2),
                contexto     JSONB NOT NULL DEFAULT '{}',
                user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                resuelta_at  TIMESTAMP,
                created_at   TIMESTAMP DEFAULT NOW(),
                updated_at   TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_notes_estado ON test_notes(estado)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_notes_ruta ON test_notes(ruta)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_notes_user ON test_notes(user_id)`);

        // Proveedores iniciales (solo en una base vacía). Las credenciales van en .env, no acá.
        const { rows: suppliers } = await pool.query('SELECT COUNT(*) FROM suppliers');
        if (parseInt(suppliers[0].count, 10) === 0) {
            await pool.query(`
                INSERT INTO suppliers
                    (name, prefix, website_url, scraper_key, price_format, status, scrape_enabled)
                VALUES
                    ('CastMayorista', 'CT', 'https://www.castmayorista.com.ar', 'cast',      'ar', 'active', true),
                    ('Mali',          'ML', 'https://www.mali.com.ar',          'mali',      'ar', 'active', true),
                    ('El Rey',        'ER', 'https://catalog.smarty.com.ar',    'elrey',     'ar', 'active', true),
                    ('Impotekno',     'IT', 'https://impotekno.com',            'impotekno', 'ar', 'active', true)
            `);
            console.log('✅ Proveedores iniciales creados (Cast, Mali, El Rey, Impotekno)');
        }

        // Verificar config inicial
        const { rows: config } = await pool.query('SELECT COUNT(*) FROM app_config');
        if (parseInt(config[0].count, 10) === 0) {
            await pool.query(`
                INSERT INTO app_config (key, value) VALUES
                    ('odoo_sync_interval_hours', '"2"'),
                    ('odoo_neggo_company_id', 'null'),
                    ('odoo_preventas_company_id', 'null'),
                    ('last_odoo_sync', 'null')
            `);
            console.log('✅ Configuración inicial creada');
        }

        // Ingreso v2: cantidad recibida físicamente y tamaño de pack
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS received_qty INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS pack_size INTEGER DEFAULT 1`);

        // Ingreso v3: triangulación con producto scrapeado del proveedor
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE SET NULL`);
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS supplier_match_level VARCHAR(20) DEFAULT 'none'`);
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS supplier_confidence NUMERIC(4,2) DEFAULT 0`);

        // Campo odoo_company en ingreso_items para soporte multi-empresa
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS odoo_company VARCHAR(20) DEFAULT 'neggo'`).catch(() => {});

        // Producto Preventas vinculado manualmente: se usa en confirmIngreso para generar la OC de Preventas
        // para ítems sin match automático (no tienen el prefijo PRE- en el cache de Preventas)
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS preventas_product_id INTEGER`).catch(() => {});
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS preventas_product_name VARCHAR(500)`).catch(() => {});

        // Limpiar invoice_code_mappings con códigos sin sentido (guiones, vacíos, etc.)
        // Estos códigos no son identificadores únicos y generan falsos positivos en futuros ingresos
        const { rowCount: mappingsCleaned } = await pool.query(`
            DELETE FROM invoice_code_mappings
            WHERE TRIM(raw_code) = ANY(ARRAY[
                '', '-', '--', '---', 'n/a', 'na', 's/cod',
                'sin codigo', 'sin cod', 'sc', '0', 'none', 'null'
            ])
               OR raw_code !~ '[a-zA-Z0-9]'
        `).catch(() => ({ rowCount: 0 }));
        if (mappingsCleaned > 0) {
            console.log(`🧹 ${mappingsCleaned} mapping(s) con códigos inválidos eliminados de invoice_code_mappings`);
        }

        // Costo de envío en ingresos de mercadería
        await pool.query(`ALTER TABLE ingreso_mercaderia ADD COLUMN IF NOT EXISTS costo_envio NUMERIC(14,2) DEFAULT 0`).catch(() => {});

        // Cache Odoo: description_purchase para matching mejorado
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS description_purchase TEXT`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_opc_desc_purchase ON odoo_products_cache(description_purchase) WHERE description_purchase IS NOT NULL`).catch(() => {});

        // pg_trgm para fuzzy matching
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm').catch(() => {});

        // Tabla de estado pre-computado (migración 009)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS preventas_sync_state (
                id                  SERIAL PRIMARY KEY,
                supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
                odoo_product_id     INTEGER,
                supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
                match_type          VARCHAR(30),
                match_score         NUMERIC(5,2),
                estado              VARCHAR(30) NOT NULL,
                costo               NUMERIC(12,2),
                precio_preventas    NUMERIC(12,2),
                computed_at         TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pss_sp_uniq   ON preventas_sync_state(supplier_product_id) WHERE supplier_product_id IS NOT NULL`).catch(() => {});
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pss_odoo_uniq ON preventas_sync_state(odoo_product_id)     WHERE odoo_product_id     IS NOT NULL`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pss_estado   ON preventas_sync_state(estado)`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pss_supplier ON preventas_sync_state(supplier_id) WHERE supplier_id IS NOT NULL`).catch(() => {});

        // Migración 010: vendor_name en odoo_products_cache
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(200)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_opc_vendor ON odoo_products_cache(vendor_name) WHERE vendor_name IS NOT NULL`).catch(() => {});

        // Migración 008: name_key en supplier_products + external_id/ext_id_clean en odoo_products_cache
        await pool.query(`ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS name_key VARCHAR(500)`);
        await pool.query(`
            UPDATE supplier_products
            SET name_key = UPPER(REGEXP_REPLACE(name, '[^A-Za-z0-9]', '', 'g'))
            WHERE name_key IS NULL
        `).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_sp_name_key ON supplier_products(name_key)`).catch(() => {});

        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS external_id VARCHAR(200)`);
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS ext_id_clean VARCHAR(200)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_opc_external_id  ON odoo_products_cache(external_id)  WHERE external_id  IS NOT NULL`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_opc_ext_id_clean ON odoo_products_cache(ext_id_clean) WHERE ext_id_clean IS NOT NULL`).catch(() => {});

        // Tablas de alertas de precio y categorías pendientes (pueden no existir si pg_data ya estaba creado)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pending_category_mappings (
                id SERIAL PRIMARY KEY,
                supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
                source_category VARCHAR(200) NOT NULL,
                sample_products JSONB DEFAULT '[]',
                status VARCHAR(20) DEFAULT 'pending',
                resolved_at TIMESTAMP,
                resolved_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(supplier_id, source_category)
            )
        `).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pcm_supplier ON pending_category_mappings(supplier_id)`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pcm_status ON pending_category_mappings(status)`).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS price_alerts (
                id SERIAL PRIMARY KEY,
                supplier_product_id INTEGER REFERENCES supplier_products(id) ON DELETE CASCADE,
                alert_type VARCHAR(30) NOT NULL,
                old_price NUMERIC(12,2),
                new_price NUMERIC(12,2),
                pct_change NUMERIC(6,2),
                linked_odoo_products JSONB DEFAULT '[]',
                company VARCHAR(20),
                status VARCHAR(20) DEFAULT 'pending',
                reviewed_by INTEGER REFERENCES users(id),
                reviewed_at TIMESTAMP,
                notes TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        // Agregar columnas faltantes si la tabla ya existía sin ellas
        await pool.query(`ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS company VARCHAR(20)`).catch(() => {});
        await pool.query(`ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS linked_odoo_products JSONB DEFAULT '[]'`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status)`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_created ON price_alerts(created_at DESC)`).catch(() => {});

        // Migración 013: normalizar columnas de supplier_category_rules
        // Renombrar dest_category → dest_category_neggo (si aún existe el nombre viejo)
        await pool.query(`
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'supplier_category_rules' AND column_name = 'dest_category'
                ) THEN
                    ALTER TABLE supplier_category_rules RENAME COLUMN dest_category TO dest_category_neggo;
                END IF;
            END $$;
        `).catch(() => {});
        await pool.query(`ALTER TABLE supplier_category_rules ALTER COLUMN dest_category_neggo DROP NOT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS dest_category_preventas VARCHAR(200)`).catch(() => {});
        await pool.query(`ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS ignored BOOLEAN DEFAULT false`).catch(() => {});

        // Migración 012: IDs de categoría Odoo en reglas de categoría
        await pool.query(`ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS odoo_categ_id_neggo INTEGER`).catch(() => {});
        await pool.query(`ALTER TABLE supplier_category_rules ADD COLUMN IF NOT EXISTS odoo_categ_id_preventas INTEGER`).catch(() => {});

        // Migración 014: links múltiples de preventa por ítem de ingreso
        await pool.query(`ALTER TABLE ingreso_items ADD COLUMN IF NOT EXISTS preventa_links JSONB DEFAULT '[]'`).catch(() => {});

        // Migración 015: campos adicionales de Odoo en cache de productos
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS available_in_pos BOOLEAN`).catch(() => {});
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS is_published BOOLEAN`).catch(() => {});
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS categ_id_odoo INTEGER`).catch(() => {});
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS web_categ_id INTEGER`).catch(() => {});
        await pool.query(`ALTER TABLE odoo_products_cache ADD COLUMN IF NOT EXISTS web_categ_name VARCHAR(200)`).catch(() => {});

        console.log('✅ Base de datos inicializada correctamente');
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error.message);
        throw error;
    }
}

module.exports = initDatabase;
