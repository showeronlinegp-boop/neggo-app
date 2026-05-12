"""
elrey_scraper.py — El Rey (catálogo Smarty con token)
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar cada categoría emite {"type":"category_done","name":"...","count":N}
Soporta SKIP_CATEGORIES (JSON list de nombres para reanudar).
"""
import sys
import signal
import json
import time
import shutil
import os
import re
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from bs4 import BeautifulSoup

BASE_URL = 'https://catalog.smarty.com.ar'


def normalize_sku(code):
    """Devuelve el código en mayúsculas solo con caracteres alfanuméricos."""
    if not code:
        return None
    return re.sub(r'[^A-Z0-9]', '', code.upper().strip())

DEFAULT_TOKEN        = '574abb0c8c154b8d46e3cd9e8d99c5b8ab5f00ad'
DEFAULT_CATEGORY_IDS = [9732, 9728, 7335, 9730, 9727]

# Categorías a saltear (por nombre, para reanudar)
SKIP_CATEGORIES = set(json.loads(os.environ.get('SKIP_CATEGORIES', '[]')))


def setup_driver():
    chromium    = os.environ.get('CHROMIUM_BIN') or shutil.which('chromium-browser') or shutil.which('chromium') or '/usr/bin/chromium-browser'
    chromedriver = os.environ.get('CHROMEDRIVER_BIN') or shutil.which('chromedriver') or '/usr/bin/chromedriver'

    options = Options()
    options.binary_location = chromium
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    return webdriver.Chrome(service=Service(chromedriver), options=options)


def clean_price(price_str):
    """Limpia precio: '$1.234,56' → 1234.56 (formato argentino)."""
    if not price_str:
        return None
    cleaned = price_str.replace('$', '').replace('\xa0', '').strip()
    cleaned = cleaned.replace('.', '').replace(',', '.')
    try:
        return float(cleaned)
    except:
        return None


def scrape_category(driver, start_url):
    """Recorre todas las páginas de una categoría y emite productos via NDJSON."""
    current_url = start_url
    page_count = 1
    cat_count = 0

    print(f'📦 Accediendo a categoría: {start_url}', file=sys.stderr)
    driver.get(current_url)

    # Obtener nombre de la categoría
    category_name = 'Catálogo'
    try:
        WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'h2.d-inline.fw-bold'))
        )
        raw_name = driver.find_element(By.CSS_SELECTOR, 'h2.d-inline.fw-bold').text.strip()
        category_name = raw_name[3:] if raw_name.startswith('en ') else raw_name
    except TimeoutException:
        print('⚠️ No se encontró el nombre de la categoría', file=sys.stderr)

    print(f'📦 Categoría: {category_name}', file=sys.stderr)

    # Saltar si ya fue completada en run anterior
    if category_name in SKIP_CATEGORIES:
        print(f'⏭️ Saltando categoría ya completada: {category_name}', file=sys.stderr)
        return category_name, 0, True  # (name, count, skipped)

    while current_url:
        print(f'  → Página {page_count}: {current_url}', file=sys.stderr)
        if page_count > 1:
            driver.get(current_url)

        try:
            WebDriverWait(driver, 15).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, 'div.itemWrapper'))
            )
            time.sleep(1)
        except TimeoutException:
            print(f'  🛑 Sin productos en página {page_count}', file=sys.stderr)
            break

        soup = BeautifulSoup(driver.page_source, 'html.parser')
        items = soup.select('div.itemWrapper')

        if not items:
            print(f'  🛑 Sin productos — fin de categoría', file=sys.stderr)
            break

        for item in items:
            try:
                name_tag = item.select_one('h5.item-name')
                name = name_tag.get_text(strip=True) if name_tag else None
                if not name:
                    continue

                ref_tag = item.select_one('span.reference')
                codigo = ref_tag.get_text(strip=True) if ref_tag else None

                price_tag = item.select_one('span.discountPrice') or item.select_one('div.item-price span')
                raw_price = clean_price(price_tag.get_text(strip=True)) if price_tag else None

                img_tag = item.select_one('img.item-image-primary')
                image_url = None
                if img_tag:
                    src = img_tag.get('data-src') or img_tag.get('src', '')
                    image_url = f'{BASE_URL}{src}' if src.startswith('/') else src

                sku = normalize_sku(codigo) if codigo else None

                product = {
                    'sku':             sku,
                    'name':            name,
                    'raw_price':       raw_price,
                    'offer_price':     None,
                    'image_url':       image_url,
                    'product_url':     None,
                    'source_category': category_name,
                    'barcode':         None,
                    'available':       True,
                }
                # Emitir producto inmediatamente via NDJSON
                print(json.dumps({'type': 'product', **product}), flush=True)
                print(f'    ✔ {sku} | {name[:40]}', file=sys.stderr)
                cat_count += 1

            except Exception as e:
                print(f'    ❌ Error en item: {e}', file=sys.stderr)

        print(f'  ✅ {len(items)} productos en página {page_count}', file=sys.stderr)

        # Siguiente página via a[rel="next"]
        next_url = None
        try:
            next_tag = driver.find_element(By.CSS_SELECTOR, 'a[rel="next"]')
            href = next_tag.get_attribute('href')
            if href and href != current_url:
                next_url = href if href.startswith('http') else f'{BASE_URL}{href}'
        except NoSuchElementException:
            pass

        current_url = next_url
        page_count += 1
        if next_url:
            time.sleep(1)

    print(f'✅ Categoría "{category_name}": {cat_count} productos total', file=sys.stderr)
    return category_name, cat_count, False


def scrape(driver):
    token       = os.environ.get('ELREY_TOKEN', DEFAULT_TOKEN)
    cat_ids_raw = os.environ.get('ELREY_CATEGORY_IDS', '')

    if cat_ids_raw:
        try:
            category_ids = json.loads(cat_ids_raw)
        except:
            category_ids = DEFAULT_CATEGORY_IDS
    else:
        category_ids = DEFAULT_CATEGORY_IDS

    print(f'📦 El Rey — token: {token[:12]}... — {len(category_ids)} categorías', file=sys.stderr)

    if SKIP_CATEGORIES:
        print(f'⏭️ Reanudando — saltando categorías: {list(SKIP_CATEGORIES)}', file=sys.stderr)

    for cat_id in category_ids:
        url = f'{BASE_URL}/token/{token}/?category_id={cat_id}'
        category_name, cat_count, skipped = scrape_category(driver, url)

        if not skipped:
            # Señal de categoría completada (para checkpoint)
            print(json.dumps({'type': 'category_done', 'name': category_name, 'count': cat_count}), flush=True)

        time.sleep(1)


if __name__ == '__main__':
    driver = None

    def shutdown(signum, frame):
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        sys.exit(0)

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
