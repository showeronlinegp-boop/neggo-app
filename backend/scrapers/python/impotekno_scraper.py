"""
impotekno_scraper.py — Impotekno
Salida NDJSON por stdout: cada producto es una línea {"type":"product",...}
Al finalizar emite {"type":"category_done","name":"Catálogo","count":N}
(Catálogo único — no soporta SKIP_CATEGORIES)
"""
import sys
import signal
import json
import time
import shutil
import os
import re
import unicodedata
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

CATALOG_URL = 'https://impotekno.com/catalogo_imptk.php?rub=99999'
BASE_URL     = 'https://impotekno.com'


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

def make_sku(codigo, name, index):
    if codigo and codigo != 'No disponible':
        return normalize_sku(codigo)
    # Fallback: usar el índice numérico como código único (sin prefijo ni slugs)
    return str(index)


def scrape(driver):
    print(f'📦 Cargando catálogo Impotekno: {CATALOG_URL}', file=sys.stderr)
    driver.get(CATALOG_URL)

    try:
        WebDriverWait(driver, 45).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'div.caja_producto'))
        )
        time.sleep(5)
    except Exception:
        print('⚠️ Timeout esperando productos — continuando...', file=sys.stderr)

    # Scroll para activar lazy loading
    driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
    time.sleep(3)

    product_elements = driver.find_elements(By.CSS_SELECTOR, 'div.caja_producto')
    print(f'📦 {len(product_elements)} productos encontrados', file=sys.stderr)

    count = 0
    for i, elem in enumerate(product_elements):
        try:
            try:
                name = elem.find_element(By.CSS_SELECTOR, 'div#descrip h1').text.strip()
            except:
                name = None
            if not name or name == 'No disponible':
                continue

            codigo    = None
            rubro     = 'Sin Categoría'
            try:
                texto_completo = elem.find_element(By.CSS_SELECTOR, 'div#texto').text
                for linea in texto_completo.split('\n'):
                    linea = linea.strip()
                    if linea.startswith('Codigo:'):
                        codigo = linea.replace('Codigo:', '').strip()
                    elif linea.startswith('Rubro:'):
                        temp = linea.replace('Rubro:', '').strip()
                        rubro = temp.split('(')[0].strip()
            except:
                pass

            raw_price = None
            try:
                price_text = elem.find_element(By.CSS_SELECTOR, 'strong.caja_precio').text.strip()
                raw_price = clean_price(price_text)
            except:
                pass

            image_url = None
            try:
                src = elem.find_element(By.CSS_SELECTOR, 'div#foto img').get_attribute('src') or ''
                image_url = src if src.startswith('http') else f'{BASE_URL}/{src.lstrip("/")}'
            except:
                pass

            sku = make_sku(codigo, name, i)

            product = {
                'sku':             sku,
                'name':            name,
                'raw_price':       raw_price,
                'offer_price':     None,
                'image_url':       image_url,
                'product_url':     None,
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
    driver = None

    def shutdown(signum, frame):
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
