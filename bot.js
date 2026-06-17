const { chromium, devices } = require('playwright');
const axios = require('axios');
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
        if (fs.existsSync(SEEN_FILE)) seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    } catch (e) {}
}

function saveSeen() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen])); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
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
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

        if (await page.isVisible('input[name="email"]', { timeout: 20000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(8000);
        }

        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForTimeout(20000); // очень длинная пауза

        // Сохраняем скриншот для дебага
        await page.screenshot({ path: '/tmp/last_page.png' });
        console.log('Скриншот сохранён (/tmp/last_page.png)');

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a[href]').forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 100);
                if (href.length > 60 && 
                    (href.includes('/expose/') || 
                     href.includes('howoge') || href.includes('gewobag') || 
                     href.includes('degewo') || href.includes('stadtundland'))) {
                    results.push({ href, text });
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        let newCount = 0;
        const isFirst = seen.size === 0;

        for (const apt of apartments) {
            if (!seen.has(apt.href)) {
                seen.add(apt.href);
                newCount++;

                if (!isFirst) {
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

        if (isFirst) {
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
    await sendTelegram('🤖 Бот перезапущен. Пытаюсь ловить...');

    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
