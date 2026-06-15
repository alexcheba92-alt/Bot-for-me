const { chromium, devices } = require('playwright');
const axios = require('axios');

// ==========================================
// НАСТРОЙКИ (Берутся из переменных Railway)
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "ВАШ_ТОКЕН_БОТА";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "ВАШ_CHAT_ID";
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL || "ваш@email.com";
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD || "ваш_пароль";
const CHECK_INTERVAL = 300000; // 5 минут

const BASE_URL = 'https://www.inberlinwohnen.de';
const APARTMENTS_URL = "https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkZWejd0ZFlVSEljbWU1Z0hXT0tmMmc9PSIsInZhbHVlIjoia2lIczRQQUt4VWVYOXJ2U0Y5TTlDc2JadDZzTEtRRk1RK3E0QlFkc29ub3NFSk5McWtncHBoOVVRT0txTDNleVVZalMyZ0RFc3dQdHRwQ2kzaVhqdnczTVV3ZWtmT1FoZDRkU09tL0E4QVhTY1ExUEtGZFlkaDFEVkR5RitzVTRpWHBsUmlFMS80SUNsQ25iaEVjR25zNUZNRmVEUkE4aSszNE1kd3hIdVIwSlFuc0ZxaUxFclJPZDVoMTdWR3RpRVp4cmRoZFd1bGxYaUhXVjUxYXV6Rm41amRrazBJRmlEYUpPNmEwZVFsSWFBRkR0b3dpL1MxL2VRWm5MbHczVDNHV25xemV0R3lTalo4SVpoUzJrRk1CTG5vdUdjTldIemFDYkF2OC9NdTU2OFJLbEIvY3NuY2pRbHo2Y01aOW1hQUNGT1NhSy8xV3dEaHdoV3dVeXJVaHBldnRlU0lpRkVuek5SWlpyTHVKMmF6WlA0YXdaUXcvSkFQSldtcWh4ZnJYUWljRDVmdC82a2s4d1htNFpxNkVEWFAwbGNBdjNBSnRENkFFV2k0aXQxbm1YNjZwc1VhREFPb2pLUUpZVCIsIm1hYyI6IjhhZTViZjViMDM2YWNiYWY1YzEwNGIwODQzN2Y0NzZjMGYxNzgxZGRmNTI5OTNiNjg0ZWQ3NDM5NjU2ZTA3MDEiLCJ0YWciOiIifQ%3D%3D"; 

const memorySeenApartments = new Set();

async function sendTelegram(text, url = null) {
    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть на сайте', url: url }]] };
    }
    try {
        await axios.post(apiUrl, payload, { timeout: 10000 });
    } catch (error) {
        console.error("Ошибка Telegram:", error.message);
    }
}

async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString()}] Проверка сайта (режим iPhone)...`);
    
    const browser = await chromium.launch({ headless: true });
    
    // МАСКИРОВКА: заставляем Playwright полностью имитировать iPhone 13 Pro
    const iPhone = devices['iPhone 13 Pro'];
    const context = await browser.newContext({
        ...iPhone,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
    });
    
    const page = await context.newPage();

    try {
        // Логин
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'networkidle', timeout: 50000 });
        
        const cookieButtons = ['button:has-text("Auswahl erlauben")', 'button:has-text("Alle akzeptieren")', '#uc-btn-accept-banner'];
        for (const selector of cookieButtons) {
            try {
                if (await page.isVisible(selector)) {
                    await page.click(selector);
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (e) {}
        }

        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await Promise.all([
                page.click('button[type="submit"], input[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 40000 }).catch(() => {})
            ]);
            console.log("Авторизация выполнена.");
            await page.waitForTimeout(3000);
        }

        // Переход к результатам поиска
        console.log("Загружаю зашифрованную ссылку с фильтрами...");
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 50000 });
        
        // Ждем подольше, чтобы мобильная карта и карточки прогрузились
        await page.waitForTimeout(7000);

        // Улучшенный сбор ссылок (ищет вообще любые упоминания /expose/)
        const uniqueHrefs = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links
                .map(a => a.href)
                .filter(href => href && href.includes('/expose/'));
        });

        const cleanUrls = [...new Set(uniqueHrefs)];
        let newCount = 0;
        const isFirstRun = (memorySeenApartments.size === 0);

        for (const href of cleanUrls) {
            const match = href.match(/\/expose\/([0-9]+)/);
            const aptId = match ? match[1] : href;

            if (aptId && !memorySeenApartments.has(aptId)) {
                memorySeenApartments.add(aptId);
                
                if (!isFirstRun) {
                    newCount++;
                    const timestamp = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    const msg = `🏠 <b>Новая квартира нашлася!</b>\n\n⏰ ${timestamp}`;
                    await sendTelegram(msg, href);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (isFirstRun) {
            console.log(`[Успешно] Мобильная верстка считана! Найдено и сохранено старых квартир: ${memorySeenApartments.size}`);
            // Отправим тестовое сообщение в ТГ, чтобы ты видел, что база не пустая
            await sendTelegram(`🤖 Бот видит мобильную версию сайта! Первично занесено в память: ${memorySeenApartments.size} квартир.`);
        } else if (newCount > 0) {
            console.log(`Найдено новых квартир: ${newCount}`);
        } else {
            console.log("Новых квартир пока нет.");
        }

    } catch (error) {
        console.error("Ошибка парсинга:", error.message || error);
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log("🤖 Бот запущен в режиме iPhone эмуляции!");
    await checkApartments();
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
