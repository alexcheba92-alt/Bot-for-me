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
        console.log(`[${new Date().toLocaleTimeString()}] Telegram уведомление отправлено`);
    } catch (error) {
        console.error("Ошибка отправки в Telegram:", error.message);
    }
}

// Основная функция парсинга
async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString()}] Проверяю сайт... (уже известно ${memorySeenApartments.size} квартир)`);
    
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
            
            // Нажимаем кнопку и ждем, пока страница полностью перезагрузится (вернет на главную)
            await Promise.all([
                page.click('button[type="submit"], input[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
            ]);

            console.log("Форма отправлена. Перезагрузка завершена.");
            await page.waitForTimeout(2000); // Небольшая пауза для надежности сессии
        }

        // ШАГ 3: Теперь принудительно переходим по прямой ссылке в личный Wohnungsfinder
        console.log(`Перехожу по прямой ссылке: ${APARTMENTS_URL}`);
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 40000 });
        
        // Ждем подгрузки результатов и даем 4 секунды скриптам отфильтровать квартиры
        await page.waitForSelector('.tb-wfinder__results, #wfinder-list, a[href*="/expose/"]', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(4000);

        // ШАГ 4: Сбор всех найденных квартир
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
            console.log(`[Первый запуск] Успешно залогинились и запомнили ${memorySeenApartments.size} квартир.`);
        } else if (newCount > 0) {
            console.log(`🏠 Найдено ${newCount} новых квартир!`);
        } else {
            console.log("Новых квартир нет.");
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
    await sendTelegram("🤖 <b>Бот успешно обновлен!</b>\nНастроена правильная цепочка переходов: Вход -> Главная -> Личный поиск.");
    
    await checkApartments();
    
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
