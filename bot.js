const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const IMMOMIO_EMAIL = process.env.IMMOMIO_EMAIL;
const IMMOMIO_PASSWORD = process.env.IMMOMIO_PASSWORD;

const CHECK_INTERVAL = 300000; // 5 минут
const SEEN_FILE = '/tmp/seen.json';
let seen = new Set();

function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
            console.log(`Загружено из памяти: ${seen.size} квартир`);
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
        console.log('✅ Telegram отправлено');
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

// ====================== INBERLINWOHNEN ======================
async function checkInberlinwohnen() {
    console.log('Проверка Inberlinwohnen...');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({ ...devices['iPhone 13 Pro'], locale: 'de-DE' }).then(c => c.newPage());

    try {
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
        }

        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(6000);

        // Фильтры
        await page.locator('input[name*="miete_bis"], input[placeholder*="Kaltmiete"]').last().fill('600').catch(() => {});
        await page.locator('input[name*="zimmer"]').first().fill('3').catch(() => {});
        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(10000);

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);
                if (href && (href.includes('/expose/') || href.includes('howoge') || href.includes('gewobag') || 
                             href.includes('degewo') || href.includes('stadtundland'))) {
                    if (!href.includes('/unternehmen/') && !href.includes('ueber-uns')) {
                        results.push({ href, text, source: 'Inberlinwohnen' });
                    }
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

// ====================== IMMOMIO ======================
async function checkImmomio() {
    if (!IMMOMIO_EMAIL || !IMMOMIO_PASSWORD) return [];
    
    console.log('Проверка Immomio...');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({ ...devices['iPhone 13 Pro'], locale: 'de-DE' }).then(c => c.newPage());

    try {
        await page.goto('https://tenant.immomio.com/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.locator('input[type="email"]').fill(IMMOMIO_EMAIL);
        await page.locator('input[type="password"]').fill(IMMOMIO_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(8000);

        await page.goto('https://tenant.immomio.com/offers', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(6000);

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);
                if (href && (href.includes('/offer/') || href.includes('/apartments/'))) {
                    results.push({ href, text, source: 'Immomio' });
                }
            });
            return results;
        });

        await browser.close();
        return apartments;
    } catch (e) {
        console.error('Immomio ошибка:', e.message);
        await browser.close();
        return [];
    }
}

// ====================== ОСНОВНАЯ ЛОГИКА ======================
async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}] Тихая проверка...`);

    const inberlin = await checkInberlinwohnen();
    const immomio = await checkImmomio();
    const all = [...inberlin, ...immomio];

    let newCount = 0;

    for (const apt of all) {
        const id = apt.href;

        if (!seen.has(id)) {
            seen.add(id);
            newCount++;

            const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
            await sendTelegram(
                `🚨 <b>НОВАЯ КВАРТИРА!</b> 🏠\n\n` +
                `📍 ${apt.source}\n` +
                `🕒 ${time}\n` +
                `📝 ${apt.text}...\n\n` +
                `<i>3 Zimmer • bis 600€ Kaltmiete</i>`,
                apt.href
            );
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (newCount > 0) {
        console.log(`✅ Найдено и отправлено ${newCount} новых квартир`);
    }

    saveSeen();
}

async function main() {
    loadSeen();
    console.log('🤖 Бот запущен в тихом режиме (Inberlinwohnen + Immomio)');
    
    // Стартовое сообщение
    await sendTelegram(
        `🤖 <b>Бот мониторинга запущен</b>\n\nОтслеживаю 3-комнатные квартиры ≤ 600€ Kaltmiete\nУведомления только при новых вариантах.`,
        null
    );

    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
