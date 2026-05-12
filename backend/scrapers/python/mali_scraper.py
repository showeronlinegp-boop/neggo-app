"""
mali_scraper.py — Mali Mayorista
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar emite {"type":"category_done","name":"Wishlist","count":N}
(Mali es una wishlist sin paginación por categoría — no soporta SKIP_CATEGORIES)
"""
import sys
import signal
import json
import time
import shutil
import os
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from bs4 import BeautifulSoup

LOGIN_URL    = 'https://www.mali.com.ar/index.php?route=account/login'
WISHLIST_URL = 'https://www.mali.com.ar/index.php?route=account/wishlist'
BASE_URL     = 'https://www.mali.com.ar/'

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

def login(driver, username, password):
    print(f'📦 Login en Mali como {username}...', file=sys.stderr)
    driver.get(LOGIN_URL)
    time.sleep(2)
    try:
        driver.find_element(By.ID, 'input-email').send_keys(username)
        driver.find_element(By.ID, 'input-password').send_keys(password)
        driver.find_element(By.CSS_SELECTOR, "input.btn.btn-primary[value='ACCEDER']").click()
        WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, 'my_account')))
        print('✅ Login exitoso', file=sys.stderr)
        return True
    except NoSuchElementException:
        print('✅ Sesión ya activa', file=sys.stderr)
        return True
    except Exception as e:
        print(f'❌ Login falló: {e}', file=sys.stderr)
        return False

def parse_price(text):
    """Limpia precio: '$310.00' o '$1,234.56' → float."""
    if not text:
        return None
    cleaned = text.replace('$', '').replace(',', '').strip()
    try:
        return float(cleaned)
    except:
        return None

def get_wishlist_items(driver):
    """Paso 1: obtener links Y precios directamente de la tabla wishlist."""
    print('📦 Cargando wishlist...', file=sys.stderr)
    driver.get(WISHLIST_URL)
    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'table.wishlist tbody tr'))
        )
    except TimeoutException:
        print('⚠️ No se encontraron productos en la wishlist', file=sys.stderr)
        return []

    soup = BeautifulSoup(driver.page_source, 'html.parser')
    rows = soup.select('table.wishlist tbody tr')
    items = []
    for row in rows:
        link_tag = row.select_one('td:nth-of-type(2) a')
        if not link_tag or not link_tag.get('href'):
            continue
        price_div = row.select_one('div.price')
        items.append({
            'url':            link_tag['href'],
            'wishlist_price': parse_price(price_div.get_text(strip=True)) if price_div else None,
        })

    found_prices = sum(1 for i in items if i['wishlist_price'] is not None)
    print(f'📦 {len(items)} productos en wishlist ({found_prices} con precio visible)', file=sys.stderr)
    return items

def scrape_product(driver, url):
    """Paso 2: visitar cada producto y extraer datos."""
    driver.get(url)
    try:
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "h1[itemprop='name']"))
        )
    except TimeoutException:
        return None

    soup = BeautifulSoup(driver.page_source, 'html.parser')

    name_tag = soup.select_one('h1[itemprop="name"]')
    name = name_tag.get_text(strip=True) if name_tag else None
    if not name:
        return None

    code = None
    model_div = soup.select_one('div.model')
    if model_div:
        code = model_div.get_text(strip=True).replace('Cód:', '').strip()

    price_tag = soup.select_one('span.price-new span[itemprop="price"]')
    raw_price = None
    if price_tag:
        price_str = price_tag.get_text(strip=True).replace('$', '').replace(',', '').strip()
        try:
            raw_price = float(price_str)
        except:
            raw_price = None

    img_tag = soup.select_one('img.product-image-zoom, #image')
    image_url = img_tag.get('src') if img_tag else None

    breadcrumbs = soup.select('ul.breadcrumb li a')
    source_category = breadcrumbs[-2].get_text(strip=True) if len(breadcrumbs) > 2 else 'General'

    return {
        'name': name,
        'code': code,
        'raw_price': raw_price,
        'image_url': image_url,
        'source_category': source_category,
        'product_url': url,
    }

def scrape(driver, username, password):
    if not login(driver, username, password):
        raise Exception('Login fallido')

    import re
    items = get_wishlist_items(driver)
    count = 0

    for i, item in enumerate(items):
        link           = item['url']
        wishlist_price = item['wishlist_price']
        print(f'  → Producto {i+1}/{len(items)}: {link}', file=sys.stderr)
        try:
            data = scrape_product(driver, link)
            if not data:
                continue

            # Precio: página del producto tiene prioridad; si está oculto, usar el de la wishlist
            raw_price = data['raw_price'] or wishlist_price
            if raw_price is None:
                print(f'    ⚠️ Sin precio — saltando', file=sys.stderr)
                continue

            sku = data['code']
            if not sku:
                m = re.search(r'product_id=(\d+)', link)
                sku = m.group(1) if m else str(i)

            price_source = 'página' if data['raw_price'] else 'wishlist'
            product = {
                'sku':             sku,
                'name':            data['name'],
                'raw_price':       raw_price,
                'offer_price':     None,
                'image_url':       data['image_url'],
                'product_url':     data['product_url'],
                'source_category': data['source_category'],
                'barcode':         None,
                'available':       True,
            }
            print(json.dumps({'type': 'product', **product}), flush=True)
            print(f'    ✔ {sku} | {data["name"][:40]} (${raw_price} [{price_source}])', file=sys.stderr)
            count += 1
            time.sleep(1)

        except Exception as e:
            print(f'    ❌ Error: {e}', file=sys.stderr)

    # Señal de finalización (wishlist completa = una sola "categoría")
    print(json.dumps({'type': 'category_done', 'name': 'Wishlist', 'count': count}), flush=True)


if __name__ == '__main__':
    username = os.environ.get('MALI_USERNAME', '')
    password = os.environ.get('MALI_PASSWORD', '')

    if not username or not password:
        print('❌ Faltan MALI_USERNAME / MALI_PASSWORD en env', file=sys.stderr)
        sys.exit(1)

    driver = None
    try:
        driver = setup_driver()
        scrape(driver, username, password)
    except Exception as e:
        print(f'❌ Error fatal: {e}', file=sys.stderr)
        sys.exit(1)
    finally:
        if driver:
            driver.quit()
