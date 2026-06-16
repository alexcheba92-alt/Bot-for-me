const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 300000; // 5 минут
const SEEN_FILE = './seen.json';

const BASE_URL = 'https://www.inberlinwohnen.de';
const SEARCH_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/';

let knownApartments = new Map();
let isFirstRun = true;

function load() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
            knownApartments = new Map(data);
            isFirstRun = false;
            console.log(`📂 База данных загружена. Квартир в памяти: ${knownApartments.size}`);
        }
    } catch (e) {}
}

function save() {
    try { 
        fs.writeFileSync(SEEN_FILE, JSON.stringify([...knownApartments]), 'utf8'); 
    } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '📋 Открыть квартиру', url }]] };
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Сообщение отправлено в Telegram');
    } catch (e) { 
        console.error('❌ Ошибка TG:', e.message); 
    }
}

async function getApartments() {
    console.log('🌐 Запуск браузера...');
    const browser = await chromium.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
        ...devices['iPhone 13 Pro'],
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    const page = await context.newPage();

    try {
        // Шаг 1: Логин
        console.log('Переход на страницу авторизации...');
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        // Принимаем куки
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        if (await page.isVisible('input[name="email"]')) {
            console.log('Ввожу логин и пароль...');
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);
        }

        // Шаг 2: Переход в поисковик (где уже применены твои личные фильтры)
        console.log('Открываю Wohnungsfinder...');
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);

        // === ОБРАБОТКА КАПЧИ ===
        const captchaVisible = await page.locator('iframe[src*="captcha"], div[id*="captcha"], .g-recaptcha, #challenge-form').isVisible({ timeout: 2000 }).catch(() => false);
        if (captchaVisible) {
            console.log('⚠️ Обнаружена капча! Пропускаем круг.');
            return null; // Возвращаем null, чтобы отличить капчу от "реально 0 квартир"
        }

        // Шаг 3: Сбор ссылок
        console.log('Парсим результаты...');
        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href ? a.href.trim() : '';
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
                
                if (href && href.includes('/expose/')) {
                    const match = href.match(/expose\/([^/?#]+)/);
                    const id = match ? match[1] : href;
                    results.push({ id, href, text: text.substring(0, 100) || 'Квартира' });
                }
            });
            return results;
        });

        const unique = new Map();
        for (const apt of apartments) {
            if (!unique.has(apt.id)) unique.set(apt.id, apt);
        }
        
        console.log(`Найдено актуальных квартир на странице: ${unique.size}`);
        return unique;

    } catch (e) {
        console.error('❌ Ошибка парсинга:', e.message);
        return null;
    } finally {
        await browser.close();
    }
}

async function check() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`\n[${now}] === Запуск проверки ===`);

    const current = await getApartments();
    
    // Если словили ошибку или капчу (вернулся null) — просто выходим
    if (current === null) {
        console.log('Пропускаем круг из-за ошибки или капчи.');
        return;
    }

    // Если это самый первый запуск
    if (isFirstRun) {
        knownApartments = current;
        isFirstRun = false;
        save();
        await sendTelegram(`🤖 Бот успешно запущен!\nВ базе сохранено квартир: <b>${knownApartments.size}</b>. Отслеживаю изменения...`);
        return;
    }

    // Проверяем новинки
    for (const [id, apt] of current) {
        if (!knownApartments.has(id)) {
            await sendTelegram(`🏠 <b>Новая квартира!</b>\n\n📝 <i>${apt.text}...</i>`, apt.href);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // Обновляем базу данных
    knownApartments = current;
    save();
}

async function main() {
    load();
    console.log('🤖 Бот запущен');
    await check();
    setInterval(check, CHECK_INTERVAL);
}

main().catch(console.error);
