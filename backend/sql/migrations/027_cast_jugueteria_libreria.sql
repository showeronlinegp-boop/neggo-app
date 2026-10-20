-- Migración 027: reglas de categoría para las nuevas categorías de Cast
--
-- El scraper de Cast (Store API) ahora también trae Juguetería y Librería.
-- Se mapean a las categorías de Odoo 163 Jugueteria y 164 Libreria, igual para
-- Neggo y Preventas. Si la regla ya existe no se toca. Idempotente.

BEGIN;

INSERT INTO supplier_category_rules
    (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
     odoo_categ_id_neggo, odoo_categ_id_preventas)
SELECT s.id, m.source_category, m.dest_category, m.dest_category, m.odoo_categ_id, m.odoo_categ_id
FROM (VALUES
    ('Jugueteria', 'Jugueteria', 163),
    ('Libreria',   'Libreria',   164)
) AS m (source_category, dest_category, odoo_categ_id)
JOIN suppliers s ON s.name = 'CastMayorista'
ON CONFLICT (supplier_id, source_category) DO NOTHING;

COMMIT;
