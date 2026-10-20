-- Migración 028: reglas de categoría de Cast (Store API) y El Rey
--
-- Estas reglas se cargaron primero a mano en la base, aprobadas por el usuario:
-- - Cast con la Store API trae la categoría general (Bazar, Tecnologia, Almohadas)
-- - El Rey volvió a traer productos con el scraper Python y sumó sus categorías
-- Igual para Neggo y Preventas. Si la regla ya existe no se toca. Idempotente.

BEGIN;

INSERT INTO supplier_category_rules
    (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
     odoo_categ_id_neggo, odoo_categ_id_preventas)
SELECT s.id, m.source_category, m.dest_category, m.dest_category, m.odoo_categ_id, m.odoo_categ_id
FROM (VALUES
    ('CastMayorista', 'Bazar',            'Bazar',      156),
    ('CastMayorista', 'Tecnologia',       'Tecnología', 169),
    ('CastMayorista', 'Almohadas',        'Bazar',      156),
    ('El Rey',        'LIMPIEZA',         'Limpieza',   243),
    ('El Rey',        'Perfumería',       'Perfumería', 242),
    ('El Rey',        'Hogar y Bazar',    'Bazar',      156),
    ('El Rey',        'Artículos Kiosco', 'Kiosco',     244),
    ('El Rey',        'Insecticidas',     'Limpieza',   243)
) AS m (supplier_name, source_category, dest_category, odoo_categ_id)
JOIN suppliers s ON s.name = m.supplier_name
ON CONFLICT (supplier_id, source_category) DO NOTHING;

COMMIT;
