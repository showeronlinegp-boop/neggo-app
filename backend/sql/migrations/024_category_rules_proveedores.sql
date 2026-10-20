-- Migración 024: reglas de categoría de los proveedores → categorías de Odoo
--
-- Asigna cada source_category scrapeada a su categoría de Odoo, igual para Neggo y
-- Preventas (en Odoo las dos empresas comparten los IDs de product.category).
-- Las categorías repetidas de Odoo se unifican: "Accesorios de Moda" → 155 Accesorios Moda,
-- "Tecnologia" → 169 Tecnología, "Bazar6920253361236" → 156 Bazar.
--
-- Este mapeo lo aprobó el usuario y manda: si la regla ya existe (por ejemplo, la carga
-- masiva de la nota #24), se actualiza la categoría destino. Idempotente.

BEGIN;

CREATE TEMP TABLE tmp_category_map (
    supplier_name   VARCHAR(200),
    source_category VARCHAR(200),
    dest_category   VARCHAR(200),
    odoo_categ_id   INTEGER
) ON COMMIT DROP;

INSERT INTO tmp_category_map (supplier_name, source_category, dest_category, odoo_categ_id) VALUES
    -- Proveedores que ya usan los nombres de categoría de Odoo (1 a 1)
    ('Chuang Yi', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('Chuang Yi', 'Accesorios de Moda', 'Accesorios Moda', 155),
    ('Chuang Yi', 'Bazar', 'Bazar', 156),
    ('Chuang Yi', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('Chuang Yi', 'Cotillon', 'Cotillon', 158),
    ('Chuang Yi', 'Ferreteria', 'Ferreteria', 160),
    ('Chuang Yi', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('Chuang Yi', 'Jugueteria', 'Jugueteria', 163),
    ('Chuang Yi', 'Libreria', 'Libreria', 164),
    ('Chuang Yi', 'Merceria', 'Merceria', 165),
    ('Chuang Yi', 'Perfumería', 'Perfumería', 242),
    ('Chuang Yi', 'Tecnologia', 'Tecnología', 169),
    ('Chuang Yi', 'Tecnología', 'Tecnología', 169),
    ('DDATAE', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('DDATAE', 'Accesorios de Moda', 'Accesorios Moda', 155),
    ('DDATAE', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('DDATAE', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('Feminix', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('Feminix', 'Accesorios de Moda', 'Accesorios Moda', 155),
    ('Feminix', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('Feminix', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('Feminix', 'Jugueteria', 'Jugueteria', 163),
    ('Matemundo', 'Bazar', 'Bazar', 156),
    ('Nueva Roma', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('Nueva Roma', 'Jugueteria', 'Jugueteria', 163),
    ('Nueva Roma', 'Libreria', 'Libreria', 164),
    ('Pan Lin', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('Pan Lin', 'Bazar', 'Bazar', 156),
    ('Pan Lin', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('Pan Lin', 'Cotillon', 'Cotillon', 158),
    ('Pan Lin', 'Ferreteria', 'Ferreteria', 160),
    ('Pan Lin', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('Pan Lin', 'Jugueteria', 'Jugueteria', 163),
    ('Pan Lin', 'Kiosco', 'Kiosco', 244),
    ('Pan Lin', 'Libreria', 'Libreria', 164),
    ('Pan Lin', 'Merceria', 'Merceria', 165),
    ('Pan Lin', 'Tecnología', 'Tecnología', 169),
    ('Parnassa', 'Deportes', 'Deportes', 177),
    ('Parnassa', 'Jugueteria', 'Jugueteria', 163),
    ('Renacer', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('Renacer', 'Bazar', 'Bazar', 156),
    ('Renacer', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('Renacer', 'Ferreteria', 'Ferreteria', 160),
    ('Renacer', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('Renacer', 'Jugueteria', 'Jugueteria', 163),
    ('Renacer', 'Libreria', 'Libreria', 164),
    ('Renacer', 'Merceria', 'Merceria', 165),
    ('Renacer', 'Tecnología', 'Tecnología', 169),
    ('Sky Color', 'Libreria', 'Libreria', 164),
    ('Toys Palace', 'Bazar', 'Bazar', 156),
    ('Toys Palace', 'Jugueteria', 'Jugueteria', 163),
    ('yamile', 'Accesorios Moda', 'Accesorios Moda', 155),
    ('yamile', 'Bazar', 'Bazar', 156),
    ('yamile', 'Belleza y Cuidado Personal', 'Belleza y Cuidado Personal', 157),
    ('yamile', 'Insumos de Comercios', 'Insumos de Comercios', 162),
    ('yamile', 'Jugueteria', 'Jugueteria', 163),
    ('yamile', 'Libreria', 'Libreria', 164),
    ('yamile', 'Merceria', 'Merceria', 165),

    -- Mali: trae todo como "General" y es todo librería
    ('Mali', 'General', 'Libreria', 164),

    -- CastMayorista
    ('CastMayorista', 'Belleza', 'Belleza y Cuidado Personal', 157),
    ('CastMayorista', 'Cosmeticos', 'Belleza y Cuidado Personal', 157),
    ('CastMayorista', 'Peluqueria', 'Belleza y Cuidado Personal', 157),
    ('CastMayorista', 'Perfumeria', 'Perfumería', 242),
    ('CastMayorista', 'Botellas', 'Bazar', 156),
    ('CastMayorista', 'Vasos Termicos', 'Bazar', 156),
    ('CastMayorista', 'Vasos y Copas', 'Bazar', 156),
    ('CastMayorista', 'Mascotas', 'Bazar', 156),
    ('CastMayorista', 'Cotillon', 'Cotillon', 158),
    ('CastMayorista', 'Electronica', 'Tecnología', 169),
    ('CastMayorista', 'Ferreteria', 'Ferreteria', 160),
    ('CastMayorista', 'Indumentaria', 'Ropa', 247),
    ('CastMayorista', 'Mochilas y Bolsos', 'Accesorios Moda', 155),
    ('CastMayorista', 'Paraguas', 'Accesorios Moda', 155),
    ('CastMayorista', 'Relojeria', 'Accesorios Moda', 155),
    ('CastMayorista', 'Llaveros', 'Regaleria', 245),

    -- Impotekno ("VARIEDADES" mezcla rubros: va a Bazar por defecto)
    ('Impotekno', 'AURICULARES BLUETOOTH', 'Tecnología', 169),
    ('Impotekno', 'AURICULARES EARPHONE', 'Tecnología', 169),
    ('Impotekno', 'AURICULARES VINCHA C/CABLE', 'Tecnología', 169),
    ('Impotekno', 'CABLES /ADAPTADORES', 'Tecnología', 169),
    ('Impotekno', 'CARGADORES Y FUENTES', 'Tecnología', 169),
    ('Impotekno', 'CONSOLAS Y COMPUTACION', 'Tecnología', 169),
    ('Impotekno', 'PARLANTES y MICROFONOS', 'Tecnología', 169),
    ('Impotekno', 'TECNOLOGIA', 'Tecnología', 169),
    ('Impotekno', 'BAZAR', 'Bazar', 156),
    ('Impotekno', 'BOTELLAS Y VASOS', 'Bazar', 156),
    ('Impotekno', 'HOGAR', 'Bazar', 156),
    ('Impotekno', 'ILUMINACION', 'Bazar', 156),
    ('Impotekno', 'VARIEDADES', 'Bazar', 156),
    ('Impotekno', 'AUTO /BICI/TV Y CELL', 'Ferreteria', 160),
    ('Impotekno', 'GRIFERIA', 'Ferreteria', 160),
    ('Impotekno', 'HERRAMIENTAS', 'Ferreteria', 160),
    ('Impotekno', 'BELLEZA', 'Belleza y Cuidado Personal', 157),
    ('Impotekno', 'LIBRERIA y OFICINA', 'Libreria', 164),
    ('Impotekno', 'NAVIDAD', 'Cotillon', 158),
    -- el scraper hoy guarda la Ñ rota (U+FFFD); se carga también la versión correcta
    ('Impotekno', 'TODO PARA EL NI�O', 'Jugueteria', 163),
    ('Impotekno', 'TODO PARA EL NIÑO', 'Jugueteria', 163),

    -- Babu ("ACCESORIOS" y "ELECTRONICO" mezclan rubros: van a Bazar por defecto)
    ('Babu', 'ADAPTADORES', 'Tecnología', 169),
    ('Babu', 'ADAPTADORES CON CABLES', 'Tecnología', 169),
    ('Babu', 'ALARGUE', 'Tecnología', 169),
    ('Babu', 'ANILLO PARA CELU', 'Tecnología', 169),
    ('Babu', 'ANTENAS', 'Tecnología', 169),
    ('Babu', 'ARO LUZ', 'Tecnología', 169),
    ('Babu', 'AURICULAR INALAMBRICO', 'Tecnología', 169),
    ('Babu', 'AURICULARES', 'Tecnología', 169),
    ('Babu', 'AURICULARES VINCHA', 'Tecnología', 169),
    ('Babu', 'AUXILIAR', 'Tecnología', 169),
    ('Babu', 'CABEZALES', 'Tecnología', 169),
    ('Babu', 'CABLE AUDIO Y VIDEO', 'Tecnología', 169),
    ('Babu', 'CABLE DE RED', 'Tecnología', 169),
    ('Babu', 'CABLES USB', 'Tecnología', 169),
    ('Babu', 'CAMARA', 'Tecnología', 169),
    ('Babu', 'CAMARAS', 'Tecnología', 169),
    ('Babu', 'CAR BLUTUD', 'Tecnología', 169),
    ('Babu', 'CARGADOR AUTO', 'Tecnología', 169),
    ('Babu', 'CARGADOR IPHONE', 'Tecnología', 169),
    ('Babu', 'CARGADOR PORTATIL', 'Tecnología', 169),
    ('Babu', 'CARGADOR TC', 'Tecnología', 169),
    ('Babu', 'CARGADOR V8', 'Tecnología', 169),
    ('Babu', 'CARGADORES', 'Tecnología', 169),
    ('Babu', 'CONSOLAS DE JUEGOS', 'Tecnología', 169),
    ('Babu', 'FUNDA CELU', 'Tecnología', 169),
    ('Babu', 'HDMI', 'Tecnología', 169),
    ('Babu', 'JOYSTICK', 'Tecnología', 169),
    ('Babu', 'MEMORIA/PENDRIVE', 'Tecnología', 169),
    ('Babu', 'MICROFONO', 'Tecnología', 169),
    ('Babu', 'MOUSE', 'Tecnología', 169),
    ('Babu', 'MOUSE GAME', 'Tecnología', 169),
    ('Babu', 'PAD MOUSE', 'Tecnología', 169),
    ('Babu', 'PALO SELFIE', 'Tecnología', 169),
    ('Babu', 'PARLANTE', 'Tecnología', 169),
    ('Babu', 'PILAS', 'Tecnología', 169),
    ('Babu', 'PROYECTOR', 'Tecnología', 169),
    ('Babu', 'RADIO', 'Tecnología', 169),
    ('Babu', 'RAQUETA', 'Tecnología', 169),
    ('Babu', 'RELOJ', 'Tecnología', 169),
    ('Babu', 'SOPORTE CELU', 'Tecnología', 169),
    ('Babu', 'SOPORTE CELU PARA  AUTO', 'Tecnología', 169),
    ('Babu', 'SOPORTE PARA TV', 'Tecnología', 169),
    ('Babu', 'TECLADOS', 'Tecnología', 169),
    ('Babu', 'VGA', 'Tecnología', 169),
    ('Babu', 'ACCESORIOS', 'Bazar', 156),
    ('Babu', 'BALANZA', 'Bazar', 156),
    ('Babu', 'BATIDOR', 'Bazar', 156),
    ('Babu', 'BOMBILLA', 'Bazar', 156),
    ('Babu', 'BOTELLAS', 'Bazar', 156),
    ('Babu', 'CALOVENTOR', 'Bazar', 156),
    ('Babu', 'ELECTRONICO', 'Bazar', 156),
    ('Babu', 'LAMPARA', 'Bazar', 156),
    ('Babu', 'LICUADORA', 'Bazar', 156),
    ('Babu', 'LUCES LED', 'Bazar', 156),
    ('Babu', 'MATE', 'Bazar', 156),
    ('Babu', 'PAVAS ELECTRICA', 'Bazar', 156),
    ('Babu', 'TERMOS', 'Bazar', 156),
    ('Babu', 'TIRA LED', 'Bazar', 156),
    ('Babu', 'VENTILADOR', 'Bazar', 156),
    ('Babu', 'BELLEZA', 'Belleza y Cuidado Personal', 157),
    ('Babu', 'SECADOR', 'Belleza y Cuidado Personal', 157),
    ('Babu', 'LINTERNAS', 'Ferreteria', 160),
    ('Babu', 'CINTA', 'Insumos de Comercios', 162),
    ('Babu', 'CONTADORA DE BILLETES', 'Insumos de Comercios', 162),
    ('Babu', 'PIZARRA MAGICA', 'Jugueteria', 163),
    ('Babu', 'ENCENDEDOR', 'Kiosco', 244),
    ('Babu', 'CALCULADORA', 'Libreria', 164);

-- Crear o corregir las reglas (misma categoría para Neggo y Preventas)
INSERT INTO supplier_category_rules
    (supplier_id, source_category, dest_category_neggo, dest_category_preventas,
     odoo_categ_id_neggo, odoo_categ_id_preventas)
SELECT s.id, m.source_category, m.dest_category, m.dest_category, m.odoo_categ_id, m.odoo_categ_id
FROM tmp_category_map m
JOIN suppliers s ON s.name = m.supplier_name
ON CONFLICT (supplier_id, source_category) DO UPDATE SET
    dest_category_neggo     = EXCLUDED.dest_category_neggo,
    dest_category_preventas = EXCLUDED.dest_category_preventas,
    odoo_categ_id_neggo     = EXCLUDED.odoo_categ_id_neggo,
    odoo_categ_id_preventas = EXCLUDED.odoo_categ_id_preventas;

-- Alif: "Belleza y Cuidado Personal" estaba cargada como Bazar; va a su categoría
UPDATE supplier_category_rules r
SET dest_category_neggo = 'Belleza y Cuidado Personal',
    dest_category_preventas = 'Belleza y Cuidado Personal',
    odoo_categ_id_neggo = 157,
    odoo_categ_id_preventas = 157
FROM suppliers s
WHERE s.id = r.supplier_id AND s.name = 'Alif'
  AND r.source_category = 'Belleza y Cuidado Personal'
  AND r.odoo_categ_id_neggo = 156;

COMMIT;
