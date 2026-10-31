"""
elrey_scraper.py — El Rey (catálogo Smarty con token)
El catálogo acepta ?limit=N: cada categoría principal entra entera en una sola página HTML,
así que se lee con HTTP simple (sin navegador). Después se recorre el catálogo completo
para levantar los productos que no cuelgan de ninguna categoría principal.
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar cada categoría emite {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres para reanudar).
"""
import sys
import signal
import json
import time
import os
import re
import urllib.request
from bs4 import BeautifulSoup

BASE_URL = 'https://catalog.smarty.com.ar'
DEFAULT_TOKEN = '574abb0c8c154b8d46e3cd9e8d99c5b8ab5f00ad'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
LIMITE = 5000        # productos por página (el catálogo completo tiene < 1.000)
TIMEOUT = 120
REINTENTOS = 3

# Categorías principales del menú (id de Smarty). El orden importa: un producto que está en
# varias queda en la primera.
CATEGORIAS = [7335, 7308, 7367, 7325, 7344, 7358, 7349, 23723, 27346]

# El catálogo titula las principales en mayúsculas; las reglas de categoría de El Rey
# (supplier_category_rules) se cargaron con estos nombres.
NOMBRE_REGLA = {
    'PERFUMERÍA': 'Perfumería',
    'HOGAR Y BAZAR': 'Hogar y Bazar',
    'ARTÍCULOS KIOSCO': 'Artículos Kiosco',
    'INSECTICIDAS': 'Insecticidas',
}

# Categorías ya completadas (para reanudar)
SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))
RESTO = 'Otros productos'


def normalize_sku(code):
    """Devuelve el código en mayúsculas solo con caracteres alfanuméricos."""
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip())


def clean_price(price_str):
    """Limpia precio: '$1.234,56' → 1234.56 (formato argentino)."""
    if not price_str:
        return None
    cleaned = price_str.replace('$', '').replace('\xa0', '').strip()
    cleaned = cleaned.replace('.', '').replace(',', '.')
    try:
        return float(cleaned)
    except ValueError:
        return None


def nombre_categoria(texto):
    nombre = (texto or '').strip()
    if nombre.startswith('en '):
        nombre = nombre[3:].strip()
    return NOMBRE_REGLA.get(nombre, nombre) or None


def fetch(url):
    """GET con reintentos ante errores de red."""
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read().decode('utf-8', 'replace')
        except Exception as e:
            ultimo_error = str(e)
            print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
            time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')


def leer_items(url):
    """Devuelve (título de la página, items) recorriendo la paginación si la hubiera."""
    titulo, items = None, []
    while url:
        soup = BeautifulSoup(fetch(url), 'html.parser')
        if titulo is None:
            h2 = soup.select_one('h2.d-inline.fw-bold')
            titulo = h2.get_text(' ', strip=True) if h2 else ''
        items.extend(soup.select('div.itemWrapper'))
        siguiente = soup.select_one('a[rel="next"]')
        href = siguiente.get('href') if siguiente else None
        url = (href if href.startswith('http') else f'{BASE_URL}{href}') if href and href != url else None
    return titulo, items


def to_product(item, token, categoria):
    name_tag = item.select_one('h5.item-name')
    name = name_tag.get_text(' ', strip=True) if name_tag else None
    ref_tag = item.select_one('span.reference')
    sku = normalize_sku(ref_tag.get_text(strip=True)) if ref_tag else None
    if not name or not sku:
        return None

    # En promo la web muestra el precio con descuento y, tachado, el de lista:
    # raw_price = lista, offer_price = promo (así el costo no salta cuando termina la promo)
    promo_tag = item.select_one('span.discountPrice')
    lista_tag = item.select_one('span.origDiscountPrice') if promo_tag else item.select_one('span.origPrice')
    raw_price = clean_price(lista_tag.get_text(strip=True)) if lista_tag else None
    offer_price = clean_price(promo_tag.get_text(strip=True)) if promo_tag else None
    if raw_price is None:
        precio = item.select_one('div.item-price')
        raw_price = clean_price(precio.get('data-view-item-price', '').replace('.', ',')) if precio else None

    image_url = None
    galeria = item.select_one('a.lnkGallery')
    img_tag = item.select_one('img.item-image-primary')
    src = (galeria.get('data-src') if galeria else None) or (img_tag.get('data-src') or img_tag.get('src', '') if img_tag else '')
    if src:
        image_url = f'{BASE_URL}{src}' if src.startswith('/') else src

    item_id = item.select_one('input.id')
    product_url = f'{BASE_URL}/token/{token}/{item_id.get("value")}' if item_id and item_id.get('value') else None

    return {
        'sku':             sku,
        'name':            name,
        'raw_price':       raw_price,
        'offer_price':     offer_price,
        'image_url':       image_url,
        'product_url':     product_url,
        'source_category': categoria,
        'barcode':         None,
        # Lo que está publicado en el catálogo se puede pedir; lo que sale se da de baja en la limpieza
        'available':       True,
    }


def scrape():
    token = os.environ.get('ELREY_TOKEN', DEFAULT_TOKEN)
    print(f'📦 El Rey — token: {token[:12]}... — {len(CATEGORIAS)} categorías + resto del catálogo', file=sys.stderr)
    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando categorías: {list(SKIP_CATEGORIES)}', file=sys.stderr)

    emitidos = set()
    total = 0

    def emitir(items, categoria_fija):
        count = 0
        for item in items:
            try:
                categoria = categoria_fija
                if categoria is None:
                    # Resto: primera categoría que muestra el producto
                    cats = item.select_one('span.item-categories')
                    categoria = nombre_categoria(cats.get_text(strip=True).split(',')[0]) if cats else None
                product = to_product(item, token, categoria)
                if not product or product['sku'] in emitidos:
                    continue
                emitidos.add(product['sku'])
                print(json.dumps({'type': 'product', **product}), flush=True)
                count += 1
            except Exception as e:
                print(f'    ❌ Error en item: {e}', file=sys.stderr)
        return count

    for cat_id in CATEGORIAS:
        titulo, items = leer_items(f'{BASE_URL}/token/{token}/?category_id={cat_id}&limit={LIMITE}')
        categoria = nombre_categoria(titulo) or f'Categoría {cat_id}'
        # Aunque se saltee, sus SKU cuentan como vistos para que no caigan en el resto
        if categoria in SKIP_CATEGORIES:
            print(f'⏭️ Saltando categoría ya completada: {categoria}', file=sys.stderr)
            for item in items:
                ref = item.select_one('span.reference')
                if ref:
                    emitidos.add(normalize_sku(ref.get_text(strip=True)))
            continue
        count = emitir(items, categoria)
        total += count
        print(json.dumps({'type': 'category_done', 'name': categoria, 'count': count}), flush=True)
        print(f'✅ {categoria}: {count} productos ({len(items)} en la página)', file=sys.stderr)
        time.sleep(1)

    if RESTO not in SKIP_CATEGORIES:
        _, items = leer_items(f'{BASE_URL}/token/{token}/?limit={LIMITE}')
        count = emitir(items, None)
        total += count
        print(json.dumps({'type': 'category_done', 'name': RESTO, 'count': count}), flush=True)
        print(f'✅ {RESTO}: {count} productos (catálogo completo: {len(items)})', file=sys.stderr)

    print(f'📊 El Rey: {total} productos emitidos', file=sys.stderr)


if __name__ == '__main__':
    def shutdown(signum, frame):
        sys.exit(143)  # 128 + SIGTERM: el backend lo toma como pausa

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        scrape()
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)
