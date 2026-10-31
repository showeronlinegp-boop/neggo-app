"""
ventasxmayor_scraper.py — tiendas VentasXMayor (ej. Importadora Al Costo)
La lista de productos sale del sitemap (/sitemap.xml → /producto/<slug>-<id>) y cada ficha trae
sus datos en JSON-LD (ProductGroup con variantes: precio, disponibilidad, fotos) más la
categoría (BreadcrumbList) y la referencia del proveedor ("Ref. CEL6964"). HTTP simple, en paralelo.

Precio: el de la ficha es el del primer escalón (por unidad, sin descuento por cantidad).
Código: la referencia del proveedor; si no tiene, el id del producto en la tienda.
Entrada: VXM_SITE_URL (ej. https://importadoraalcosto.com.ar)
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de tandas ya completadas) para reanudar.
"""
import sys
import signal
import json
import time
import os
import re
import gzip
import html as htmllib
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
HILOS = 4
LOTE = 100           # fichas por tanda (checkpoint)

SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))


def fetch(url):
    """GET con reintentos. 404 → None.
    El servidor manda gzip aunque no se pida: se descomprime si llega comprimido."""
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip'})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                cuerpo = resp.read()
                if cuerpo[:2] == b'\x1f\x8b':
                    cuerpo = gzip.decompress(cuerpo)
                return cuerpo.decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            ultimo_error = f'HTTP {e.code}'
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip()) or None


def json_ld(html):
    """Bloques JSON-LD de la página (aplanando listas)."""
    salida = []
    for bloque in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(bloque)
        except ValueError:
            continue
        salida.extend(data if isinstance(data, list) else [data])
    return salida


def leer_ficha(url):
    """Filas de un producto (una, o una por variante si las variantes cambian de precio)."""
    html = fetch(url)
    if not html:
        return []
    bloques = json_ld(html)
    grupo = next((b for b in bloques if b.get('@type') in ('ProductGroup', 'Product')), None)
    if not grupo:
        return []
    migas = next((b for b in bloques if b.get('@type') == 'BreadcrumbList'), {})
    items = migas.get('itemListElement') or []
    categoria = items[1].get('name') if len(items) > 2 else None

    # "Ref. CEL6964" (el template de la página también trae "Ref. %1": se descarta)
    ref = next((r for r in re.findall(r'Ref\.\s*([A-Za-z0-9][A-Za-z0-9./-]*)', html) if r != '%1'), None)
    pid = grupo.get('productGroupID') or (re.search(r'-(\d+)/?$', url) or [None, None])[1]
    imagenes = grupo.get('image') or []
    imagen = imagenes[0] if isinstance(imagenes, list) and imagenes else (imagenes or None)
    nombre = htmllib.unescape(grupo.get('name') or '').strip()

    variantes = grupo.get('hasVariant') or [grupo]
    def oferta(v):
        o = v.get('offers') or {}
        o = o[0] if isinstance(o, list) and o else o
        precio = o.get('price')
        return (float(precio) if precio not in (None, '') else None), 'InStock' in str(o.get('availability', ''))

    base = {'image_url': imagen, 'product_url': url, 'source_category': categoria, 'barcode': None, 'offer_price': None}
    codigo = normalize_sku(ref) or f'W{pid}'
    datos = [oferta(v) for v in variantes]
    precios = {p for p, _ in datos if p is not None}
    if len(precios) <= 1:
        return [{**base, 'sku': codigo, 'name': nombre, 'raw_price': precios.pop() if precios else None,
                 'available': any(disp for _, disp in datos)}]
    return [{**base, 'sku': f'{codigo}V{i + 1}', 'name': htmllib.unescape(v.get('name') or nombre).strip(),
             'raw_price': p, 'available': disp}
            for i, (v, (p, disp)) in enumerate(zip(variantes, datos))]


def scrape():
    site = os.environ.get('VXM_SITE_URL', '').strip().rstrip('/')
    if not site:
        raise RuntimeError('Falta VXM_SITE_URL (web de la tienda)')
    sitemap = fetch(f'{site}/sitemap.xml') or ''
    urls = sorted(set(re.findall(r'<loc>([^<]*/producto/[^<]+)</loc>', sitemap)))
    print(f'📦 VentasXMayor — {site} — {len(urls)} productos en el sitemap', file=sys.stderr)
    if not urls:
        raise RuntimeError('El sitemap no trae productos: ¿cambió la web?')

    total, usados = 0, set()
    with ThreadPoolExecutor(max_workers=HILOS) as pool:
        for inicio in range(0, len(urls), LOTE):
            lote = urls[inicio:inicio + LOTE]
            nombre = f'Productos {inicio + 1}-{inicio + len(lote)}'
            if nombre in SKIP_CATEGORIES:
                print(f'⏭️ Saltando: {nombre}', file=sys.stderr)
                continue
            count = 0
            for filas in pool.map(leer_ficha, lote):
                for product in filas:
                    # Dos productos con la misma referencia: el segundo lleva sufijo
                    sku = product['sku']
                    n = 2
                    while sku in usados:
                        sku = f"{product['sku']}D{n}"
                        n += 1
                    usados.add(sku)
                    product['sku'] = sku
                    print(json.dumps({'type': 'product', **product}), flush=True)
                    count += 1
            total += count
            print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
            print(f'✅ {nombre}: {count} productos', file=sys.stderr)

    print(f'📊 VentasXMayor: {total} productos emitidos', file=sys.stderr)


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
