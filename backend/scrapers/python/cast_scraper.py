"""
cast_scraper.py — Cast Mayorista
Lee el catálogo desde la Store API pública de WooCommerce (/wp-json/wc/store/v1/products):
JSON sin login ni navegador, con SKU, precios, imagen y stock en una sola respuesta.
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al terminar cada página emite {"type":"page_checkpoint","category":"...","page":N}
Al finalizar cada categoría emite {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres ya completados) y RESUME_CATEGORY/RESUME_PAGE para reanudar.
"""
import sys
import json
import time
import os
import re
import signal
import urllib.request
import urllib.error

# Categorías ya completadas (para reanudar scraping pausado)
SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))
# Checkpoint de página: categoría y página donde se pausó
RESUME_CATEGORY = os.environ.get('RESUME_CATEGORY', '')
RESUME_PAGE     = int(os.environ.get('RESUME_PAGE', '1'))
# Tamaño de página con el que se guardó el checkpoint (vacío = scraper web viejo, otra paginación)
RESUME_PER_PAGE = os.environ.get('RESUME_PER_PAGE', '')

API_URL = 'https://www.castmayorista.com.ar/wp-json/wc/store/v1/products'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
PER_PAGE = 100
MAX_PAGE = 50
TIMEOUT = 120        # la API tarda ~25 s en devolver 100 productos
REINTENTOS = 3
PAUSA_ENTRE_PAGINAS = 1.5

# ─── Categorías ────────────────────────────────────────────────────────────────
# id = term_id de WooCommerce (el filtro incluye subcategorías).
# 'category' se guarda como source_category: no cambiar, lo usan las reglas de categoría.

CATEGORIES = [
    {'id': 245,  'slug': 'vasos-copas',          'category': 'Vasos y Copas'},
    {'id': 180,  'slug': 'vasos-termicos',       'category': 'Vasos Termicos'},
    {'id': 59,   'slug': 'relojeria',            'category': 'Relojeria'},
    {'id': 44,   'slug': 'perfumeria',           'category': 'Perfumeria'},
    {'id': 55,   'slug': 'peluqueria',           'category': 'Peluqueria'},
    {'id': 463,  'slug': 'paragua',              'category': 'Paraguas'},
    {'id': 84,   'slug': 'mochila-y-bolso',      'category': 'Mochilas y Bolsos'},
    {'id': 33,   'slug': 'mascota',              'category': 'Mascotas'},
    {'id': 86,   'slug': 'llavero',              'category': 'Llaveros'},
    {'id': 22,   'slug': 'indumentaria',         'category': 'Indumentaria'},
    {'id': 25,   'slug': 'ferreteria',           'category': 'Ferreteria'},
    {'id': 60,   'slug': 'electronica',          'category': 'Electronica'},
    {'id': 24,   'slug': 'cotillon',             'category': 'Cotillon'},
    {'id': 21,   'slug': 'cosmetico',            'category': 'Cosmeticos'},
    {'id': 398,  'slug': 'botellas-todo',        'category': 'Botellas'},
    {'id': 27,   'slug': 'belleza',              'category': 'Belleza'},
    {'id': 19,   'slug': 'bazar',                'category': 'Bazar'},
    {'id': 20,   'slug': 'jugueteria',           'category': 'Jugueteria'},
    {'id': 26,   'slug': 'libreria',             'category': 'Libreria'},
    {'id': 486,  'slug': 'almohada-de-viaje',    'category': 'Almohadas'},
    {'id': 1122, 'slug': 'accesorios-p-celular', 'category': 'Tecnologia'},
]

# ─── Helpers ──────────────────────────────────────────────────────────────────

def fetch_page(category_id, page):
    """Devuelve (productos, total_paginas) de una página de la categoría. Reintenta ante errores de red/5xx."""
    url = f'{API_URL}?category={category_id}&per_page={PER_PAGE}&page={page}&stock_status=instock'
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                total_pages = int(resp.headers.get('X-WP-TotalPages') or 0)
                return json.loads(resp.read().decode('utf-8')), total_pages
        except urllib.error.HTTPError as e:
            # Página fuera de rango: WooCommerce responde 400 → fin de categoría
            if e.code == 400:
                return [], 0
            ultimo_error = f'HTTP {e.code}'
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(5 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')

def to_price(minor, minor_unit):
    """Precio de la API en unidades menores ('477000', 2) → 4770.0"""
    if minor in (None, ''):
        return None
    try:
        return int(minor) / (10 ** minor_unit)
    except (TypeError, ValueError):
        return None

def make_sku_from_slug(slug):
    return re.sub(r'[^A-Z0-9]', '', (slug or '').upper())

def to_product(item, category_name):
    """Convierte un producto de la Store API al formato que espera upsertProducts."""
    prices = item.get('prices') or {}
    minor_unit = int(prices.get('currency_minor_unit') or 0)
    regular = to_price(prices.get('regular_price'), minor_unit) or to_price(prices.get('price'), minor_unit)
    sale = to_price(prices.get('sale_price'), minor_unit)
    # Igual que en la web: precio tachado = raw_price, precio de oferta = offer_price
    offer = sale if item.get('on_sale') and sale is not None and regular is not None and sale < regular else None

    images = item.get('images') or []
    image_url = (images[0].get('thumbnail') or images[0].get('src')) if images else None

    return {
        'sku': (item.get('sku') or '').strip() or make_sku_from_slug(item.get('slug')),
        'name': (item.get('name') or '').strip(),
        'raw_price': regular,
        'offer_price': offer,
        'image_url': image_url,
        'product_url': item.get('permalink'),
        'source_category': category_name,
        'barcode': None,
        'available': True,
    }

# ─── Scraper principal ────────────────────────────────────────────────────────

def scrape():
    """Recorre todas las categorías. Devuelve la lista de categorías que fallaron."""
    total_categories = len(CATEGORIES)
    fallidas = []

    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando {len(SKIP_CATEGORIES)} categoría(s) ya completadas', file=sys.stderr)

    for cat_idx, category_info in enumerate(CATEGORIES):
        category_name = category_info['category']

        # Saltar categorías ya completadas (modo reanudar)
        if category_name in SKIP_CATEGORIES:
            print(f'⏭️ [{cat_idx+1}/{total_categories}] Saltando: {category_name}', file=sys.stderr)
            continue

        print(f'📦 [{cat_idx+1}/{total_categories}] Categoría: {category_name}', file=sys.stderr)

        # Si es la categoría donde estábamos al pausar, arrancar desde la página siguiente.
        # Un checkpoint con otro tamaño de página no sirve: se repite la categoría desde la 1.
        start_page = 1
        if RESUME_CATEGORY and category_name == RESUME_CATEGORY:
            if RESUME_PER_PAGE == str(PER_PAGE):
                start_page = RESUME_PAGE + 1
            else:
                print(f'  ⚠️ Checkpoint de otra paginación (página {RESUME_PAGE}) — se repite la categoría desde la página 1', file=sys.stderr)
        if start_page > 1:
            print(f'  ⏭️ Reanudando desde página {start_page} (última procesada: {RESUME_PAGE})', file=sys.stderr)

        page = start_page
        cat_count = 0

        try:
            while page <= MAX_PAGE:
                print(f'  → Página {page}', file=sys.stderr)
                items, total_pages = fetch_page(category_info['id'], page)

                if not items:
                    print(f'  🛑 Sin productos — fin de categoría', file=sys.stderr)
                    break

                emitidos = 0
                for item in items:
                    if not item.get('is_in_stock', True) or not item.get('name'):
                        continue
                    product = to_product(item, category_name)
                    # Emitir producto inmediatamente via NDJSON
                    print(json.dumps({'type': 'product', **product}), flush=True)
                    emitidos += 1
                cat_count += emitidos
                print(f'  ✅ {emitidos} productos (página {page}/{total_pages or "?"})', file=sys.stderr)

                # Checkpoint de página: esta página está completamente procesada
                print(json.dumps({'type': 'page_checkpoint', 'category': category_name, 'page': page, 'per_page': PER_PAGE}), flush=True)

                if total_pages and page >= total_pages:
                    break
                page += 1
                time.sleep(PAUSA_ENTRE_PAGINAS)
        except RuntimeError as e:
            # Sin category_done: al reanudar se vuelve a intentar desde el último checkpoint
            print(f'❌ Categoría "{category_name}" incompleta: {e}', file=sys.stderr)
            fallidas.append(category_name)
            continue

        # Señal de categoría completada (para checkpoint)
        print(json.dumps({'type': 'category_done', 'name': category_name, 'count': cat_count}), flush=True)
        print(f'✅ Categoría "{category_name}" completada: {cat_count} productos', file=sys.stderr)

    return fallidas


if __name__ == '__main__':
    def shutdown(signum, frame):
        sys.exit(143)  # 128 + SIGTERM: el backend lo toma como pausa

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        fallidas = scrape()
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)

    # Si alguna categoría quedó a medias, salir con error: el run no queda 'completed'
    # y no se borran productos que esta vez no se pudieron leer.
    if fallidas:
        print(f'❌ Categorías incompletas: {", ".join(fallidas)}', file=sys.stderr)
        sys.exit(1)
