"""
alif_scraper.py — Alif (alifcell.com)
Misma plataforma de catálogo PHP que Nurcell. El HTML llega completo, pero
el sitio pide una clave de acceso: se entra por POST a index.php y después
se lee el catálogo con la cookie de sesión.
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar emite {"type":"category_done","name":"Catálogo","count":N}
"""
import sys
import signal
import json
import os
import re
import urllib.request
import urllib.parse
import http.cookiejar
from bs4 import BeautifulSoup

BASE_URL = 'https://alifcell.com'
LOGIN_URL = BASE_URL + '/index.php'
CATALOG_URL = BASE_URL + '/catalogo2022x3.php?rub=99999'
TIMEOUT = 90


def fetch_html():
    clave = os.environ.get('ALIF_PASSWORD', '').strip()
    if not clave:
        raise RuntimeError('Falta la clave de acceso de Alif (ALIF_PASSWORD)')

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    data = urllib.parse.urlencode({'clave': clave, 'enviar': 'Ingresar'}).encode()
    req = urllib.request.Request(LOGIN_URL, data=data, headers=headers)
    with opener.open(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or 'utf-8'
        html = raw.decode(charset, errors='replace')

    if 'caja_producto' not in html:
        raise RuntimeError('Alif no devolvió el catálogo: la clave de acceso no entró')
    return html


def clean_price(price_str):
    """Limpia precio con detección inteligente de separadores AR/US."""
    if not price_str:
        return None
    cleaned = price_str.replace('$', '').replace('\xa0', '').replace(' ', '').strip()
    has_dot = '.' in cleaned
    has_comma = ',' in cleaned

    if has_dot and has_comma:
        if cleaned.rindex(',') > cleaned.rindex('.'):
            cleaned = cleaned.replace('.', '').replace(',', '.')
        else:
            cleaned = cleaned.replace(',', '')
    elif has_comma:
        after = cleaned.split(',')[-1]
        if len(after) == 3 and after.isdigit():
            cleaned = cleaned.replace(',', '')
        else:
            cleaned = cleaned.replace(',', '.')
    elif has_dot:
        after = cleaned.split('.')[-1]
        if len(after) == 3 and after.isdigit():
            cleaned = cleaned.replace('.', '')

    try:
        return float(cleaned)
    except Exception:
        return None


def normalize_sku(code):
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip())


def clean_name(text):
    """El sitio rellena los nombres con guiones bajos."""
    name = re.sub(r'_+', ' ', text or '')
    return re.sub(r'\s+', ' ', name).strip()


def scrape():
    print(f'📦 Descargando catálogo Alif: {CATALOG_URL}', file=sys.stderr)
    soup = BeautifulSoup(fetch_html(), 'html.parser')

    product_elements = soup.select('div.caja_producto')
    print(f'📦 {len(product_elements)} productos encontrados', file=sys.stderr)

    count = 0
    seen = set()
    for i, elem in enumerate(product_elements):
        try:
            h1 = elem.select_one('div#descrip h1')
            name = clean_name(h1.get_text()) if h1 else None
            if not name or name == 'No disponible':
                continue

            codigo = None
            rubro = 'Sin Categoría'
            texto = elem.select_one('div#texto')
            if texto:
                for linea in texto.get_text('\n').split('\n'):
                    linea = linea.strip()
                    if linea.startswith('Codigo:'):
                        codigo = linea.replace('Codigo:', '').strip()
                    elif linea.startswith('Rubro:'):
                        rubro = linea.replace('Rubro:', '').split('(')[0].strip() or rubro

            sku = normalize_sku(codigo)
            if not sku:
                print(f'  ⚠️ Producto sin código, se omite: {name[:40]}', file=sys.stderr)
                continue
            if sku in seen:
                print(f'  ⚠️ Código duplicado tras normalizar ({codigo} → {sku}), se omite: {name[:40]}', file=sys.stderr)
                continue
            seen.add(sku)

            price_el = elem.select_one('strong[class^="caja_precio"]')
            raw_price = clean_price(price_el.get_text(strip=True)) if price_el else None

            image_url = None
            img = elem.select_one('div#foto img')
            if img and img.get('src'):
                src = img['src'].strip()
                image_url = src if src.startswith('http') else f'{BASE_URL}/{src.lstrip("/")}'

            product = {
                'sku': sku,
                'name': name,
                'raw_price': raw_price,
                'offer_price': None,
                'image_url': image_url,
                'product_url': f'{CATALOG_URL}#{codigo}',
                'source_category': rubro,
                'barcode': None,
                'available': True,
            }
            print(json.dumps({'type': 'product', **product}, ensure_ascii=False), flush=True)
            count += 1

        except Exception as e:
            print(f'  ❌ Error en producto {i}: {e}', file=sys.stderr)

    print(json.dumps({'type': 'category_done', 'name': 'Catálogo', 'count': count}), flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(143))
    signal.signal(signal.SIGINT, lambda signum, frame: sys.exit(143))

    try:
        scrape()
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)
