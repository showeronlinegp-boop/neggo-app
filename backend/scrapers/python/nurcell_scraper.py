"""
nurcell_scraper.py — Nurcell (en Odoo/DB figura como proveedor "Babu", prefijo BB)
Misma plataforma de catálogo PHP que Impotekno, pero el HTML viene completo
desde el servidor: no hace falta Selenium, alcanza con urllib + BeautifulSoup.
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar emite {"type":"category_done","name":"Catálogo","count":N}
(Catálogo único — no soporta SKIP_CATEGORIES)
"""
import sys
import signal
import json
import re
import urllib.request
from bs4 import BeautifulSoup

CATALOG_URL = 'https://www.nurcell.com.ar/catalogo2022x3.php?rub=99999'
BASE_URL    = 'https://www.nurcell.com.ar'
TIMEOUT     = 90


def fetch_html(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        charset = resp.headers.get_content_charset() or 'utf-8'
        return resp.read().decode(charset, errors='replace')


def clean_price(price_str):
    """Limpia precio con detección inteligente de separadores AR/US."""
    if not price_str:
        return None
    cleaned = price_str.replace('$', '').replace('\xa0', '').replace(' ', '').strip()
    has_dot   = '.' in cleaned
    has_comma = ',' in cleaned

    if has_dot and has_comma:
        # Ambos presentes: el que aparece último es el decimal
        if cleaned.rindex(',') > cleaned.rindex('.'):
            # "1.234,56" → AR: punto=miles, coma=decimal
            cleaned = cleaned.replace('.', '').replace(',', '.')
        else:
            # "1,234.56" → US: coma=miles, punto=decimal
            cleaned = cleaned.replace(',', '')
    elif has_comma:
        after = cleaned.split(',')[-1]
        if len(after) == 3 and after.isdigit():
            # "1,500" → coma como separador de miles → eliminar
            cleaned = cleaned.replace(',', '')
        else:
            # "1,50" → coma como decimal
            cleaned = cleaned.replace(',', '.')
    elif has_dot:
        after = cleaned.split('.')[-1]
        if len(after) == 3 and after.isdigit():
            # "1.500" → punto como separador de miles → eliminar
            cleaned = cleaned.replace('.', '')
        # else: "1.50" → punto decimal, dejar como está

    try:
        return float(cleaned)
    except Exception:
        return None


def normalize_sku(code):
    """Código en mayúsculas solo con caracteres alfanuméricos."""
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip())


def clean_name(text):
    """El sitio rellena los nombres con guiones bajos: 'PILAS LITHIUM 2032 ______'."""
    name = re.sub(r'_+', ' ', text or '')
    return re.sub(r'\s+', ' ', name).strip()


def scrape():
    print(f'📦 Descargando catálogo Nurcell: {CATALOG_URL}', file=sys.stderr)
    soup = BeautifulSoup(fetch_html(CATALOG_URL), 'html.parser')

    product_elements = soup.select('div.caja_producto')
    print(f'📦 {len(product_elements)} productos encontrados', file=sys.stderr)

    count = 0
    seen  = set()
    for i, elem in enumerate(product_elements):
        try:
            h1 = elem.select_one('div#descrip h1')
            name = clean_name(h1.get_text()) if h1 else None
            if not name or name == 'No disponible':
                continue

            codigo = None
            rubro  = 'Sin Categoría'
            texto = elem.select_one('div#texto')
            if texto:
                for linea in texto.get_text('\n').split('\n'):
                    linea = linea.strip()
                    if linea.startswith('Codigo:'):
                        codigo = linea.replace('Codigo:', '').strip()
                    elif linea.startswith('Rubro:'):
                        # "PILAS   (NOVEDADES)" → "PILAS"
                        rubro = linea.replace('Rubro:', '').split('(')[0].strip() or rubro

            sku = normalize_sku(codigo)
            if not sku:
                print(f'  ⚠️ Producto sin código, se omite: {name[:40]}', file=sys.stderr)
                continue
            # Códigos como "RT-DTA-TV" y "RT-DTA+TV" colisionan al normalizar
            if sku in seen:
                print(f'  ⚠️ Código duplicado tras normalizar ({codigo} → {sku}), se omite: {name[:40]}', file=sys.stderr)
                continue
            seen.add(sku)

            price_el  = elem.select_one('strong[class^="caja_precio"]')
            raw_price = clean_price(price_el.get_text(strip=True)) if price_el else None

            image_url = None
            img = elem.select_one('div#foto img')
            if img and img.get('src'):
                src = img['src'].strip()
                image_url = src if src.startswith('http') else f'{BASE_URL}/{src.lstrip("/")}'

            product = {
                'sku':             sku,
                'name':            name,
                'raw_price':       raw_price,
                'offer_price':     None,
                'image_url':       image_url,
                'product_url':     f'{CATALOG_URL}#{codigo}',
                'source_category': rubro,
                'barcode':         None,
                'available':       True,
            }
            # Emitir producto inmediatamente via NDJSON
            print(json.dumps({'type': 'product', **product}), flush=True)
            print(f'  ✔ {sku} | {name[:40]} ({rubro})', file=sys.stderr)
            count += 1

        except Exception as e:
            print(f'  ❌ Error en producto {i}: {e}', file=sys.stderr)

    # Señal de finalización
    print(json.dumps({'type': 'category_done', 'name': 'Catálogo', 'count': count}), flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(143))  # 128 + SIGTERM: el backend lo toma como pausa
    signal.signal(signal.SIGINT, lambda signum, frame: sys.exit(143))  # corte a propósito: el backend lo toma como pausa

    try:
        scrape()
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)
