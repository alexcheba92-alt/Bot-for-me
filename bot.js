const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 300000; // 5 минут
const SEEN_FILE = '/tmp/seen.json';
let seen = new Set();

function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
            console.log(`База загружена: ${seen.size} квартир`);
        }
    } catch (e) {}
}

function saveSeen() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen])); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '📋 Открыть и подать заявку', url }]] };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
    } catch (e) {
        console.error('Telegram ошибка:', e.message);
    }
}

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Проверка...`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({
        ...devices['iPhone 13 Pro'],
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
    });
    const page = await context.newPage();

    try {
        // Логин
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});
        await page.waitForTimeout(1000);

        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
            console.log('Авторизован');
        }

        // Переходим на страницу с фильтрами пользователя
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await page.waitForTimeout(8000);

        // Собираем карточки квартир — ищем строки с комнатами и ценой
        const apartments = await page.evaluate(() => {
            const results = [];
            const BASE = 'https://www.inberlinwohnen.de';

            // Ищем все кликабельные элементы списка квартир
            // Сайт рендерит их как <li> или <div> с текстом "X Zimmer, Y m², Z €"
            const allElements = document.querySelectorAll('li, .wohnung, .expose, [class*="result"], [class*="item"], [class*="wohn"]');
            
            allElements.forEach(el => {
                const text = el.innerText || '';
                // Проверяем что это карточка квартиры (содержит Zimmer и €)
                if (!text.includes('Zimmer') || !text.includes('€')) return;

                // Ищем ссылку внутри элемента
                const link = el.querySelector('a[href*="/expose/"]') || el.querySelector('a[href]');
                let href = link ? link.href : '';

                // Если ссылка относительная — делаем абсолютной
                if (href && href.startsWith('/')) href = BASE + href;

                // Пропускаем если ссылка ведёт не на квартиру
                if (!href || href.includes('ueber-uns') || href.includes('howoge.de/unternehmen')) return;

                // Чистим текст карточки
                const cleanText = text.trim().replace(/\s+/g, ' ').substring(0, 200);

                // Извлекаем ID квартиры из ссылки
                const idMatch = href.match(/\/expose\/(\d+)/);
                const id = idMatch ? idMatch[1] : href;

                if (id && cleanText) {
                    results.push({ id, href, text: cleanText });
                }
            });

            return results;
        });

        console.log(`Найдено карточек: ${apartments.length}`);

        const isFirst = seen.size === 0;
        let newCount = 0;

        for (const apt of apartments) {
            if (!seen.has(apt.id)) {
                seen.add(apt.id);

                if (!isFirst) {
                    newCount++;
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    
                    const msg =
                        `🚨 <b>НОВАЯ КВАРТИРА!</b>\n\n` +
                        `📍 ${apt.text}\n\n` +
                        `🕒 ${time}`;

                    await sendTelegram(msg, apt.href || 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/');
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        if (isFirst) {
            console.log(`Первый запуск: сохранено ${seen.size} квартир`);
            await sendTelegram(
                `🤖 <b>Бот запущен!</b>\n\n` +
                `✅ Вижу ${seen.size} квартир в базе\n` +
                `🔍 Слежу за новыми каждые 5 минут\n\n` +
                `Как только появится новая — сразу напишу с описанием и кнопкой на заявку.`
            );
        } else if (newCount > 0) {
            console.log(`Отправлено ${newCount} новых квартир`);
        } else {
            console.log('Новых нет');
        }

    } catch (e) {
        console.error('Ошибка:', e.message);
        await sendTelegram(`⚠️ Ошибка: ${e.message}`);
    } finally {
        await browser.close();
        saveSeen();
    }
}

async function main() {
    loadSeen();
    console.log('🤖 Бот запущен');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
