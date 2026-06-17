const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 300000;
const SEEN_FILE = '/tmp/seen.json';

let seen = new Set();

function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
            console.log(`Загружено ${seen.size} квартир`);
        }
    } catch (e) {}
}

function saveSeen() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen])); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Telegram OK');
    } catch (e) {}
}

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск проверки...`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({ ...devices['iPhone 13 Pro'], locale: 'de-DE' }).then(c => c.newPage());

    try {
        // Логин
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

        if (await page.isVisible('input[name="email"]', { timeout: 15000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(5000);
        }

        // Основная страница
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(10000);

        // Фильтры
        await page.locator('input[name*="miete"], input[placeholder*="Kalt"]').last().fill('600').catch(() => {});
        await page.locator('input[name*="zimmer"]').first().fill('3').catch(() => {});
        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(12000);

        // Улучшенный парсинг
        const apartments = await page.evaluate(() => {
            const results = [];
            const links = document.querySelectorAll('a');

            links.forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);

                if (href.length < 40) return;

                if (href.includes('/expose/') || 
                    href.includes('/wohnung/') || 
                    (href.includes('howoge.de') || href.includes('gewobag.de') || 
                     href.includes('degewo.de') || href.includes('stadtundland.de'))) {
                    
                    if (!href.includes('/unternehmen/') && !href.includes('impressum')) {
                        results.push({ href, text });
                    }
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        let newCount = 0;
        const isFirstRun = seen.size === 0;

        for (const apt of apartments) {
            const id = apt.href;

            if (!seen.has(id)) {
                seen.add(id);
                newCount++;

                if (!isFirstRun) {
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    await sendTelegram(
                        `🚨 <b>НОВАЯ КВАРТИРА!</b> 🏠\n\n` +
                        `🕒 ${time}\n` +
                        `🔗 ${apt.href}\n\n` +
                        `📝 ${apt.text}...`,
                        apt.href
                    );
                }
            }
        }

        if (isFirstRun) {
            await sendTelegram(`🤖 Бот запущен!\nНайдено на старте: ${seen.size} квартир`);
        } else if (newCount > 0) {
            console.log(`✅ Отправлено ${newCount} новых квартир`);
        } else {
            console.log('Новых квартир нет');
        }

        saveSeen();

    } catch (e) {
        console.error('Ошибка:', e.message);
    } finally {
        await browser.close();
    }
}

async function main() {
    loadSeen();
    console.log('🤖 Бот запущен');
    await sendTelegram('🤖 Бот перезапущен. Начинаю мониторинг 3-комнатных до 600€.');

    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
