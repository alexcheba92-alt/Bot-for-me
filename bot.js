const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 300000; // 5 минут
const SEEN_FILE = './seen.json'; // Сохраняем в корень проекта, чтобы не стиралось в /tmp

const BASE_URL = 'https://www.inberlinwohnen.de';
// Возвращаем нормальный, чистый URL живого поисковика
const SEARCH_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/';

let knownApartments = new Map();
let isFirstRun = true;

// Загрузка кэша квартир
function load() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
            knownApartments = new Map(data);
            isFirstRun = false;
            console.log(`📂 База данных загружена. Квартир в памяти: ${knownApartments.size}`);
        }
    } catch (e) {
        console.error('Ошибка загрузки базы:', e.message);
    }
}

// Сохранение кэша
function save() {
    try { 
        fs.writeFileSync(SEEN_FILE, JSON.stringify([...knownApartments]), 'utf8'); 
    } catch (e) { 
        console.error('Ошибка сохранения базы:', e.message); 
    }
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '📋 Открыть и подать заявку', url }]] };
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Telegram отправлено');
    } catch (e) { 
        console.error('❌ TG Error:', e.message); 
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
        // Шаг 1: Идём на логин
        console.log('Переход на страницу авторизации...');
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Принимаем куки кувалдой
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        // Логинимся
        if (await page.isVisible('input[name="email"]')) {
            console.log('Ввожу логин и пароль...');
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);
        }

        // Шаг 2: Переход на чистый Wohnungsfinder
        console.log('Открываю Wohnungsfinder...');
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Автоматически прожимаем фильтры (3 комнаты до 600 евро), если они сбросились
        console.log('Проверяем и выставляем фильтры...');
        const mieteInput = page.locator('input[name*="miete_bis"], input[id*="miete_bis"]').last();
        if (await mieteInput.isVisible({ timeout: 3000 })) {
            await mieteInput.fill('600');
            await page.locator('input[name*="zimmer_von"]').first().fill('3');
            await page.locator('input[name*="zimmer_bis"]').first().fill('3');
            await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').first().click();
            await page.waitForTimeout(8000);
        }

        // === ОБРАБОТКА КАПЧИ ===
        const captchaVisible = await page.locator('iframe[src*="captcha"], div[id*="captcha"], .g-recaptcha, #challenge-form').isVisible({ timeout: 3000 }).catch(() => false);
        if (captchaVisible) {
            console.log('⚠️ Обнаружена капча! Пропускаем круг.');
            return new Map();
        }

        // Шаг 3: Надежный сбор квартир по тегу /expose/
        console.log('Парсим результаты...');
        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href ? a.href.trim() : '';
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
                
                // Ищем только прямые ссылки на expose
                if (href && href.includes('/expose/')) {
                    const match = href.match(/expose\/([^/?#]+)/);
                    const id = match ? match[1] : href;
                    results.push({ id, href, text: text.substring(0, 120) || 'Квартира' });
                }
            });
            return results;
        });

        // Собираем в Map для уникальности
        const unique = new Map();
        for (const apt of apartments) {
            if (!unique.has(apt.id)) {
                unique.set(apt.id, apt);
            }
        }
        
        console.log(`Найдено актуальных квартир на странице: ${unique.size}`);
        return unique;

    } catch (e) {
        console.error('❌ Ошибка внутри getApartments:', e.message);
        return new Map();
    } finally {
        await browser.close();
    }
}

async function check() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`\n[${now}] === Запуск проверки ===`);

    const current = await getApartments();
    
    // Если словили ошибку сети или капчу — не перезаписываем базу пустой картой!
    if (current.size === 0) { 
        console.log('Сайт вернул 0 квартир (возможно капча или сбой). Пропускаем.'); 
        return; 
    }

    // Если это самый первый запуск бота
    if (isFirstRun) {
        knownApartments = current;
        isFirstRun = false;
        save();
        await sendTelegram(`🤖 Бот успешно запущен!\nВ базе сохранено квартир: <b>${knownApartments.size}</b>. Отслеживаю изменения...`);
        return;
    }

    // Проверяем новые квартиры
    for (const [id, apt] of current) {
        if (!knownApartments.has(id)) {
            await sendTelegram(`🏠 <b>Новая квартира на горизонте!</b>\n\n📝 Описание: <i>${apt.text}...</i>`, apt.href);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // Проверяем, сколько ушло с рынка (опционально)
    let gone = 0;
    for (const [id] of knownApartments) {
        if (!current.has(id)) gone++;
    }
    if (gone > 0) {
        console.log(`📉 Снято с публикации объявлений: ${gone}`);
    }

    // Обновляем память и сохраняем на диск
    knownApartments = current;
    save();
}

async function main() {
    load();
    console.log('🤖 Бof запущен и готов к работе...');
    await check();
    setInterval(check, CHECK_INTERVAL);
}

main().catch(console.error);
