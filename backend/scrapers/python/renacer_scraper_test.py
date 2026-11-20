"""
Test del parser de renacer_scraper.py, sin red: arma una home de Kit Digital a mano.
python3 backend/scrapers/python/renacer_scraper_test.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import renacer_scraper as rn  # noqa: E402

CAT = '1340b53b-7f1e-4f66-b8c8-2d0035afa532'
SEC = '5eda5436-7724-44fe-b657-fb45d3ef1cba'


def producto(pid, code, name, price, nota=None):
    return {
        'id': pid, 'name': name, 'slug': name.lower().replace(' ', '-'), 'price': price,
        'compare_price': None, 'image_url': 'https://res.cloudinary.com/x/p.jpg', 'stock': None,
        'metadata': {'min_qty': 12, 'pack_size': 360, **({'short_note': nota} if nota else {})},
        'section_id': SEC, 'category_ids': [CAT], 'code': code, 'variant_codes': '$undefined',
        'barcode': None,
    }


def home(objetos):
    """Parte el payload en dos push, como hace Next.js, para probar que se unen bien."""
    texto = '0:' + json.dumps(objetos, ensure_ascii=False, separators=(',', ':')) + '\n'
    mitad = len(texto) // 2
    pushes = ''.join(
        f'<script>self.__next_f.push([1,{json.dumps(p)}])</script>' for p in (texto[:mitad], texto[mitad:])
    )
    return f'<html><body>{pushes}</body></html>'


class ParserRenacer(unittest.TestCase):
    def setUp(self):
        objetos = [
            {'id': CAT, 'store_id': 's', 'name': 'Generales', 'description': ''},
            {'id': SEC, 'store_id': 's', 'title': 'Belleza', 'slug': 'belleza', 'layout': 'carousel'},
            producto('00000000-0000-0000-0000-000000000001', 'IGB-158', 'Peine fino metal', 62457, '7x20 cm'),
            producto('00000000-0000-0000-0000-000000000002', 'NLCTD0002#', 'Cuaderno Maratón', 254400),
            producto('00000000-0000-0000-0000-000000000003', 'IL0953', 'Carpeta A4 PP (32x4,5 cm)', None, '32x4,5 cm'),
        ]
        flight = rn.leer_flight(home(objetos))
        self.productos, self.categorias, self.secciones = rn.leer_objetos(flight)
        self.por_sku = {
            p['sku']: p for p in (rn.to_product(o, self.categorias, self.secciones) for o in self.productos.values())
        }

    def test_lee_productos_categorias_y_secciones(self):
        self.assertEqual(len(self.productos), 3)
        self.assertEqual(self.categorias, {CAT: 'Generales'})
        self.assertEqual(self.secciones, {SEC: 'Belleza'})

    def test_precio_en_centavos_y_medida_en_el_nombre(self):
        p = self.por_sku['IGB158']
        self.assertEqual(p['raw_price'], 624.57)
        self.assertEqual(p['name'], 'Peine fino metal (7x20 cm)')
        self.assertEqual(p['source_category'], 'Generales / Belleza')
        self.assertTrue(p['available'])
        self.assertTrue(p['product_url'].startswith(rn.SITE_URL + '/p/'))

    def test_numeral_no_choca_con_el_codigo_base(self):
        self.assertIn('NLCTD0002X', self.por_sku)

    def test_sin_precio_queda_no_disponible_y_no_repite_medida(self):
        p = self.por_sku['IL0953']
        self.assertIsNone(p['raw_price'])
        self.assertFalse(p['available'])
        self.assertEqual(p['name'], 'Carpeta A4 PP (32x4,5 cm)')


if __name__ == '__main__':
    unittest.main()
