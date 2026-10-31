"""
tiendanube_scraper.py — tiendas Tiendanube (ej. El Rey del Sahumerio)
La grilla del catálogo trae todo en el HTML: cada producto (div.js-item-product) tiene sus variantes
en data-variants (precio, promo, disponible, opciones). Se lee con HTTP simple, sin navegador.
Recorre las categorías del menú (/catalogo/<slug>/, paginadas en /page/N/) y después el
catálogo completo para levantar lo que no cuelga de ninguna.

Código: estas tiendas no suelen cargar SKU, así que se usa el id de producto de Tiendanube
(estable). Si las variantes tienen precios distintos va una fila por variante (<id>V<variante>).

Entrada: TN_CATALOG_URL (ej. https://www.elreydelsahumerio.com.ar/catalogo/)
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
from urllib.parse import urlparse
from bs4 import BeautifulSoup

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
PAUSA = 1            # segundos entre páginas (no saturar la tienda)
MAX_PAGINAS = 200    # tope de seguridad por categoría

SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))
RESTO = 'Otros productos'


def fetch(url):
    """GET con reintentos. Una página fuera de rango devuelve 404 → None."""
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


def categorias(soup, catalog_url):
    """Links del menú a /catalogo/<slug>/ con su nombre, en el orden en que aparecen."""
    path = urlparse(catalog_url).path.rstrip('/')
    patron = re.compile(re.escape(path) + r'/[a-z0-9-]+/?$')
    vistas, salida = set(), []
    for a in soup.find_all('a', href=True):
        href = a['href'].split('?')[0]
        nombre = a.get_text(' ', strip=True)
        if not nombre or not patron.search(urlparse(href).path):
            continue
        url = href if href.endswith('/') else href + '/'
        if url in vistas:
            continue
        vistas.add(url)
        salida.append((nombre, url))
    return salida


def items_de(url_base):
    """Todos los productos de una categoría, recorriendo /page/N/.
    results_only=true devuelve solo la grilla (la mitad de peso). Pasada la última página la tienda
    repite la última en vez de dar 404: se corta cuando una página no trae ningún producto nuevo."""
    items, vistos = [], set()
    for pagina in range(1, MAX_PAGINAS + 1):
        url = f'{url_base}page/{pagina}/?results_only=true'
        html = fetch(url)
        if not html:
            break
        soup = BeautifulSoup(html, 'html.parser')
        nuevos = [i for i in soup.select('div.js-item-product') if i.get('data-product-id') not in vistos]
        if not nuevos:
            break
        vistos.update(i.get('data-product-id') for i in nuevos)
        items.extend(nuevos)
        time.sleep(PAUSA)
    return items


def precio(v):
    """(lista, promo) de una variante. Con promo, price_number es el precio con descuento."""
    if v.get('contact'):
        return None, None   # "Consultar precio"
    actual = v.get('price_number')
    lista = v.get('compare_at_price_number')
    if v.get('has_promotional_price') or (lista and actual and lista > actual):
        return (lista or actual), actual
    return actual, None


def to_products(item, categoria):
    pid = item.get('data-product-id')
    cont = item.select_one('[data-variants]')
    link = item.select_one('a[href*="/productos/"]')
    if not pid or not cont or not link:
        return []
    try:
        variantes = [v for v in json.loads(cont['data-variants']) if v.get('is_visible', True)]
    except (ValueError, TypeError):
        return []
    if not variantes:
        return []

    nombre = (link.get('title') or link.get_text(' ', strip=True) or '').strip()
    url = link.get('href')
    img = item.select_one('img')
    imagen = None
    if img:
        srcset = img.get('data-srcset') or img.get('srcset') or ''
        imagen = img.get('data-src') or (srcset.split(',')[-1].strip().split(' ')[0] if srcset else None) or img.get('src')
        if imagen and imagen.startswith('//'):
            imagen = 'https:' + imagen

    base = {'image_url': imagen, 'product_url': url, 'source_category': categoria, 'barcode': None}
    # Las variantes sin precio publicado (ej. una fragancia "a consultar") no cuentan para separar
    con_precio = [v for v in variantes if precio(v)[0] is not None]
    precios = {precio(v) for v in con_precio}

    # Todas las variantes al mismo precio (ej. fragancias): una sola fila por producto
    if len(precios) <= 1:
        lista, promo = precios.pop() if precios else (None, None)
        return [{**base, 'sku': str(pid), 'name': nombre, 'raw_price': lista, 'offer_price': promo,
                 'available': any(v.get('available') for v in (con_precio or variantes))}]

    salida = []
    for v in variantes:
        lista, promo = precio(v)
        opciones = ' / '.join(str(v.get(k)) for k in ('option0', 'option1', 'option2') if v.get(k))
        salida.append({**base, 'sku': f'{pid}V{v.get("id")}',
                       'name': f'{nombre} - {opciones}' if opciones else nombre,
                       'raw_price': lista, 'offer_price': promo,
                       'image_url': v.get('image_url') or imagen,
                       'available': bool(v.get('available'))})
    return salida


def scrape():
    catalog_url = os.environ.get('TN_CATALOG_URL', '').strip()
    if not catalog_url:
        raise RuntimeError('Falta TN_CATALOG_URL (web del catálogo del proveedor)')
    if not catalog_url.endswith('/'):
        catalog_url += '/'

    html = fetch(catalog_url)
    if not html:
        raise RuntimeError(f'No existe el catálogo {catalog_url}')
    cats = categorias(BeautifulSoup(html, 'html.parser'), catalog_url)
    print(f'📦 Tiendanube — {catalog_url} — {len(cats)} categorías + resto del catálogo', file=sys.stderr)
    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando categorías: {list(SKIP_CATEGORIES)}', file=sys.stderr)

    emitidos = set()   # ids de producto ya emitidos (un producto en varias categorías queda en la primera)
    total = 0

    def procesar(nombre, url, categoria):
        nonlocal total
        items = items_de(url)
        if nombre in SKIP_CATEGORIES:
            print(f'⏭️ Saltando categoría ya completada: {nombre}', file=sys.stderr)
            emitidos.update(i.get('data-product-id') for i in items)
            return
        count = 0
        for item in items:
            pid = item.get('data-product-id')
            if pid in emitidos:
                continue
            emitidos.add(pid)
            try:
                for product in to_products(item, categoria):
                    print(json.dumps({'type': 'product', **product}), flush=True)
                    count += 1
            except Exception as e:
                print(f'    ❌ Error en producto {pid}: {e}', file=sys.stderr)
        total += count
        print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
        print(f'✅ {nombre}: {count} productos ({len(items)} en la categoría)', file=sys.stderr)

    for nombre, url in cats:
        procesar(nombre, url, nombre)
    procesar(RESTO, catalog_url, None)

    print(f'📊 Tiendanube: {total} productos emitidos', file=sys.stderr)
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
