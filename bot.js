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
    } catch (error) {
        console.error("Ошибка отправки в Telegram:", error.message);
    }
}

// Основная функция парсинга
async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString()}] Запуск новой сессии проверки...`);
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 1024 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // ШАГ 1: Заходим на страницу логина
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'networkidle', timeout: 40000 });
        
        // Обход куки
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

        // ШАГ 2: Вводим данные и логинимся
        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            
            console.log("Данные введены, нажимаю кнопку войти...");
            
            await Promise.all([
                page.click('button[type="submit"], input[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
            ]);

            console.log("Успешно авторизовались. Переходим к поиску...");
            await page.waitForTimeout(2000);
        }

        // ШАГ 3: Переходим в Wohnungsfinder
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 40000 });
        await page.waitForTimeout(3000);

        // ШАГ 4: ОТКРЫВАЕМ И ВЫСТАВЛЯЕМ ФИЛЬТРЫ (Как на твоем скриншоте)
        console.log("Настраиваю фильтры поиска...");
        
        // Кликаем по кнопке с лупой, чтобы развернуть панель фильтров (если она скрыта)
        const filterButton = await page.$('.tb-wfinder__toggle-filter, button.criteria-toggle, .wfinder-filter-toggle');
        if (filterButton) {
            await filterButton.click();
            await page.waitForTimeout(1000);
        }

        // Заполняем максимальную стоимость: 600.00
        // Ищем поле по имени переменной стоимости (обычно q[miete_max] или похожее) или по id/placeholder
        const mieteInput = await page.$('input[name*="miete_max"], input[id*="miete_max"], #nettokaltmiete_max');
        if (mieteInput) {
            await mieteInput.click({ clickCount: 3 }); // Выделяем старое значение
            await mieteInput.type('600.00');
        }

        // Выставляем количество комнат: от 3 до 3
        const zimmerMin = await page.$('select[name*="zimmer_min"], input[name*="zimmer_min"], #zimmer_min');
        const zimmerMax = await page.$('select[name*="zimmer_max"], input[name*="zimmer_max"], #zimmer_max');
        
        if (zimmerMin && zimmerMax) {
            // Если это выпадающий список (select)
            if ((await zimmerMin.tagName()) === 'SELECT') {
                await zimmerMin.selectOption('3');
                await zimmerMax.selectOption('3');
            } else {
                // Если это обычное текстовое поле ввода
                await zimmerMin.click({ clickCount: 3 }); await zimmerMin.type('3');
                await zimmerMax.click({ clickCount: 3 }); await zimmerMax.type('3');
            }
        }

        // Нажимаем кнопку «Wohnung suchen» (Применить фильтр)
        console.log("Применяю фильтры...");
        const searchSubmit = await page.$('button:has-text("Wohnung suchen"), input[value="Wohnung suchen"], .tb-wfinder__submit');
        if (searchSubmit) {
            await searchSubmit.click();
        } else {
            // Если кнопку не нашли по тексту, жмем Enter в поле цены
            if (mieteInput) await mieteInput.press('Enter');
        }

        // Ожидаем обновления результатов
        await page.waitForTimeout(5000);

        // ШАГ 5: Сбор всех отфильтрованных квартир
        const apartmentLinks = await page.$$eval('a[href*="/expose/"]', links => {
            return links.map(link => ({ href: link.href }));
        });

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
            console.log(`[Первый запуск] Скрипт применил фильтры. Сохранено в память: ${memorySeenApartments.size} квартир.`);
        } else if (newCount > 0) {
            console.log(`🏠 Найдено ${newCount} новых квартир!`);
        } else {
            console.log("Новых вариантов по фильтрам не обнаружено.");
        }

    } catch (error) {
        console.error("Ошибка во время выполнения проверки:", error.message || error);
    } finally {
        await browser.close();
    }
}

// Главный цикл
async function main() {
    console.log("🤖 Бот запущен!");
    await sendTelegram("🤖 <b>Бот успешно обновлен!</b>\nВнедрен блок автоматического заполнения фильтров поиска (600€ / 3 комнаты).");
    
    await checkApartments();
    
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
