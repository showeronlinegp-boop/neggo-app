"""
odooshop_scraper.py — tiendas hechas con el e-commerce de Odoo (ej. Nueva Roma)
Recorre las categorías del menú (/shop/category/<cat>, paginadas en /page/N) y después /shop
entero para lo que no cuelga de ninguna. Cada tarjeta (form.oe_product_cart) trae nombre,
precio, foto, el id de plantilla y las unidades por bulto ("Cod. - × 144").

Código: estas tiendas no muestran código del proveedor. Si el nombre arranca con un código
("513387 SLIME CAPY") se usa ese; si no, el id de plantilla (T<id>, estable).
Las unidades por bulto se agregan al nombre cuando vienen (" (x144)").
Entrada: ODOO_SHOP_URL (ej. https://nuevaroma.online)
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres para reanudar).
"""
import sys
import signal
import json
import time
import os
import re
import html as htmllib
import urllib.request
import urllib.error

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
PAUSA = 0.5
MAX_PAGINAS = 300
RESTO = 'Otros productos'

SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))


def fetch(url):
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
    """'3.500,00' → 3500.0 (formato argentino)."""
    limpio = (texto or '').strip().replace('.', '').replace(',', '.')
    try:
        return float(limpio) if limpio else None
    except ValueError:
        return None


def texto(s):
    return re.sub(r'\s+', ' ', htmllib.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


def tarjetas(html, site):
    """Productos de una página: [(template_id, datos)]."""
    salida = []
    for bloque in re.split(r'<form role="article" class="oe_product_cart', html)[1:]:
        link = re.search(r'href="(/shop/[^"#?]*-(\d+))"', bloque)
        if not link:
            continue
        nombre = re.search(r'o_wsale_products_item_title[^>]*>(.*?)</h\d>', bloque, re.S)
        precio = re.search(r'oe_currency_value">([^<]*)<', bloque)
        pack = re.search(r'<span class="mx-1">×</span>\s*<span>\s*(\d+)\s*</span>', bloque)
        img = re.search(r'<img src="([^"]+)"', bloque)
        nom = texto(nombre.group(1)) if nombre else ''
        if pack and int(pack.group(1)) > 1:
            nom = f'{nom} (x{pack.group(1)})'
        salida.append((link.group(2), {
            'name': nom,
            'raw_price': clean_price(precio.group(1)) if precio else None,
            'image_url': site + img.group(1) if img and img.group(1).startswith('/') else (img.group(1) if img else None),
            'product_url': site + link.group(1),
        }))
    return salida


def recorrer(base, site):
    """Todas las tarjetas de /shop o de una categoría, hasta una página sin productos nuevos."""
    todas, vistos = [], set()
    for pagina in range(1, MAX_PAGINAS + 1):
        url = base if pagina == 1 else f'{base}/page/{pagina}'
        html = fetch(site + url)
        nuevas = [(tid, d) for tid, d in tarjetas(html or '', site) if tid not in vistos]
        if not nuevas:
            break
        vistos.update(tid for tid, _ in nuevas)
        todas.extend(nuevas)
        time.sleep(PAUSA)
    return todas


def scrape():
    site = os.environ.get('ODOO_SHOP_URL', '').strip().rstrip('/')
    if not site:
        raise RuntimeError('Falta ODOO_SHOP_URL (web de la tienda)')
    portada = fetch(f'{site}/shop') or ''
    cats, vistas = [], set()
    for href, nombre in re.findall(r'href="(/shop/category/[^"?#]+)"[^>]*>\s*([^<]+?)\s*<', portada):
        if href not in vistas and texto(nombre):
            vistas.add(href)
            cats.append((texto(nombre), href))
    print(f'📦 Tienda Odoo — {site} — {len(cats)} categorías + resto', file=sys.stderr)

    emitidos, usados, total = set(), set(), 0

    def emitir(nombre, items, categoria):
        nonlocal total
        count = 0
        for tid, d in items:
            if tid in emitidos or not d['name']:
                continue
            emitidos.add(tid)
            # Muchos nombres arrancan con el código del proveedor ("513387 SLIME CAPY")
            m = re.match(r'^([A-Za-z0-9-]*\d[A-Za-z0-9-]*)\s+\S', d['name'])
            codigo = re.sub(r'[^A-Z0-9]', '', m.group(1).upper()) if m else ''
            sku = codigo if len(codigo) >= 3 else f'T{tid}'
            if sku in usados:
                sku = f'{sku}T{tid}'
            usados.add(sku)
            product = {'sku': sku, **d, 'offer_price': None, 'source_category': categoria,
                       'barcode': None, 'available': True}
            print(json.dumps({'type': 'product', **product}), flush=True)
            count += 1
        total += count
        print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
        print(f'✅ {nombre}: {count} productos ({len(items)} en la categoría)', file=sys.stderr)

    for nombre, href in cats + [(RESTO, '/shop')]:
        items = recorrer(href, site)
        if nombre in SKIP_CATEGORIES:
            print(f'⏭️ Saltando categoría ya completada: {nombre}', file=sys.stderr)
            emitidos.update(tid for tid, _ in items)
            continue
        emitir(nombre, items, None if nombre == RESTO else nombre)

    print(f'📊 Tienda Odoo: {total} productos emitidos', file=sys.stderr)
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
