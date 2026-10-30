"""
blumen_scraper.py — Distribuidora Blumen (tienda Sigma "sigkart", secure.sig2k.com)
El catálogo solo se ve con sesión de cliente. Login con la cuenta de cliente (email y contraseña):
  1. Firebase (proyecto "sigkart") → signInWithPassword devuelve un idToken
  2. login_validar.php con ese token → la tienda abre la sesión (cookie)
  3. swexecute.php?sql=articulos (rows / skip) → artículos en JSON, de a tandas
Credenciales en BLUMEN_EMAIL / BLUMEN_PASSWORD.

Salida NDJSON por stdout: {"type":"product",...} y {"type":"category_done","name":"Productos X-Y","count":N}
Soporta SKIP_CATEGORIES (JSON list de tandas ya completadas) para reanudar.
"""
import sys
import signal
import json
import time
import os
import re
import html as htmllib
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

BASE_URL = os.environ.get('BLUMEN_URL', 'https://secure.sig2k.com/webs/blumen@sigma-ar.defaultKart/sigkart/3.1').rstrip('/')
EMAIL = os.environ.get('BLUMEN_EMAIL', '').strip()
PASSWORD = os.environ.get('BLUMEN_PASSWORD', '')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TIMEOUT = 60
REINTENTOS = 3
FILAS = 24           # lo mismo que pide la página
LOTE = 240           # artículos por tanda (checkpoint)
PAUSA = 0.5
MAX_ARTICULOS = 50000

SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))

COOKIES = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIES))


def request(url, data=None, headers=None, json_body=None):
    """GET/POST con la cookie de sesión. Devuelve el texto de la respuesta."""
    cuerpo = None
    hdrs = {'User-Agent': USER_AGENT, **(headers or {})}
    if json_body is not None:
        cuerpo = json.dumps(json_body).encode('utf-8')
        hdrs['Content-Type'] = 'application/json'
    elif data is not None:
        cuerpo = urllib.parse.urlencode(data).encode('utf-8')
        hdrs['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    req = urllib.request.Request(url, data=cuerpo, headers=hdrs, method='POST' if cuerpo is not None else 'GET')
    with OPENER.open(req, timeout=TIMEOUT) as resp:
        return resp.read().decode('utf-8', 'replace')


def con_reintentos(fn, descripcion):
    ultimo_error = None
    for intento in range(1, REINTENTOS + 1):
        try:
            return fn()
        except Exception as e:
            ultimo_error = str(e)
        print(f'  ⚠️ {descripcion} intento {intento}/{REINTENTOS} fallido ({ultimo_error})', file=sys.stderr)
        time.sleep(3 * intento)
    raise RuntimeError(f'{descripcion}: {ultimo_error}')


def login():
    """Login de cliente: Firebase email/contraseña → login_validar.php (abre la sesión)."""
    if not EMAIL or not PASSWORD:
        raise RuntimeError('Faltan BLUMEN_EMAIL / BLUMEN_PASSWORD: sin cuenta de cliente la tienda no muestra el catálogo')
    request(f'{BASE_URL}/')   # cookies iniciales de la tienda
    config = request(f'{BASE_URL}/login/firebase_config.js')
    api_key = re.search(r'apiKey:\s*"([^"]+)"', config)
    if not api_key:
        raise RuntimeError('No se encontró la configuración de Firebase de la tienda')
    try:
        auth = json.loads(request(
            f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key.group(1)}',
            json_body={'email': EMAIL, 'password': PASSWORD, 'returnSecureToken': True},
            headers={'Referer': f'{BASE_URL}/login/login.php'}))
    except urllib.error.HTTPError as e:
        # No se muestra lo enviado: lleva la contraseña
        raise RuntimeError(f'Login de Blumen rechazado (HTTP {e.code}): revisá BLUMEN_EMAIL / BLUMEN_PASSWORD')
    respuesta = request(f'{BASE_URL}/login/login_validar.php', data={'accessToken': auth['idToken']},
                        headers={'X-Requested-With': 'XMLHttpRequest'})
    try:
        datos = json.loads(respuesta)
    except ValueError:
        datos = {}
    if str(datos.get('errcod', '0')) not in ('0', ''):
        raise RuntimeError(f'La tienda no validó la cuenta: {datos.get("errmsg") or respuesta[:200]}')


def limpio(texto):
    return re.sub(r'\s+', ' ', htmllib.unescape(re.sub(r'<[^>]+>', ' ', texto or ''))).strip()


def articulos(skip):
    def pedir():
        texto = request(f'{BASE_URL}/swexecute.php?sql=articulos', headers={'X-Requested-With': 'XMLHttpRequest'}, data={
            'txtbuscar': '', 'catego': '', 'chkcatego': '', 'orden': '', 'ver': '', 'nocache': '',
            'rows': FILAS, 'skip': skip,
        })
        datos = json.loads(texto)
        # Responde directamente la lista de artículos (o un objeto con error)
        if isinstance(datos, list):
            return datos
        if str(datos.get('errcod', '0')) not in ('0', '', '2'):
            raise RuntimeError(datos.get('errmsg') or texto[:200])
        return datos.get('output') or []
    return con_reintentos(pedir, f'Artículos desde {skip}')


def to_product(item):
    # Subtítulo: "Cod. 25853428 (Stk:        0)" → código del proveedor y stock
    subtit = limpio(item.get('SUBTIT'))
    cod = re.search(r'Cod\.\s*([^\s(]+)', subtit)
    stk = re.search(r'Stk:\s*(-?\d+)', subtit)
    codigo = re.sub(r'[^A-Z0-9]', '', (cod.group(1) if cod else str(item.get('ITEMID') or '')).upper())
    foto = item.get('FOTOID') or ''
    # PRBASE es el precio numérico; el texto viene con formato "$11,008.98"
    try:
        base = round(float(item.get('PRBASE')), 2) if item.get('PRBASE') not in (None, '') else None
    except (TypeError, ValueError):
        base = None
    return {
        'sku': codigo or None,
        'name': limpio(item.get('TITULO')),
        'raw_price': base if base else None,
        'offer_price': None,
        'image_url': f'{BASE_URL}/imagen.php?fotoid={urllib.parse.quote(foto)}&auto=500' if foto else None,
        'product_url': None,
        'source_category': limpio(item.get('CATTXT')) or None,
        'barcode': None,
        # Con stock informado manda el stock; si no viene, que la tienda deje agregarlo al carrito
        'available': (int(stk.group(1)) > 0) if stk else item.get('VERADD') == 'S',
    }


def scrape():
    con_reintentos(login, 'Login')
    print('🔑 Sesión iniciada en Blumen', file=sys.stderr)

    skip, total, tanda, count, usados = 0, 0, 0, 0, set()
    while skip < MAX_ARTICULOS:
        lote = articulos(skip)
        nombre = f'Productos {tanda * LOTE + 1}-{(tanda + 1) * LOTE}'
        if nombre not in SKIP_CATEGORIES:
            for item in lote:
                product = to_product(item)
                if not product['sku'] or not product['name'] or product['sku'] in usados:
                    continue
                usados.add(product['sku'])
                print(json.dumps({'type': 'product', **product}), flush=True)
                count += 1
        skip += len(lote)
        fin = len(lote) < FILAS
        if skip >= (tanda + 1) * LOTE or fin:
            if nombre not in SKIP_CATEGORIES:
                print(json.dumps({'type': 'category_done', 'name': nombre, 'count': count}), flush=True)
                print(f'✅ {nombre}: {count} productos', file=sys.stderr)
                total += count
            tanda, count = tanda + 1, 0
        if fin:
            break
        time.sleep(PAUSA)

    print(f'📊 Blumen: {total} productos emitidos', file=sys.stderr)
    if total == 0 and not SKIP_CATEGORIES:
        raise RuntimeError('No se encontró ningún producto: ¿cambió la web o la cuenta no tiene acceso?')


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
