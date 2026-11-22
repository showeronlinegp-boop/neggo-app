"""
renacer_scraper.py — Distribuidora El Renacer (elrenacer.com.ar)
La tienda es de la plataforma Kit Digital (Next.js + Supabase). La home trae el catálogo ENTERO
embebido en el payload de React (self.__next_f.push): una sola descarga, sin login.

Cada producto trae: code (IGB-158, IJ1438, NLCTD0002#…), name, price (pesos en CENTAVOS, ya
convertidos al dólar del día: orderRate), image_url (Cloudinary), slug, category_ids, section_id y
metadata (pack_size = bulto, min_qty = compra mínima, short_note = medida).

- SKU: el código sin guiones (lo limpia baseScraper) = el mismo de la lista en PDF/Excel que se cargó
  a mano en noviembre, así las ofertas y sus vínculos se conservan. "#" marca otro producto con el
  mismo código (NLCTD0002 y NLCTD0002#): se cambia por X para que no choquen.
- Nombre: el de la web + la medida entre paréntesis si no está ya en el nombre.
- Precio: price / 100. Sin precio (carpetas con variantes de color) → no disponible.
- Categoría: "<categoría> / <sección>" (ej. "Librería / Carpetas").
Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"Catálogo","count":N}
"""
import sys
import signal
import json
import time
import os
import re
import gzip
import urllib.request

SITE_URL = os.environ.get('RN_SITE_URL', 'https://elrenacer.com.ar').rstrip('/')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 120
REINTENTOS = 3
CATALOGO = 'Catálogo'
# Si la home trae menos de esta fracción de totalCount, el catálogo vino cortado: no seguir
MIN_FRACCION = 0.9

RE_PUSH = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
RE_OBJ = re.compile(r'\{"id":"[0-9a-f-]{36}","(?:name|store_id)":')


def fetch_html(url):
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': USER_AGENT,
                'Accept': 'text/html',
                'Accept-Encoding': 'gzip',
            })
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
                if resp.headers.get('Content-Encoding') == 'gzip':
                    data = gzip.decompress(data)
                return data.decode('utf-8')
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ Intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {url}: {ultimo_error}')


def leer_flight(html):
    """Une los pedazos del payload de React Server Components en un solo texto."""
    return ''.join(json.loads(c) for c in RE_PUSH.findall(html))


def leer_objetos(flight):
    """Devuelve (productos, categorías, secciones) encontrados en el payload, por id."""
    dec = json.JSONDecoder()
    productos, categorias, secciones = {}, {}, {}
    for m in RE_OBJ.finditer(flight):
        try:
            o, _ = dec.raw_decode(flight, m.start())
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        if 'price' in o and 'slug' in o and 'code' in o and 'name' in o:
            productos.setdefault(o['id'], o)
        elif 'title' in o and 'layout' in o:
            secciones.setdefault(o['id'], o['title'])
        elif 'name' in o and 'store_id' in o and 'price' not in o:
            categorias.setdefault(o['id'], o['name'])
    return productos, categorias, secciones


def leer_numero(flight, clave):
    m = re.search(r'"' + clave + r'":(\d+(?:\.\d+)?)', flight)
    return float(m.group(1)) if m else None


def contar_sitemap():
    """Cantidad de fichas /p/ del sitemap (una por producto). None si no se pudo leer."""
    try:
        xml = fetch_html(SITE_URL + '/sitemap.xml')
    except RuntimeError:
        return None
    return len(re.findall(r'<loc>[^<]*/p/[^<]+</loc>', xml)) or None


def texto(v):
    return v if isinstance(v, str) and v != '$undefined' else None


def limpiar_codigo(code):
    code = (texto(code) or '').strip().upper()
    if not code:
        return None
    # "#" = otro producto con el mismo código base (NLCTD0002 / NLCTD0002#)
    code = code.replace('#', 'X')
    return re.sub(r'[^A-Z0-9]', '', code) or None


def armar_nombre(p):
    nombre = re.sub(r'\s+', ' ', texto(p.get('name')) or '').strip()
    nota = re.sub(r'\s+', ' ', texto((p.get('metadata') or {}).get('short_note')) or '').strip()
    if nota and nota.lower() not in nombre.lower():
        nombre = f'{nombre} ({nota})'
    return nombre


def to_product(p, categorias, secciones):
    precio = p.get('price') if isinstance(p.get('price'), (int, float)) else None
    raw_price = round(precio / 100, 2) if precio else None
    cats = [categorias[c] for c in (p.get('category_ids') or []) if c in categorias]
    seccion = secciones.get(p.get('section_id'))
    partes = [x for x in (cats[0] if cats else None, seccion) if x]
    slug = texto(p.get('slug'))
    return {
        'sku': limpiar_codigo(p.get('code')),
        'name': armar_nombre(p),
        'raw_price': raw_price,
        'offer_price': None,
        'image_url': texto(p.get('image_url')),
        'product_url': f'{SITE_URL}/p/{slug}' if slug else None,
        'source_category': ' / '.join(partes) or None,
        'barcode': texto(p.get('barcode')),
        'available': bool(raw_price),
    }


def scrape():
    html = fetch_html(SITE_URL + '/')
    flight = leer_flight(html)
    productos, categorias, secciones = leer_objetos(flight)
    # La home no dice cuántos productos hay: el total sale de las fichas del sitemap
    total = leer_numero(flight, 'totalCount') or contar_sitemap()
    dolar = leer_numero(flight, 'orderRate')
    print(f'📦 El Renacer — {len(productos)} productos en la home (la tienda dice {int(total) if total else "?"}), '
          f'dólar {dolar or "?"}, {len(categorias)} categorías, {len(secciones)} secciones', file=sys.stderr)
    if not productos:
        raise RuntimeError('La home no trajo productos: ¿cambió la web?')
    if total and len(productos) < total * MIN_FRACCION:
        raise RuntimeError(f'La home trajo {len(productos)} de {int(total)} productos: el catálogo vino cortado')

    count = sin_precio = 0
    usados = {}
    for p in productos.values():
        product = to_product(p, categorias, secciones)
        if not product['sku'] or not product['name']:
            print(f'  ⚠️ Salteado sin código o nombre: {p.get("name")!r}', file=sys.stderr)
            continue
        veces = usados.get(product['sku'], 0)
        usados[product['sku']] = veces + 1
        if veces:
            product['sku'] = f"{product['sku']}D{veces + 1}"
        if not product['raw_price']:
            sin_precio += 1
        print(json.dumps({'type': 'product', **product}, ensure_ascii=False), flush=True)
        count += 1

    print(json.dumps({'type': 'category_done', 'name': CATALOGO, 'count': count}), flush=True)
    if sin_precio:
        print(f'⚠️ {sin_precio} productos sin precio en la web quedan no disponibles', file=sys.stderr)
    print(f'📊 El Renacer: {count} productos emitidos', file=sys.stderr)


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
