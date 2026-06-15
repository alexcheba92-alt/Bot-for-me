const { chromium } = require('playwright');
const axios = require('axios');

// ==========================================
// НАСТРОЙКИ (Берутся из переменных Railway)
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "ВАШ_ТОКЕН_БОТА";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "ВАШ_CHAT_ID";
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL || "ваш@email.com";
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD || "ваш_пароль";
const CHECK_INTERVAL = 300000; // 5 минут в миллисекундах

const BASE_URL = 'https://www.inberlinwohnen.de';
// ИСПРАВЛЕНО: Теперь ведем бота строго в личный кабинет к твоим фильтрам!
const APARTMENTS_URL = `${BASE_URL}/mein-bereich/wohnungsfinder/`;

// Храним базу прямо в оперативной памяти процесса
const memorySeenApartments = new Set();

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

// Основная функция парсинга
async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString()}] Проверяю личный кабинет... (уже известно ${memorySeenApartments.size} квартир)`);
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // 1. Открываем страницу авторизации
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'networkidle', timeout: 40000 });
        
        // Обход баннера куки
        const cookieButtons = [
            'button:has-text("Auswahl erlauben")',
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            '#uc-btn-accept-banner'
        ];
        
        for (const selector of cookieButtons) {
            try {
                if (await page.isVisible(selector)) {
                    await page.click(selector);
                    console.log("Всплывающий баннер куки успешно закрыт.");
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (e) {}
        }

        // 2. Заполняем форму авторизации
        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            
            // Кликаем войти и ждем перезагрузки
            await Promise.all([
                page.click('button[type="submit"], input[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
            ]);

            // Проверяем, зашли ли
            await page.waitForSelector('.ma-menu, a[href*="logout"], .user-nav, button:has-text("Log out")', { timeout: 15000 })
                .then(() => console.log("Успешный вход! Загружаем личные фильтры..."))
                .catch(() => console.log("Предупреждение: Профиль не распознан, но пробуем перейти к квартирам..."));
        }

        // 3. Переход строго в твой Wohnungsfinder
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 40000 });
        
        // Ждем загрузки карточек квартир
        await page.waitForSelector('.tb-wfinder__results, #wfinder-list, a[href*="/expose/"]', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(4000); // Даем 4 секунды на подгрузку скриптов фильтрации

        // 4. Собираем все ссылки на expose
        const apartmentLinks = await page.$$eval('a[href*="/expose/"]', links => {
            return links.map(link => ({
                href: link.href
            }));
        });

        // Убираем дубликаты ссылок
        const uniqueHrefs = [...new Set(apartmentLinks.map(apt => apt.href))];
        
        let newCount = 0;
        const isFirstRun = (memorySeenApartments.size === 0);

        for (const href of uniqueHrefs) {
            const match = href.match(/\/expose\/([0-9]+)/);
            const aptId = match ? match[1] : href;

            if (aptId && !memorySeenApartments.has(aptId)) {
                memorySeenApartments.add(aptId);
                
                if (!isFirstRun) {
                    newCount++;
                    const timestamp = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    const msg = `🏠 <b>Новая квартира!</b>\n\n⏰ ${timestamp}`;
                    await sendTelegram(msg, href);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
        }

        if (isFirstRun) {
            console.log(`[Первый запуск] Успешно запомнили ${memorySeenApartments.size} личных квартир. Защита от спама активна.`);
        } else if (newCount > 0) {
            console.log(`🏠 Найдено ${newCount} новых личных квартир!`);
        } else {
            console.log("Новых квартир по вашим фильтрам нет.");
        }

    } catch (error) {
        console.error("Ошибка во время выполнения проверки:", error.message || error);
    } finally {
        await browser.close();
    }
}

// Главный цикл
async function main() {
    console.log("🤖 Бот на Node.js запущен!");
    await sendTelegram("🤖 <b>Бот успешно обновлен!</b>\nПуть изменен на личный кабинет (/mein-bereich/).");
    
    await checkApartments();
    
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
