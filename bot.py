import os
import json
import time
import logging
import requests
from bs4 import BeautifulSoup
from datetime import datetime

# ==========================================
# НАСТРОЙКИ — заполни эти строки!
# ==========================================
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "ВАШ_ТОКЕН_БОТА")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "ВАШ_CHAT_ID")
INBERLIN_EMAIL = os.getenv("INBERLIN_EMAIL", "ваш@email.com")
INBERLIN_PASSWORD = os.getenv("INBERLIN_PASSWORD", "ваш_пароль")
CHECK_INTERVAL = 300  # проверка каждые 5 минут (в секундах)
# ==========================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

SEEN_FILE = "seen_apartments.json"
BASE_URL = "https://www.inberlinwohnen.de"
APARTMENTS_URL = f"{BASE_URL}/wohnungsfinder/"


def load_seen() -> set:
    if os.path.exists(SEEN_FILE):
        with open(SEEN_FILE, "r") as f:
            return set(json.load(f))
    return set()


def save_seen(seen: set):
    with open(SEEN_FILE, "w") as f:
        json.dump(list(seen), f)


def send_telegram(text: str, url: str = None):
    """Отправляет сообщение в Telegram."""
    api_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }
    
    if url:
        payload["reply_markup"] = json.dumps({
            "inline_keyboard": [[
                {"text": "🔗 Открыть на сайте", "url": url}
            ]]
        })
    
    try:
        resp = requests.post(api_url, json=payload, timeout=10)
        resp.raise_for_status()
        log.info("Telegram уведомление отправлено")
    except Exception as e:
        log.error(f"Ошибка отправки в Telegram: {e}")


def get_session() -> requests.Session:
    """Создаёт сессию и логинится на сайте."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    
    # Получаем страницу логина для CSRF токена
    login_page = session.get(f"{BASE_URL}/login/", timeout=15)
    soup = BeautifulSoup(login_page.text, "html.parser")
    
    csrf_token = None
    csrf_input = soup.find("input", {"name": "_token"})
    if csrf_input:
        csrf_token = csrf_input.get("value")
    
    # Логинимся
    login_data = {
        "email": INBERLIN_EMAIL,
        "password": INBERLIN_PASSWORD,
        "_token": csrf_token or "",
    }
    
    resp = session.post(f"{BASE_URL}/login/", data=login_data, timeout=15)
    
    if "logout" in resp.text.lower() or resp.status_code == 200:
        log.info("Успешный вход на сайт")
    else:
        log.warning("Возможно вход не удался, продолжаем...")
    
    return session


def fetch_apartments(session: requests.Session) -> list:
    """Получает список квартир со страницы."""
    try:
        resp = session.get(APARTMENTS_URL, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        log.error(f"Ошибка загрузки страницы: {e}")
        return []
    
    soup = BeautifulSoup(resp.text, "html.parser")
    apartments = []
    
    # Ищем блоки с квартирами (селекторы под структуру сайта)
    selectors = [
        ".wohnungsfinder-item",
        ".apartment-item", 
        ".wohnung-item",
        "[class*='wohnung']",
        ".expose-item",
        "article",
    ]
    
    items = []
    for selector in selectors:
        items = soup.select(selector)
        if items:
            log.info(f"Найдено {len(items)} элементов по селектору: {selector}")
            break
    
    for item in items:
        # Пробуем извлечь ссылку
        link = item.find("a", href=True)
        href = link["href"] if link else ""
        if href and not href.startswith("http"):
            href = BASE_URL + href
        
        # ID квартиры из ссылки или текста
        apt_id = href.split("/")[-2] if href else item.get("data-id", "")
        
        if not apt_id:
            # Fallback: хэш от текста блока
            apt_id = str(hash(item.get_text(strip=True)[:100]))
        
        # Извлекаем текст для уведомления
        title = ""
        title_el = item.find(["h2", "h3", "h4", ".title", ".name"])
        if title_el:
            title = title_el.get_text(strip=True)
        
        if not title:
            title = item.get_text(strip=True)[:80]
        
        apartments.append({
            "id": apt_id,
            "title": title,
            "url": href or APARTMENTS_URL,
        })
    
    return apartments


def check_once(session: requests.Session, seen: set) -> tuple[list, set]:
    """Одна проверка — возвращает новые квартиры и обновлённый seen."""
    apartments = fetch_apartments(session)
    new_ones = []
    
    for apt in apartments:
        if apt["id"] and apt["id"] not in seen:
            new_ones.append(apt)
            seen.add(apt["id"])
    
    return new_ones, seen


def main():
    log.info("🤖 Бот запущен!")
    send_telegram("🤖 <b>Бот запущен!</b>\nБуду проверять inberlinwohnen.de каждые 5 минут и сообщу о новых квартирах.")
    
    seen = load_seen()
    session = None
    
    while True:
        try:
            # Обновляем сессию каждые 30 минут (на случай истечения)
            if session is None:
                session = get_session()
            
            log.info(f"Проверяю сайт... (уже известно {len(seen)} квартир)")
            new_apts, seen = check_once(session, seen)
            
            if new_apts:
                log.info(f"🏠 Найдено {len(new_apts)} новых квартир!")
                for apt in new_apts:
                    msg = (
                        f"🏠 <b>Новая квартира!</b>\n\n"
                        f"{apt['title']}\n\n"
                        f"⏰ {datetime.now().strftime('%d.%m.%Y %H:%M')}"
                    )
                    send_telegram(msg, apt["url"])
                    time.sleep(1)  # пауза между сообщениями
                
                save_seen(seen)
            else:
                log.info("Новых квартир нет.")
        
        except Exception as e:
            log.error(f"Ошибка в основном цикле: {e}")
            session = None  # сбрасываем сессию при ошибке
        
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
