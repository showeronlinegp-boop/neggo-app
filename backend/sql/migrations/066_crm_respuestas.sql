-- CRM sobre WhatsApp: preguntas frecuentes y los mensajes que van como respuesta. Las usan el
-- equipo (Clientes › Respuestas, para copiar o mandar por WhatsApp) y Grok por la API, así todos
-- dicen lo mismo. informar_a_todos = objetivo de nutrición "Informar": a cada prospecto hay que
-- contárselo aunque no pregunte (mínimo de compra, horario, dónde estamos).
-- Idempotente: la aplica crmRespuestasService al arrancar.

CREATE TABLE IF NOT EXISTS crm_respuestas (
    id SERIAL PRIMARY KEY,
    pregunta VARCHAR(200) NOT NULL,
    respuesta TEXT NOT NULL DEFAULT '',
    informar_a_todos BOOLEAN NOT NULL DEFAULT false,
    activa BOOLEAN NOT NULL DEFAULT true,
    orden INTEGER NOT NULL DEFAULT 0,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_respuestas_orden ON crm_respuestas (orden, id);

-- Las tres que ya usa el mensaje de presentación; solo la primera vez (tabla vacía).
-- La ubicación queda sin texto hasta que alguien la cargue.
INSERT INTO crm_respuestas (pregunta, respuesta, informar_a_todos, orden)
SELECT v.pregunta, v.respuesta, true, v.orden
  FROM (VALUES
        ('¿Cuál es el mínimo de compra?', 'El mínimo de compra es $50.000.', 1),
        ('¿Qué horario tienen?', E'Nuestro horario comercial es:\nLunes a viernes: 9:00 a 18:00\nSábado: 9:00 a 14:00', 2),
        ('¿Dónde están ubicados?', '', 3)
       ) AS v(pregunta, respuesta, orden)
 WHERE NOT EXISTS (SELECT 1 FROM crm_respuestas);
