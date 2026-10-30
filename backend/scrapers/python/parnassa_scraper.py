"""
parnassa_scraper.py — Parnassa Importadora (parnassa.com.ar, tienda "comercio4")
Cada categoría (/<slug>-por-mayor) trae todos sus productos en una sola página, con los precios
por cantidad ("Desde 5 / 15 / 60 Unidades" y a veces una MEGAOFERTA). El código del producto
solo está en la ficha ("Código: 83219"), así que se abre cada ficha (HTTP simple, en paralelo).

Precio: el costo de Neggo sale del SEGUNDO escalón con 10 % de descuento. raw_price = segundo
escalón (o el único si hay uno solo); el 10 % va como descuento del proveedor en la app.
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres para reanudar).
"""
import sys
import signal
import json
import time
import os
import re
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup

BASE_URL = 'https://www.parnassa.com.ar'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
HILOS = 4            # fichas en paralelo
PAUSA = 1

# Categorías del menú (slug, nombre). Un producto que está en varias queda en la primera.
CATEGORIAS = [
    ('juguetes-por-mayor', 'Juguetes'),
    ('articulos-fitness-por-mayor', 'Fitness'),
    ('articulos-jardineria-por-mayor', 'Jardinería'),
    ('herramientas-por-mayor', 'Herramientas'),
    ('ofertas-slime-por-mayor', 'Ofertas Slime'),
    ('mega-ofertas-articulos-fitness-por-mayor', 'Mega Ofertas Fitness'),
]

SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))


def fetch(url):
    """GET con reintentos ante errores de red. 404 → None."""
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            ultimo_error = f'HTTP {e.code}'
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')


def clean_price(texto):
    """'$7.637' → 7637.0 (formato argentino)."""
    limpio = (texto or '').replace('$', '').replace('\xa0', '').strip().replace('.', '').replace(',', '.')
    try:
        return float(limpio) if limpio else None
    except ValueError:
        return None


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip()) or None


def codigo_de_ficha(url):
    """'Código:83219' de la ficha del producto (None si no lo tiene)."""
    html = fetch(url)
    if not html:
        return None
    m = re.search(r'C(?:ó|&oacute;|o)digo:\s*([^<\s][^<]*)', html)
    return m.group(1).strip() if m else None


def leer_item(item):
    """Datos del listado: id, nombre, url, imagen y precios por cantidad (sin la MEGAOFERTA)."""
    pid = item.select_one('input[name="product_id"]')
    link = item.select_one('h6.product_name a') or item.select_one('a.imagethumblink')
    if not pid or not link:
        return None
    escalones = []
    for row in item.select('div.product__listprices__row'):
        if 'product__listprices__megaoferta' in (row.get('class') or []):
            continue
        p = row.select_one('.product__listprices__precio')
        precio = clean_price(p.get_text(strip=True)) if p else None
        if precio:
            escalones.append(precio)
    img = item.select_one('img.imagethumb')
    return {
        'pid': pid.get('value'),
        'name': link.get_text(' ', strip=True),
        'url': link.get('href'),
        'image_url': img.get('src') if img else None,
        # Segundo escalón (el del costo); si hay uno solo, ese
        'raw_price': escalones[1] if len(escalones) > 1 else (escalones[0] if escalones else None),
    }


def scrape():
    print(f'📦 Parnassa — {len(CATEGORIAS)} categorías', file=sys.stderr)
    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando categorías: {list(SKIP_CATEGORIES)}', file=sys.stderr)

    vistos = set()       # ids de producto ya procesados
    usados = set()       # SKU emitidos (si dos productos comparten código, el segundo lleva el id)
    total = 0

    with ThreadPoolExecutor(max_workers=HILOS) as pool:
        for slug, nombre in CATEGORIAS:
            html = fetch(f'{BASE_URL}/{slug}')
            items = BeautifulSoup(html, 'html.parser').select('div.product-item') if html else []
            datos = [d for d in (leer_item(i) for i in items) if d and d['pid'] not in vistos]
            if nombre in SKIP_CATEGORIES:
                print(f'⏭️ Saltando categoría ya completada: {nombre}', file=sys.stderr)
                vistos.update(d['pid'] for d in datos)
                continue
            vistos.update(d['pid'] for d in datos)

            codigos = list(pool.map(lambda d: codigo_de_ficha(d['url']), datos))
            count = 0
            for d, codigo in zip(datos, codigos):
                sku = normalize_sku(codigo) or f'W{d["pid"]}'
                if sku in usados:
                    sku = f'{sku}W{d["pid"]}'
                usados.add(sku)
                product = {
                    'sku': sku,
                    'name': d['name'],
                    'raw_price': d['raw_price'],
                    'offer_price': None,
                    'image_url': d['image_url'],
                    'product_url': d['url'],
                    'source_category': nombre,
                    'barcode': None,
                    # La tienda no marca agotados: lo publicado se puede pedir
                    'available': True,
                }
                print(json.dumps({'type': 'product', **product}), flush=True)
                count += 1
            total += count
            print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
            print(f'✅ {nombre}: {count} productos ({len(items)} en la categoría)', file=sys.stderr)
            time.sleep(PAUSA)

    print(f'📊 Parnassa: {total} productos emitidos', file=sys.stderr)
    if total == 0:
        raise RuntimeError('No se encontró ningún producto: ¿cambió la web?')


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
