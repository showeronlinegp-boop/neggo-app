-- Grupo de avisos de la comunidad de Neggo en WhatsApp (nota 228): quién está, quién se fue y
-- cómo se mueve el grupo. WhatsApp no deja historial de entradas y salidas, así que se arma de acá
-- en adelante con una foto de los miembros por día (y al tocar Actualizar en Clientes › Chats).
-- La lista sale del WhatsApp del negocio (neggo-evolution-negocio) en solo lectura.
-- Idempotente: la aplica grupoAvisosService al arrancar.

-- Una fila por persona que alguna vez vimos en el grupo. activo = está en la última foto.
CREATE TABLE IF NOT EXISTS whatsapp_grupo_miembros (
    id SERIAL PRIMARY KEY,
    grupo_jid VARCHAR(40) NOT NULL,
    lid VARCHAR(40) NOT NULL,
    numero VARCHAR(20),
    admin VARCHAR(20),
    activo BOOLEAN NOT NULL DEFAULT true,
    -- primera foto en la que apareció (en la foto inicial = "ya estaba", no se sabe desde cuándo)
    visto_desde TIMESTAMP NOT NULL DEFAULT NOW(),
    desde_foto_inicial BOOLEAN NOT NULL DEFAULT false,
    visto_ultima_vez TIMESTAMP NOT NULL DEFAULT NOW(),
    salio_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (grupo_jid, lid)
);

CREATE INDEX IF NOT EXISTS idx_wa_grupo_miembros_numero ON whatsapp_grupo_miembros (grupo_jid, numero);
CREATE INDEX IF NOT EXISTS idx_wa_grupo_miembros_activo ON whatsapp_grupo_miembros (grupo_jid, activo);

-- Cada foto de la lista: cuántos había y cuántos entraron o se fueron desde la anterior.
CREATE TABLE IF NOT EXISTS whatsapp_grupo_fotos (
    id SERIAL PRIMARY KEY,
    grupo_jid VARCHAR(40) NOT NULL,
    nombre VARCHAR(120),
    total INTEGER NOT NULL,
    altas INTEGER NOT NULL DEFAULT 0,
    bajas INTEGER NOT NULL DEFAULT 0,
    inicial BOOLEAN NOT NULL DEFAULT false,
    origen VARCHAR(20) NOT NULL DEFAULT 'cron',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_grupo_fotos_grupo ON whatsapp_grupo_fotos (grupo_jid, created_at DESC);

-- Entradas y salidas detectadas entre una foto y la siguiente (las de la foto inicial no van).
CREATE TABLE IF NOT EXISTS whatsapp_grupo_movimientos (
    id SERIAL PRIMARY KEY,
    grupo_jid VARCHAR(40) NOT NULL,
    foto_id INTEGER NOT NULL REFERENCES whatsapp_grupo_fotos(id) ON DELETE CASCADE,
    lid VARCHAR(40) NOT NULL,
    numero VARCHAR(20),
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('entro', 'salio')),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_grupo_mov_grupo ON whatsapp_grupo_movimientos (grupo_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_grupo_mov_foto ON whatsapp_grupo_movimientos (foto_id);
CREATE INDEX IF NOT EXISTS idx_wa_grupo_mov_lid ON whatsapp_grupo_movimientos (grupo_jid, lid);
