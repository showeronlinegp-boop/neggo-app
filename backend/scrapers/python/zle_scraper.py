"""
zle_scraper.py — ZLE Store (zlestore.com)
La web es una SPA que lee todo de una API RPC propia (POST https://api.zlestore.com/<caso de uso>):
  - getVariantSearchResult {keyword:""} → el listado completo de /search (una variante por producto)
  - findProductByIdUsers {slug}          → el detalle ("Ver detalles"): todas las variantes, SKU y categoría
  - login {email, password}               → sesión por cookie; sin ella unitPrice/bulkPrice vienen null
JSON sin navegador. Credenciales de cliente en ZLE_EMAIL / ZLE_PASSWORD (sin ellas corre igual, sin precios).
Salida NDJSON por stdout: cada variante es una línea {"type":"product",...}
Los productos se procesan en tandas de LOTE; al terminar cada tanda emite {"type":"category_done","name":"Productos X-Y","count":N}
Soporta SKIP_CATEGORIES (JSON list de tandas ya completadas) para reanudar.
"""
import sys
import json
import time
import os
import re
import signal
import threading
import urllib.request
import urllib.error
import http.cookiejar
from concurrent.futures import ThreadPoolExecutor

# Tandas ya completadas (para reanudar scraping pausado)
SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))

ZLE_EMAIL = os.environ.get('ZLE_EMAIL', '').strip()
ZLE_PASSWORD = os.environ.get('ZLE_PASSWORD', '')

# La sesión de la API va en una cookie: un opener con cookie jar la guarda y la reenvía
COOKIES = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIES))
LOGIN_LOCK = threading.Lock()

API_URL = 'https://api.zlestore.com'
SITE_URL = 'https://zlestore.com'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
LOTE = 100           # productos por tanda (checkpoint)
HILOS = 4            # detalles en paralelo
TIMEOUT = 60
REINTENTOS = 3
PAUSA_ENTRE_LOTES = 1

# ─── Helpers ──────────────────────────────────────────────────────────────────

def post(caso, body):
    """Un POST a la API RPC de ZLE (con la cookie de sesión si hay login)."""
    req = urllib.request.Request(f'{API_URL}/{caso}', data=json.dumps(body).encode('utf-8'), method='POST', headers={
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': SITE_URL,
    })
    with OPENER.open(req, timeout=TIMEOUT) as resp:
        texto = resp.read().decode('utf-8')
        return json.loads(texto) if texto else None

def login():
    """Inicia sesión con la cuenta de cliente. Sin credenciales devuelve False (corre sin precios)."""
    if not ZLE_EMAIL or not ZLE_PASSWORD:
        return False
    with LOGIN_LOCK:
        try:
            post('login', {'email': ZLE_EMAIL, 'password': ZLE_PASSWORD})
        except urllib.error.HTTPError as e:
            # No se muestra el cuerpo enviado: lleva la contraseña
            raise RuntimeError(f'Login en ZLE rechazado (HTTP {e.code}): revisá ZLE_EMAIL / ZLE_PASSWORD')
    return True

def call(caso, body):
    """POST a la API RPC de ZLE. Reintenta ante errores de red/5xx. NOT_FOUND → None.
    Si la sesión vence (401) se vuelve a loguear y reintenta."""
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            return post(caso, body)
        except urllib.error.HTTPError as e:
            cuerpo = e.read().decode('utf-8', 'replace')
            if 'NOT_FOUND' in cuerpo:
                return None
            ultimo_error = f'HTTP {e.code}'
            if e.code == 401 and login():
                print(f'  🔑 Sesión de ZLE vencida: login de nuevo', file=sys.stderr)
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ {caso} intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'No se pudo leer {caso} {body}: {ultimo_error}')

# Prefijo de la tienda en los SKU: en Precompras van sin él ("ZLE-027" → PREZL027)
PREFIJO_TIENDA = re.compile(r'^(ZLE-?|ZL(?=\d))', re.IGNORECASE)

def clean_sku(sku):
    return PREFIJO_TIENDA.sub("", (sku or "").strip())

def to_price(value):
    try:
        return float(value) if value not in (None, '') else None
    except (TypeError, ValueError):
        return None

def agotado(v):
    """Misma regla que la web (badge "Agotado"): mira el stock de la forma en que se vende.
    El campo 'stock' no sirve: no coincide con lo que muestra la tienda."""
    paquete = max(0, v.get('unitStock') or 0)
    bulto = max(0, v.get('bulkStock') or 0)
    condicion = v.get('saleCondition')
    if condicion == 'unit':
        return paquete == 0
    if condicion == 'bulk':
        return bulto == 0
    return paquete + bulto == 0

def first_image(*listas):
    for imgs in listas:
        for img in imgs or []:
            url = img.get('url') or img.get('thumbnailUrl')
            if url:
                return url
    return None

def to_products(detalle, item_listado):
    """Convierte el detalle de un producto en una fila por variante (formato de upsertProducts)."""
    variantes = [v for v in (detalle.get('variants') or []) if not v.get('trash')]
    imgs_producto = detalle.get('images') or item_listado.get('images')
    url = f'{SITE_URL}/productos/{detalle.get("slug") or item_listado.get("productSlug")}'
    categoria = (detalle.get('categories') or '').strip() or None

    productos = []
    for v in variantes or [detalle]:
        productos.append({
            'sku': clean_sku(v.get('sku') or detalle.get('sku')),
            'name': (v.get('name') or detalle.get('name') or '').strip(),
            # Sin login la API devuelve null: queda sin precio
            'raw_price': to_price(v.get('unitPrice')),
            'offer_price': None,
            'image_url': first_image(v.get('images'), imgs_producto),
            'product_url': url,
            'source_category': categoria,
            'barcode': None,
            # Disponible = la web no lo muestra agotado y está publicado en la tienda
            'available': not agotado(v) and v.get('isVisible', True) is not False,
            # Código interno de ZLE (detail-product/<id>); upsertProducts no lo guarda
            'supplier_code': str(detalle.get('id') or item_listado.get('productId') or ''),
        })
    return [p for p in productos if p['sku'] and p['name']]

# ─── Scraper principal ────────────────────────────────────────────────────────

def scrape():
    """Recorre el listado en tandas. Devuelve la lista de tandas que fallaron."""
    if login():
        print('🔑 Sesión iniciada en ZLE: se leen precios', file=sys.stderr)
    else:
        print('⚠️ Sin ZLE_EMAIL / ZLE_PASSWORD: se scrapea sin precios', file=sys.stderr)
    listado = call('getVariantSearchResult', {'keyword': ''}) or []
    # Orden estable para que los nombres de las tandas sirvan al reanudar
    listado = sorted((i for i in listado if i.get('productSlug')), key=lambda i: str(i.get('productId')))
    print(f'📦 {len(listado)} productos en el listado de /search', file=sys.stderr)

    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando {len(SKIP_CATEGORIES)} tanda(s) ya completadas', file=sys.stderr)

    fallidas = []
    with ThreadPoolExecutor(max_workers=HILOS) as pool:
        for inicio in range(0, len(listado), LOTE):
            lote = listado[inicio:inicio + LOTE]
            nombre = f'Productos {inicio + 1}-{inicio + len(lote)}'
            if nombre in SKIP_CATEGORIES:
                print(f'⏭️ Saltando: {nombre}', file=sys.stderr)
                continue

            print(f'📦 {nombre} de {len(listado)}', file=sys.stderr)
            try:
                detalles = list(pool.map(lambda i: call('findProductByIdUsers', {'slug': i['productSlug']}), lote))
            except RuntimeError as e:
                # Sin category_done: al reanudar se vuelve a intentar la tanda
                print(f'❌ Tanda "{nombre}" incompleta: {e}', file=sys.stderr)
                fallidas.append(nombre)
                continue

            count = 0
            for item, detalle in zip(lote, detalles):
                if not detalle:
                    print(f'  ⚠️ Sin detalle: {item.get("productSlug")}', file=sys.stderr)
                    continue
                for product in to_products(detalle, item):
                    print(json.dumps({'type': 'product', **product}), flush=True)
                    count += 1

            print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
            print(f'✅ {nombre}: {count} variantes', file=sys.stderr)
            time.sleep(PAUSA_ENTRE_LOTES)

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

    # Si alguna tanda quedó a medias, salir con error: el run no queda 'completed'
    # y no se borran productos que esta vez no se pudieron leer.
    if fallidas:
        print(f'❌ Tandas incompletas: {", ".join(fallidas)}', file=sys.stderr)
        sys.exit(1)
