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
            console.log(`Загружено ${seen.size} квартир из памяти`);
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

async function checkInberlinwohnen() {
    console.log('Проверка Inberlinwohnen...');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({ ...devices['iPhone 13 Pro'], locale: 'de-DE' }).then(c => c.newPage());

    try {
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        if (await page.isVisible('input[name="email"]', { timeout: 10000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(5000);
        }

        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(7000);

        // Фильтры
        await page.locator('input[name*="miete_bis"], input[placeholder*="Kaltmiete"]').last().fill('600').catch(() => {});
        await page.locator('input[name*="zimmer"]').first().fill('3').catch(() => {});
        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(10000);

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                let href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);

                if (href.includes('/expose/') || 
                    (href.includes('howoge.de') || href.includes('gewobag.de') || href.includes('degewo.de') || href.includes('stadtundland.de')) && 
                    href.length > 60) {
                    results.push({ href, text, source: 'Inberlinwohnen' });
                }
            });
            return results;
        });

        await browser.close();
        return apartments;
    } catch (e) {
        console.error('Inberlin ошибка:', e.message);
        await browser.close();
        return [];
    }
}

async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}] Тихая проверка...`);

    const apartments = await checkInberlinwohnen();

    let newCount = 0;

    for (const apt of apartments) {
        const id = apt.href;

        if (!seen.has(id)) {
            seen.add(id);
            newCount++;

            const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
            await sendTelegram(
                `🚨 <b>НОВАЯ КВАРТИРА!</b> 🏠\n\n` +
                `📍 ${apt.source}\n` +
                `🕒 ${time}\n\n` +
                `🔗 ${apt.href}\n\n` + 
                `📝 ${apt.text}...\n\n` +
                `<i>3 Zimmer • bis 600€ Kaltmiete</i>`,
                apt.href
            );
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (newCount > 0) {
        console.log(`✅ Отправлено ${newCount} новых квартир`);
    } else {
        console.log('Новых квартир нет');
    }

    saveSeen();
}

async function main() {
    loadSeen();
    console.log('🤖 Бот запущен в тихом режиме (Inberlinwohnen)');

    await sendTelegram(
        `🤖 <b>Бот мониторинга запущен</b>\n\nОтслеживаю 3-комнатные квартиры ≤ 600€ Kaltmiete\nУведомления только при новых вариантах.`
    );

    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
