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

// Вставили твою точную ссылку с зашифрованными фильтрами
const APARTMENTS_URL = "https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkZWejd0ZFlVSEljbWU1Z0hXT0tmMmc9PSIsInZhbHVlIjoia2lIczRQQUt4VWVYOXJ2U0Y5TTlDc2JadDZzTEtRRk1RK3E0QlFkc29ub3NFSk5McWtncHBoOVVRT0txTDNleVVZalMyZ0RFc3dQdHRwQ2kzaVhqdnczTVV3ZWtmT1FoZDRkU09tL0E4QVhTY1ExUEtGZFlkaDFEVkR5RitzVTRpWHBsUmlFMS80SUNsQ25iaEVjR25zNUZNRmVEUkE4aSszNE1kd3hIdVIwSlFuc0ZxaUxFclJPZDVoMTdWR3RpRVp4cmRoZFd1bGxYaUhXVjUxYXV6Rm41amRrazBJRmlEYUpPNmEwZVFsSWFBRkR0b3dpL1MxL2VRWm5MbHczVDNHV25xemV0R3lTalo4SVpoUzJrRk1CTG5vdUdjTldIemFDYkF2OC9NdTU2OFJLbEIvY3NuY2pRbHo2Y01aOW1hQUNGT1NhSy8xV3dEaHdoV3dVeXJVaHBldnRlU0lpRkVuek5SWlpyTHVKMmF6WlA0YXdaUXcvSkFQSldtcWh4ZnJYUWljRDVmdC82a2s4d1htNFpxNkVEWFAwbGNBdjNBSnRENkFFV2k0aXQxbm1YNjZwc1VhREFPb2pLUUpZVCIsIm1hYyI6IjhhZTViZjViMDM2YWNiYWY1YzEwNGIwODQzN2Y0NzZjMGYxNzgxZGRmNTI5OTNiNjg0ZWQ3NDM5NjU2ZTA3MDEiLCJ0YWciOiIifQ%3D%3D"; 

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

            console.log("Успешно авторизовались.");
            await page.waitForTimeout(2000);
        }

        // ШАГ 3: Переходим СРАЗУ на страницу с зашифрованными фильтрами
        console.log("Загружаю страницу поиска с фильтрами...");
        await page.goto(APARTMENTS_URL, { waitUntil: 'networkidle', timeout: 40000 });
        
        // Даем сайту 5 секунд спокойно дорендерить карточки
        await page.waitForTimeout(5000);

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
            console.log(`[Первый запуск] Скрипт успешно проверил страницу. Сохранено в память: ${memorySeenApartments.size} квартир.`);
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
    await sendTelegram("🤖 <b>Бот успешно обновлен!</b>\nПоиск переведен на шифрованный URL с вашими фильтрами.");
    
    await checkApartments();
    
    setInterval(async () => {
        await checkApartments();
    }, CHECK_INTERVAL);
}

main();
