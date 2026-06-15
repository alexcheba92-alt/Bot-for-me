const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// НАСТРОЙКИ (Берутся из переменных Railway)
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "ВАШ_ТОКЕН_БОТА";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "ВАШ_CHAT_ID";
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL || "ваш@email.com";
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD || "ваш_пароль";
const CHECK_INTERVAL = 300000; // 5 минут в миллисекундах

const SEEN_FILE = path.join(__dirname, 'seen_apartments.json');
const BASE_URL = 'https://www.inberlinwohnen.de';
const APARTMENTS_URL = `${BASE_URL}/wohnungsfinder/`;

// Загрузка базы известных квартир
let seenApartments = new Set();
if (fs.existsSync(SEEN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        seenApartments = new Set(data);
    } catch (e) {
        console.error("Ошибка чтения файла seen_apartments.json:", e);
    }
}

function saveSeen() {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(seenApartments)), 'utf8');
}

// Отправка уведомления в Telegram
async function sendTelegram(text, url = null) {
    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
    };

    if (url) {
        payload.reply_markup = {
            inline_keyboard: [[
                { text: '🔗 Открыть на сайте', url: url }
            ]]
        };
    }

    try {
        await axios.post(apiUrl, payload, { timeout: 10000 });
        console.log(`[${new Date().toLocaleTimeString()}] Telegram уведомление отправлено`);
    } catch (error) {
        console.error("Ошибка отправки в Telegram:", error.message);
    }
}

// Основная функция парсинга через реальный браузер
async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString()}] Проверяю сайт... (уже известно ${seenApartments.size} квартир)`);
    
    // Запуск headless-браузера
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // 1. Авторизация
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'networkidle', timeout: 30000 });
        
        // Заполняем форму, если она есть
        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"], input[type="submit"]');
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            console.log("Выполнен вход в аккаунт");
        }

        // 2. Переход к поиску квартир
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 });
        
        // Ждем подгрузки элементов списка (карта и карточки)
        await page.waitForSelector('.tb-wfinder__results-item, article, [class*="item"]', { timeout: 10000 }).catch(() => {});

        // 3. Сбор элементов квартир
        const apartmentLinks = await page.$$eval('a[href*="/expose/"], a[href*="/wohnung/"]', links => {
            return links.map(link => ({
                href: link.href,
                title: link.innerText.trim() || "Спецификации внутри ссылки"
            }));
        });

        let newCount = 0;

        for (const apt of apartmentLinks) {
            const match = apt.href.match(/\/([0-9]+)\/?$/);
            const aptId = match ? match[1] : apt.href;

            if (aptId && !seenApartments.has(aptId)) {
                seenApartments.add(aptId);
                newCount++;

                const timestamp = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                const msg = `🏠 <b>Новая квартира!</b>\n\n⏰ ${timestamp}`;
                
                await sendTelegram(msg, apt.href);
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        if (newCount > 0) {
            console.log(`🏠 Найдено ${newCount} новых квартир!`);
            saveSeen();
        } else {
            console.log("Новых квартир нет.");
        }

    } catch (error) {
        console.error("Ошибка во время выполнения проверки:", error);
    } finally {
        await browser.close();
    }
}

// Главный цикл
async function main() {
    console.log("🤖 Бот на Node.js запущен!");
    await sendTelegram("🤖 <b>Бот успешно перезапущен на JS!</b>\nИспользую браузерный движок для точного поиска квартир.");
    
    await checkApartments();
    
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
