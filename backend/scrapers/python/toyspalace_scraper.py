"""
toyspalace_scraper.py — Toys Palace (toyspalace.com.ar, WooCommerce)
La tienda acepta ?product_count=N: el catálogo completo entra en una sola página HTML.
Cada tarjeta trae el artículo ("ART: 1958"), nombre, precios, stock (clase instock) y categoría
(clase product_cat-<slug>).

Precio: casi todo figura "en oferta" con un precio tachado que no es el real; el costo sale del
precio final (el de <ins>, o el único si no hay oferta). raw_price = precio final.
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"Catálogo","count":N}
"""
import sys
import signal
import json
import time
import os
import re
import html as htmllib
import urllib.request

SITE_URL = os.environ.get('TP_SITE_URL', 'https://www.toyspalace.com.ar').rstrip('/')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 180
REINTENTOS = 3
MAX_PRODUCTOS = 10000
CATALOGO = 'Catálogo'


def fetch(url):
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


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip()) or None


def clean_price(texto):
    """'30.499' → 30499.0 (formato argentino)."""
    limpio = (texto or '').strip().replace('.', '').replace(',', '.')
    try:
        return float(limpio) if limpio else None
    except ValueError:
        return None


def to_product(bloque, clases, post_id):
    nombre = re.search(r'woocommerce-loop-product__title">([^<]*)<', bloque)
    art = re.search(r'class="skust">\s*ART:\s*([^<]*)<', bloque)
    url = re.search(r"href='(https?://[^']*/producto/[^']*)'", bloque)
    imagen = re.search(r'background-image:url\(([^)]+)\)', bloque)
    final = re.search(r'<ins>.*?</span>([\d.,]+)</span>', bloque, re.S) or \
        re.search(r'class="price">.*?</span>([\d.,]+)</span>', bloque, re.S)
    cat = re.search(r'product_cat-([a-z0-9-]+)', clases)
    if not nombre:
        return None
    return {
        'sku': normalize_sku(art.group(1)) if art else None,
        'name': htmllib.unescape(nombre.group(1)).strip(),
        'raw_price': clean_price(final.group(1)) if final else None,
        'offer_price': None,
        'image_url': imagen.group(1).strip('\'"') if imagen else None,
        'product_url': url.group(1) if url else None,
        'source_category': cat.group(1).replace('-', ' ').upper() if cat else None,
        'barcode': None,
        'available': ' instock' in f' {clases} ',
        '_post_id': post_id,
    }


def scrape():
    html = fetch(f'{SITE_URL}/tienda/?product_count={MAX_PRODUCTOS}')
    # Cada producto es un <li class="post-<id> product type-product ...">
    partes = re.split(r'<li class="(post-(\d+) product type-product[^"]*)"', html)
    productos = []
    for i in range(1, len(partes) - 2, 3):
        p = to_product(partes[i + 2], partes[i], partes[i + 1])
        if p:
            productos.append(p)
    print(f'📦 Toys Palace — {len(productos)} productos en la tienda', file=sys.stderr)
    if not productos:
        raise RuntimeError('No se encontró ningún producto: ¿cambió la web?')

    usados, count = set(), 0
    for p in productos:
        post_id = p.pop('_post_id')
        sku = p['sku'] or f'W{post_id}'
        if sku in usados:
            sku = f'{sku}W{post_id}'
        usados.add(sku)
        p['sku'] = sku
        print(json.dumps({'type': 'product', **p}), flush=True)
        count += 1

    print(json.dumps({'type': 'category_done', 'name': CATALOGO, 'count': count}), flush=True)
    print(f'📊 Toys Palace: {count} productos emitidos', file=sys.stderr)


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
