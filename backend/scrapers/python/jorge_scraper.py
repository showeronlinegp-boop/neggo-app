"""
jorge_scraper.py — Importadora Jorge (importadorajorge.com.ar, tienda Kirke)
La web pinta los precios con un JS que trae TODO el catálogo de una vez:
  /js_lista_precios.html → pr[<id>] = [precio, precio_anterior, % descuento, stock]
Nombre, SKU, foto y categoría salen del listado de cada categoría (/productos/n/<slug>-<id>.html,
12 por página, ?p=N). Lo que figura en la lista de precios y no aparece en ninguna categoría se
completa desde su ficha.

Precio: con promo (precio_anterior > 0) → raw_price = anterior, offer_price = precio.
Disponible: stock > 0 y precio > 0 (es lo que la web muestra comprable).
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
from bs4 import BeautifulSoup

BASE_URL = 'https://importadorajorge.com.ar'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
PAUSA = 0.5
MAX_PAGINAS = 300

# Categorías principales del menú (slug-id, nombre). Ofertas va última: sus productos
# también están en su categoría real y quedan con esa.
CATEGORIAS = [
    ('bazar-369', 'Bazar'),
    ('cosmetica-370', 'Cosmética'),
    ('deco-hogar-regaleria-371', 'Deco Hogar Regalería'),
    ('electronica-372', 'Electrónica'),
    ('fitness-373', 'Fitness'),
    ('jugueteria-374', 'Juguetería'),
    ('kiosco-375', 'Kiosco'),
    ('libreria-376', 'Librería'),
    ('winco-379', 'Winco'),
    ('varios-380', 'Varios'),
    ('bervit-381', 'Bervit'),
    ('ofertas-377', 'Ofertas'),
]
RESTO = 'Otros productos'

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


def lista_precios():
    """{id: (precio, anterior, descuento, stock)} desde el JS de precios."""
    js = fetch(f'{BASE_URL}/js_lista_precios.html') or ''
    precios = {}
    for pid, campos in re.findall(r"pr\[(\d+)\]=\[([^\]]*)\]", js):
        valores = [c.strip().strip("'\"") for c in campos.split(',')]
        try:
            precios[pid] = tuple(float(v or 0) for v in (valores + ['0'] * 4)[:4])
        except ValueError:
            continue
    return precios


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip()) or None


def leer_tarjetas(html):
    """Productos de una página de listado: id, nombre, sku, url, imagen."""
    soup = BeautifulSoup(html, 'html.parser')
    salida = []
    for prod in soup.select('div.kk_producto'):
        pid = prod.get('id')
        if not pid:
            continue
        sku_tag = prod.select_one('span.sku')
        link = prod.select_one('a[href*="/producto/"]')
        img = prod.select_one('.caja-producto-image img[alt]') or prod.select_one('img[alt]')
        nombre = prod.select_one('.caja-producto-nombre')
        src = img.get('src') if img else None
        salida.append({
            'pid': pid,
            'name': (nombre.get_text(' ', strip=True) if nombre else prod.get('kk_titulo') or '').strip(),
            'sku': normalize_sku(re.sub(r'^\s*SKU\s*', '', sku_tag.get_text(strip=True), flags=re.I)) if sku_tag else None,
            'url': link.get('href') if link else None,
            'image_url': (BASE_URL + src) if src and src.startswith('/') else src,
        })
    return salida


def tarjetas_de(slug):
    """Todas las tarjetas de una categoría recorriendo ?p=N hasta una página sin productos nuevos."""
    todas, vistos = [], set()
    for pagina in range(1, MAX_PAGINAS + 1):
        html = fetch(f'{BASE_URL}/productos/n/{slug}.html?p={pagina}')
        nuevas = [t for t in leer_tarjetas(html or '') if t['pid'] not in vistos]
        if not nuevas:
            break
        vistos.update(t['pid'] for t in nuevas)
        todas.extend(nuevas)
        time.sleep(PAUSA)
    return todas


def ficha(pid):
    """Datos de un producto que no apareció en ninguna categoría (desde su ficha)."""
    html = fetch(f'{BASE_URL}/producto/p-{pid}.html')
    if not html:
        return None
    soup = BeautifulSoup(html, 'html.parser')
    titulo = soup.select_one('h1') or soup.select_one('title')
    sku_tag = soup.find(string=re.compile(r'SKU\s*\S+', re.I))
    img = soup.select_one('meta[property="og:image"]')
    return {
        'pid': pid,
        'name': titulo.get_text(' ', strip=True) if titulo else '',
        'sku': normalize_sku(re.search(r'SKU\s*(\S+)', sku_tag, re.I).group(1)) if sku_tag else None,
        'url': f'{BASE_URL}/producto/p-{pid}.html',
        'image_url': img.get('content') if img else None,
    }


def to_product(t, precio_info, categoria, usados):
    precio, anterior, _, stock = precio_info or (0, 0, 0, 0)
    if anterior and precio and anterior > precio:
        raw_price, offer_price = anterior, precio
    else:
        raw_price, offer_price = (precio or None), None
    sku = t['sku'] or f'W{t["pid"]}'
    if sku in usados:
        sku = f'{sku}W{t["pid"]}'
    usados.add(sku)
    return {
        'sku': sku,
        'name': t['name'],
        'raw_price': raw_price,
        'offer_price': offer_price,
        'image_url': t['image_url'],
        'product_url': t['url'],
        'source_category': categoria,
        'barcode': None,
        # La web solo deja comprar con stock y precio
        'available': bool(stock and stock > 0 and precio and precio > 0),
    }


def scrape():
    precios = lista_precios()
    print(f'📦 Importadora Jorge — {len(precios)} productos en la lista de precios, {len(CATEGORIAS)} categorías', file=sys.stderr)
    if not precios:
        raise RuntimeError('La lista de precios vino vacía: ¿cambió la web?')
    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando categorías: {list(SKIP_CATEGORIES)}', file=sys.stderr)

    vistos, usados = set(), set()
    total = 0

    def emitir(nombre, tarjetas, categoria):
        nonlocal total
        count = 0
        for t in tarjetas:
            if t['pid'] in vistos or not t['name']:
                continue
            vistos.add(t['pid'])
            print(json.dumps({'type': 'product', **to_product(t, precios.get(t['pid']), categoria, usados)}), flush=True)
            count += 1
        total += count
        print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
        print(f'✅ {nombre}: {count} productos ({len(tarjetas)} en la categoría)', file=sys.stderr)

    for slug, nombre in CATEGORIAS:
        tarjetas = tarjetas_de(slug)
        if nombre in SKIP_CATEGORIES:
            print(f'⏭️ Saltando categoría ya completada: {nombre}', file=sys.stderr)
            vistos.update(t['pid'] for t in tarjetas)
            continue
        emitir(nombre, tarjetas, nombre)

    if RESTO not in SKIP_CATEGORIES:
        faltan = [pid for pid in precios if pid not in vistos]
        print(f'📦 {len(faltan)} productos de la lista de precios sin categoría: se leen sus fichas', file=sys.stderr)
        sueltos = []
        for pid in faltan:
            t = ficha(pid)
            if t:
                sueltos.append(t)
            time.sleep(PAUSA)
        emitir(RESTO, sueltos, None)

    print(f'📊 Importadora Jorge: {total} productos emitidos', file=sys.stderr)


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
