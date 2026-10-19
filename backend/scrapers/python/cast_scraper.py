"""
cast_scraper.py — Cast Mayorista
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar cada categoría emite {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres ya completados, para reanudar).
"""
import sys
import json
import time
import shutil
import os
import re
import signal
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import WebDriverException
from bs4 import BeautifulSoup

# Categorías ya completadas (para reanudar scraping pausado)
SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))
# Checkpoint de página: categoría y página donde se pausó
RESUME_CATEGORY = os.environ.get('RESUME_CATEGORY', '')
RESUME_PAGE     = int(os.environ.get('RESUME_PAGE', '1'))

# ─── Configuración de Chromium ────────────────────────────────────────────────

def setup_driver():
    chromium = os.environ.get('CHROMIUM_BIN') or shutil.which('chromium-browser') or shutil.which('chromium') or '/usr/bin/chromium-browser'
    chromedriver = os.environ.get('CHROMEDRIVER_BIN') or shutil.which('chromedriver') or '/usr/bin/chromedriver'

    options = Options()
    options.binary_location = chromium
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    service = Service(chromedriver)
    return webdriver.Chrome(service=service, options=options)

# ─── Categorías ────────────────────────────────────────────────────────────────

CATEGORIES = [
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/vasos-copas/',          'category': 'Vasos y Copas'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/vasos-termicos/',        'category': 'Vasos Termicos'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/relojeria/',             'category': 'Relojeria'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/perfumeria/',            'category': 'Perfumeria'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/peluqueria/',            'category': 'Peluqueria'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/paragua/',               'category': 'Paraguas'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/mochila-y-bolso/',       'category': 'Mochilas y Bolsos'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/mascota/',               'category': 'Mascotas'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/llavero/',               'category': 'Llaveros'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/indumentaria/',          'category': 'Indumentaria'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/ferreteria/',            'category': 'Ferreteria'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/electronica/',           'category': 'Electronica'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/cotillon/',              'category': 'Cotillon'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/cosmetico/',             'category': 'Cosmeticos'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/botellas-todo/',         'category': 'Botellas'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/belleza/',               'category': 'Belleza'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/bazar/',                 'category': 'Bazar'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/almohada-de-viaje/',     'category': 'Almohadas'},
    {'url': 'https://www.castmayorista.com.ar/categoria-producto/accesorios-p-celular/',  'category': 'Tecnologia'},
]

HOME_URL = 'https://www.castmayorista.com.ar'
MAX_PAGE = 50

def clean_price(price_str):
    """Limpia precio: '$1.234,56' → 1234.56 (formato argentino)"""
    if not price_str:
        return None
    cleaned = price_str.replace('$', '').replace('\xa0', '').replace('\u00a0', '').strip()
    cleaned = cleaned.replace('.', '').replace(',', '.')
    try:
        return float(cleaned)
    except:
        return None

def normalize_sku(code):
    """Código en mayúsculas solo con caracteres alfanuméricos."""
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip())

def make_sku_from_url(url):
    raw = url.rstrip('/').split('/')[-1]
    return re.sub(r'[^A-Z0-9]', '', raw.upper())

def make_sku_from_name(name):
    import unicodedata
    nfkd = unicodedata.normalize('NFD', name.upper())
    ascii_str = ''.join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r'[^A-Z0-9]', '', ascii_str)[:50]

# ─── Scraper principal ────────────────────────────────────────────────────────

def scrape(driver):
    total_categories = len(CATEGORIES)
    skipped = len(SKIP_CATEGORIES)

    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando {skipped} categoría(s) ya completadas', file=sys.stderr)

    for cat_idx, category_info in enumerate(CATEGORIES):
        base_url = category_info['url'].rstrip('/')
        category_name = category_info['category']

        # Saltar categorías ya completadas (modo reanudar)
        if category_name in SKIP_CATEGORIES:
            print(f'⏭️ [{cat_idx+1}/{total_categories}] Saltando: {category_name}', file=sys.stderr)
            continue

        print(f'📦 [{cat_idx+1}/{total_categories}] Categoría: {category_name}', file=sys.stderr)

        # Si es la categoría donde estábamos al pausar, arrancar desde la última página procesada
        start_page = (RESUME_PAGE + 1) if (RESUME_CATEGORY and category_name == RESUME_CATEGORY) else 1
        if start_page > 1:
            print(f'  ⏭️ Reanudando desde página {start_page} (última procesada: {RESUME_PAGE})', file=sys.stderr)

        page = start_page
        last_first_name = None
        cat_count = 0

        while page <= MAX_PAGE:
            target_url = base_url + '/' if page == 1 else f'{base_url}/page/{page}/'
            print(f'  → Página {page}: {target_url}', file=sys.stderr)

            try:
                driver.get(target_url)
                time.sleep(2)
            except WebDriverException as e:
                print(f'  ❌ Error navegando: {e}', file=sys.stderr)
                break

            # Fin de paginación: redirect al home
            current_url = driver.current_url.rstrip('/')
            if current_url == HOME_URL:
                print(f'  🛑 Redirect al home — fin de categoría', file=sys.stderr)
                break
            if page > 1 and current_url == base_url:
                print(f'  🛑 Redirect a página 1 — fin de categoría', file=sys.stderr)
                break

            # Scroll para lazy load de imágenes
            driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
            time.sleep(1)

            soup = BeautifulSoup(driver.page_source, 'html.parser')
            product_lis = soup.find_all('li', class_='product')

            if not product_lis:
                print(f'  🛑 Sin productos — fin de categoría', file=sys.stderr)
                break

            # Detección de bucle (mismo primer producto)
            first_name_tag = product_lis[0].find('h2', class_='woocommerce-loop-product__title')
            first_name = first_name_tag.text.strip() if first_name_tag else ''
            if first_name and first_name == last_first_name:
                print(f'  🛑 Bucle detectado — fin de categoría', file=sys.stderr)
                break
            last_first_name = first_name

            # Recolectar datos básicos del listado
            page_items = []
            for li in product_lis:
                if 'outofstock' in li.get('class', []):
                    continue
                name_tag = li.find('h2', class_='woocommerce-loop-product__title')
                name = name_tag.text.strip() if name_tag else None
                if not name:
                    continue

                bdi_tags = li.select('span.woocommerce-Price-amount bdi')
                raw_price_text = bdi_tags[0].text.strip() if bdi_tags else None
                offer_price_text = bdi_tags[1].text.strip() if len(bdi_tags) >= 2 else None

                link_tag = li.find('a', class_='woocommerce-LoopProduct-link')
                if not link_tag:
                    link_tag = li.find('a')
                product_link = link_tag['href'] if link_tag else None

                img_tag = li.find('img', class_='attachment-woocommerce_thumbnail') or li.find('img')
                image_url = None
                if img_tag:
                    image_url = img_tag.get('data-src') or img_tag.get('src')

                page_items.append({
                    'name': name,
                    'raw_price_text': raw_price_text,
                    'offer_price_text': offer_price_text,
                    'product_link': product_link,
                    'image_url': image_url,
                })

            print(f'  ✅ {len(page_items)} productos — obteniendo SKUs...', file=sys.stderr)

            # Visitar cada producto para obtener SKU
            for item in page_items:
                sku = None
                if item['product_link']:
                    try:
                        driver.get(item['product_link'])
                        time.sleep(0.8)
                        product_soup = BeautifulSoup(driver.page_source, 'html.parser')
                        sku_span = product_soup.find('span', class_='sku')
                        if sku_span:
                            sku = sku_span.text.strip()
                    except Exception as e:
                        print(f'  ⚠️ SKU error: {e}', file=sys.stderr)

                if not sku:
                    sku = make_sku_from_url(item['product_link']) if item['product_link'] else make_sku_from_name(item['name'])

                product = {
                    'sku': sku,
                    'name': item['name'],
                    'raw_price': clean_price(item['raw_price_text']),
                    'offer_price': clean_price(item['offer_price_text']),
                    'image_url': item['image_url'],
                    'product_url': item['product_link'],
                    'source_category': category_name,
                    'barcode': None,
                    'available': True,
                }
                # Emitir producto inmediatamente via NDJSON
                print(json.dumps({'type': 'product', **product}), flush=True)
                print(f'    ✔ {sku} | {item["name"][:40]}', file=sys.stderr)
                cat_count += 1

            # Checkpoint de página: esta página está completamente procesada
            print(json.dumps({'type': 'page_checkpoint', 'category': category_name, 'page': page}), flush=True)

            page += 1
            time.sleep(1.5)

        # Señal de categoría completada (para checkpoint)
        print(json.dumps({'type': 'category_done', 'name': category_name, 'count': cat_count}), flush=True)
        print(f'✅ Categoría "{category_name}" completada: {cat_count} productos', file=sys.stderr)


if __name__ == '__main__':
    driver = None

    def shutdown(signum, frame):
        """Cierra el driver limpiamente al recibir SIGTERM/SIGINT."""
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        sys.exit(143)  # 128 + SIGTERM: el backend lo toma como pausa

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        driver = setup_driver()
        scrape(driver)
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
