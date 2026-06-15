const axios = require('axios');
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = 300000;

const seen = new Set();

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть', url }]] };
    
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Telegram OK');
    } catch (e) {
        console.error('❌ Telegram fail:', e.message);
    }
}

async function checkWithAxios() {
    console.log('🔍 Пробуем Axios...');
    const session = axios.create({
        withCredentials: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'de-DE,de;q=0.9',
            'Referer': 'https://www.inberlinwohnen.de/wohnungsfinder/'
        }
    });

    try {
        await session.get('https://www.inberlinwohnen.de/');
        await new Promise(r => setTimeout(r, 2000));

        // Попытка поиска (может не работать, но попробуем)
        const searchData = new URLSearchParams({
            q: 'srch', lang: 'de', qtype: 'advanced',
            qmiete_max: '600', qrooms_min: '3', qrooms_max: '3'
        });

        await session.post('https://www.inberlinwohnen.de/wohnungsfinder/', searchData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        await new Promise(r => setTimeout(r, 3000));

        const res = await session.get('https://www.inberlinwohnen.de/wohnungsfinder/');
        const html = res.data;

        const links = [...html.matchAll(/https?:\/\/[^"'\s>]*expose[^"'\s>]*/gi)]
            .map(m => m[0].replace(/[)'",]$/, ''));

        return [...new Set(links)];
    } catch (e) {
        console.log('Axios не сработал:', e.message);
        return [];
    }
}

async function checkWithPlaywright() {
    console.log('🌐 Пробуем Playwright...');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ 
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        locale: 'de-DE'
    });
    const page = await context.newPage();

    try {
        await page.goto('https://www.inberlinwohnen.de/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });

        // Принимаем куки
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        // Ждём загрузки результатов
        await page.waitForSelector('a[href*="expose"], .tb-housing-finder-results, article', { timeout: 30000 });

        // Собираем все expose-ссылки
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => a.href)
                .filter(h => h && /expose|details|immobilie/.test(h));
        });

        return [...new Set(links)];
    } catch (e) {
        console.error('Playwright ошибка:', e.message);
        return [];
    } finally {
        await browser.close();
    }
}

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск проверки...`);

    let uniqueLinks = await checkWithAxios();
    if (uniqueLinks.length === 0) {
        uniqueLinks = await checkWithPlaywright();
    }

    console.log(`Найдено expose-ссылок: ${uniqueLinks.length}`);

    const isFirst = seen.size === 0;

    for (const href of uniqueLinks) {
        const match = href.match(/(\d{4,}|[\w-]+-\d+)/); // гибкий матч ID
        const id = match ? match[1] : href;

        if (!seen.has(id)) {
            seen.add(id);
            if (!isFirst) {
                await sendTelegram(`🏠 <b>Новая 3-комнатная до 600€!</b>\n⏰ ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`, href);
            }
        }
    }

    if (isFirst) {
        await sendTelegram(`🤖 Бот запущен! Мониторим 3-комнатные до 600€.\nСейчас в базе: ${seen.size}`);
    }
}

async function main() {
    console.log('🤖 Бот стартует...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
