const { chromium, devices } = require('playwright');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const CHECK_INTERVAL = 300000; // 5 минут

const BASE_URL = 'https://www.inberlinwohnen.de';

// ИСПРАВЛЕНО: Твой крутой код + твоя зашифрованная ссылка с фильтрами
const SEARCH_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkZWejd0ZFlVSEljbWU1Z0hXT0tmMmc9PSIsInZhbHVlIjoia2lIczRQQUt4VWVYOXJ2U0Y5TTlDc2JadDZzTEtRRk1RK3E0QlFkc29ub3NFSk5McWtncHBoOVVRT0txTDNleVVZalMyZ0RFc3dQdHRwQ2kzaVhqdnczTVV3ZWtmT1FoZDRkU09tL0E4QVhTY1ExUEtGZFlkaDFEVkR5RitzVTRpWHBsUmlFMS80SUNsQ25iaEVjR25zNUZNRmVEUkE4aSszNE1kd3hIdVIwSlFuc0ZxaUxFclJPZDVoMTdWR3RpRVp4cmRoZFd1bGxYaUhXVjUxYXV6Rm41amRrazBJRmlEYUpPNmEwZVFsSWFBRkR0b3dpL1MxL2VRWm5MbHczVDNHV25xemV0R3lTalo4SVpoUzJrRk1CTG5vdUdjTldIemFDYkF2OC9NdTU2OFJLbEIvY3NuY2pRbHo2Y01aOW1hQUNGT1NhSy8xV3dEaHdoV3dVeXJVaHBldnRlU0lpRkVuek5SWlpyTHVKMmF6WlA0YXdaUXcvSkFQSldtcWh4ZnJYUWljRDVmdC82a2s4d1htNFpxNkVEWFAwbGNBdjNBSnRENkFFV2k0aXQxbm1YNjZwc1VhREFPb2pLUUpZVCIsIm1hYyI6IjhhZTViZjViMDM2YWNiYWY1YzEwNGIwODQzN2Y0NzZjMGYxTzgxZGRmNTI5OTNiNjg0ZWQ3NDM5NjU2ZTA3MDEiLCJ0YWciOiIifQ%3D%3D';

const seen = new Set();

async function sendTelegram(text, url = null) {
    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML'
    };
    if (url) {
        payload.reply_markup = {
            inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]]
        };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload, { timeout: 10000 });
        console.log('Telegram: сообщение отправлено');
    } catch (e) {
        console.error('Telegram ошибка:', e.message);
    }
}

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск проверки...`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Эмулируем iPhone чтобы сайт не блокировал
    const iPhone = devices['iPhone 13 Pro'];
    const context = await browser.newContext({
        ...iPhone,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    const page = await context.newPage();

    try {
        // Шаг 1: Логин
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Закрываем cookie баннер если есть
        for (const sel of ['#uc-btn-accept-banner', 'button:has-text("Alle akzeptieren")', 'button:has-text("Auswahl erlauben")']) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (_) {}
        }

        // Вводим логин и пароль
        try {
            await page.fill('input[name="email"]', INBERLIN_EMAIL, { timeout: 10000 });
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
            console.log('Авторизация выполнена');
        } catch (e) {
            console.log('Форма логина не найдена — возможно уже залогинен');
        }

        // Шаг 2: Открываем Wohnungsfinder по точной хэш-ссылке
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        // Ждём появления квартир на странице (до 20 секунд)
        console.log('Ожидаю загрузку квартир...');
        try {
            await page.waitForFunction(() => {
                const links = document.querySelectorAll('a');
                return Array.from(links).some(a => a.href && a.href.includes('/expose/'));
            }, { timeout: 20000 });
        } catch (_) {
            console.log('Квартиры не появились за 20 сек, пробуем читать что есть...');
        }

        await page.waitForTimeout(3000);

        // Шаг 3: Собираем все ссылки на квартиры
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => a.href)
                .filter(href => href && href.includes('/expose/'));
        });

        const unique = [...new Set(links)];
        console.log(`Найдено ссылок на квартиры: ${unique.length}`);

        // Шаг 4: Также пробуем найти через текстовый контент (на случай другой структуры)
        if (unique.length === 0) {
            const pageText = await page.evaluate(() => document.body.innerText);
            const match = pageText.match(/(\d+)\s*Wohnungen/i);
            if (match) {
                console.log(`Сайт говорит что есть ${match[1]} квартир, но ссылки не читаются`);
                await sendTelegram(`⚠️ Сайт показывает квартиры (${match[1]} шт.), но бот не может их прочитать. Зайди вручную на inberlinwohnen.de`);
            } else {
                console.log('Квартир не найдено и счётчика нет');
            }
        }

        const isFirst = seen.size === 0;

        for (const href of unique) {
            const m = href.match(/\/expose\/(\d+)/);
            const id = m ? m[1] : href;
            if (!seen.has(id)) {
                seen.add(id);
                if (!isFirst) {
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    await sendTelegram(`🏠 <b>Новая квартира!</b>\n\n⏰ ${time}`, href);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        if (isFirst) {
            console.log(`Первый запуск: сохранено ${seen.size} квартир в память`);
            await sendTelegram(`🤖 <b>Бот запущен!</b>\nНашёл и запомнил ${seen.size} квартир. Слежу за новыми каждые 5 минут.`);
        } else {
            console.log('Новых квартир нет');
        }

    } catch (e) {
        console.error('Ошибка:', e.message);
        await sendTelegram(`⚠️ Ошибка проверки: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🤖 Бот стартует...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main();
