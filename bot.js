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

// Загрузка seen из файла
function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
            seen = new Set(data);
            console.log(`✅ Загружено ${seen.size} квартир из памяти`);
        }
    } catch (e) {
        console.log('Seen файл пуст или повреждён, начинаем с чистого');
    }
}

// Сохранение seen
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
        console.error('❌ Telegram ошибка:', e.message);
    }
}

async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск проверки...`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({
        ...devices['iPhone 13 Pro'],
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    }).then(ctx => ctx.newPage());

    try {
        // ... (твоя авторизация и фильтры остаются почти без изменений) ...
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(4000);

        // Фильтры (оставил как у тебя)
        const mieteSelectors = ['input[name*="miete_bis"], input[placeholder*="Kaltmiete"]'];
        for (const sel of mieteSelectors) {
            const el = page.locator(sel).last();
            if (await el.isVisible({ timeout: 3000 })) await el.fill('600');
        }

        const zimmerSelectors = ['input[name*="zimmer"]'];
        for (const sel of zimmerSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 3000 })) await el.fill('3');
        }

        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(10000);

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
                if (href && (href.includes('/expose/') || href.includes('howoge') || href.includes('gewobag') || 
                             href.includes('degewo') || href.includes('detail'))) {
                    results.push({ href, text: text.substring(0, 120) || 'Квартира' });
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        const isFirstRunEver = seen.size === 0 && apartments.length > 0;
        let newCount = 0;

        for (const apt of apartments) {
            const match = apt.href.match(/expose\/([^/?#]+)/) || apt.href.match(/(\d{5,}-?\d*)/);
            const id = match ? match[1] : apt.href;

            if (!seen.has(id)) {
                seen.add(id);
                newCount++;
                const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                await sendTelegram(
                    `🏠 <b>Новая 3-комнатная до 600€ Kaltmiete!</b>\n⏰ ${time}\n📝 ${apt.text}...`,
                    apt.href
                );
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (isFirstRunEver) {
            await sendTelegram(`🤖 Бот успешно запущен!\nФильтры: 3 Zimmer ≤ 600€ Kaltmiete\nСейчас в базе: ${seen.size} квартир`);
        } else if (newCount > 0) {
            console.log(`Отправлено ${newCount} новых квартир`);
        } else {
            console.log('Новых квартир нет');
        }

        saveSeen();

    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        await sendTelegram(`⚠️ Ошибка бота: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    loadSeen();
    console.log('🤖 Бот стартует...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
