-- Notas de prueba: cosas a cambiar marcadas en pantalla ("Marcar" en la app).
-- Las trabaja Claude Code desde una terminal (botón "Enviar a Claude" → neggo-claude://nota/<id>).
-- Las rutas /api/test-notes solo existen con TEST_NOTES_ENABLED=1; la tabla puede existir siempre.

CREATE TABLE IF NOT EXISTS test_notes (
    id           SERIAL PRIMARY KEY,
    tipo         VARCHAR(20) NOT NULL DEFAULT 'error'
                 CHECK (tipo IN ('error', 'mejora', 'duda')),
    estado       VARCHAR(20) NOT NULL DEFAULT 'abierta'
                 CHECK (estado IN ('abierta', 'en_curso', 'consulta', 'para_revisar', 'corregida', 'descartada')),
    texto        TEXT NOT NULL,
    respuesta    TEXT,
    -- Modo de trabajo pedido a Claude: vacío = directo; si no, debatir / investigar / consultas
    modo         TEXT[] NOT NULL DEFAULT '{}',
    ruta         VARCHAR(500),
    pantalla     VARCHAR(200),
    selector     VARCHAR(2000),
    elemento     VARCHAR(300),
    pos_x        NUMERIC(8,4),
    pos_y        NUMERIC(10,2),
    -- Errores de consola, llamadas /api fallidas, viewport, user agent
    contexto     JSONB NOT NULL DEFAULT '{}',
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resuelta_at  TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_notes_estado ON test_notes(estado);
CREATE INDEX IF NOT EXISTS idx_test_notes_ruta ON test_notes(ruta);
CREATE INDEX IF NOT EXISTS idx_test_notes_user ON test_notes(user_id);
