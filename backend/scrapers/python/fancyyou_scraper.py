"""
fancyyou_scraper.py — Fancy You (fancyyou.com.ar)
La tienda lee todo de una API JSON pública: GET /api/shop/<tienda>/catalog trae el catálogo
completo (código, nombre, categoría, precio, stock, foto, precio por caja) en una sola descarga.

Precio: con precio original tachado (orig > price) → raw_price = orig, offer_price = price.
Los productos en dólares (usd) quedan sin precio: la API no trae la cotización.
Disponible: stock > 0 y precio > 0.
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"Catálogo","count":N}
"""
import sys
import signal
import json
import time
import os
import re
import urllib.request
import urllib.parse

SITE_URL = os.environ.get('FY_SITE_URL', 'https://www.fancyyou.com.ar').rstrip('/')
SHOP = os.environ.get('FY_SHOP', 'fancyyou')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 120
REINTENTOS = 3
CATALOGO = 'Catálogo'


def fetch_json(url):
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', str(code).upper().strip()) or None


def absoluta(url):
    if not url:
        return None
    return SITE_URL + url if url.startswith('/') else url


def to_product(p):
    precio = p.get('price') or None
    orig = p.get('orig') or None
    if p.get('usd'):
        raw_price, offer_price = None, None
    elif orig and precio and orig > precio:
        raw_price, offer_price = float(orig), float(precio)
    else:
        raw_price, offer_price = (float(precio) if precio else None), None
    categoria = p.get('category_root') or p.get('category')
    return {
        'sku': normalize_sku(p.get('code')),
        'name': re.sub(r'\s+', ' ', p.get('name') or '').strip(),
        'raw_price': raw_price,
        'offer_price': offer_price,
        'image_url': absoluta(p.get('image_url') or p.get('thumb')),
        'product_url': f'{SITE_URL}/#p={urllib.parse.quote(str(p.get("code")))}' if p.get('code') else None,
        'source_category': categoria.strip().upper() if categoria else None,
        'barcode': None,
        'available': bool((p.get('stock') or 0) > 0 and precio),
    }


def scrape():
    datos = fetch_json(f'{SITE_URL}/api/shop/{SHOP}/catalog')
    productos = datos.get('products') or []
    print(f'📦 Fancy You — {len(productos)} productos en el catálogo', file=sys.stderr)
    if not productos:
        raise RuntimeError('El catálogo vino vacío: ¿cambió la web?')

    count = usd = 0
    usados = {}   # sku limpio → veces visto ("XQ-121-2" y "XQ1212" quedan iguales sin guiones)
    for p in productos:
        product = to_product(p)
        if not product['sku'] or not product['name']:
            continue
        veces = usados.get(product['sku'], 0)
        usados[product['sku']] = veces + 1
        if veces:
            product['sku'] = f"{product['sku']}D{veces + 1}"
        if p.get('usd'):
            usd += 1
        print(json.dumps({'type': 'product', **product}), flush=True)
        count += 1

    print(json.dumps({'type': 'category_done', 'name': CATALOGO, 'count': count}), flush=True)
    if usd:
        print(f'⚠️ {usd} productos en dólares quedaron sin precio', file=sys.stderr)
    print(f'📊 Fancy You: {count} productos emitidos', file=sys.stderr)


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
