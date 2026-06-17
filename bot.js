const { chromium, devices } = require('playwright');
const axios = require('axios');
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
            console.log(`Загружено ${seen.size} квартир`);
        }
    } catch (e) {}
}

function saveSeen() {
    try {
        fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
    } catch (e) {}
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

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск проверки...`);

    const browser = await chromium.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });

    const context = await browser.newContext({
        ...devices['iPhone 13 Pro'],
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    const page = await context.newPage();

    try {
        // === ЛОГИН ===
        console.log('Открываю страницу логина...');
        await page.goto('https://www.inberlinwohnen.de/login/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        // Принимаем куки
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner, button:has-text("Akzeptieren")')
            .click({ timeout: 10000 }).catch(() => {});

        // Заполняем форму
        if (await page.isVisible('input[name="email"]', { timeout: 15000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);
            console.log('Логин выполнен');
        }

        // === WOHNUNGSFINDER ===
        console.log('Открываю Wohnungsfinder...');
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });
        await page.waitForTimeout(8000);

        // Фильтры
        console.log('Применяю фильтры...');
        await page.locator('input[name*="miete_bis"], input[placeholder*="Kaltmiete"]').last().fill('600').catch(() => {});
        await page.locator('input[name*="zimmer"]').first().fill('3').catch(() => {});
        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(12000);

        // Парсинг
        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);
                if (href && (href.includes('/expose/') || 
                    href.includes('howoge.de') || href.includes('gewobag.de') || 
                    href.includes('degewo.de') || href.includes('stadtundland.de'))) {
                    results.push({ href, text });
                }
            });
            return results;
        });

        console.log(`Найдено
