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
let botStartedMessageId = null;

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

async function sendTelegram(text, url = null, pin = false) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
    }
    try {
        const res = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Telegram отправлено');

        if (pin && res.data?.result?.message_id) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/pinChatMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                message_id: res.data.result.message_id,
                disable_notification: true
            }).catch(() => {});
        }
        return res.data?.result?.message_id;
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

async function checkApartments() {
    console.log(`[${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}] Тихая проверка...`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newContext({ ...devices['iPhone 13 Pro'], locale: 'de-DE' }).then(c => c.newPage());

    try {
        // Авторизация + Wohnungsfinder (твой текущий код)
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
        await page.locator('button:has-text("Wohnung suchen")').click().catch(() => {});
        await page.waitForTimeout(10000);

        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                let href = a.href.trim();
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);
                if (href.includes('/unternehmen/') || href.length < 40) return;
                if (href.includes('/expose/') || href.includes('howoge') || href.includes('gewobag') || href.includes('degewo') || href.includes('stadtundland')) {
                    results.push({ href, text });
                }
            });
            return results;
        });

        console.log(`Найдено ссылок: ${apartments.length}`);

        let newCount = 0;

        for (const apt of apartments) {
            const id = apt.href; // полная ссылка как уникальный ID

            if (!seen.has(id)) {
                seen.add(id);
                newCount++;

                const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                await sendTelegram(
                    `🚨 <b>НОВАЯ КВАРТИРА!</b> 🏠\n\n` +
                    `🕒 ${time}\n` +
                    `📝 ${apt.text}...\n\n` +
                    `<i>3-комнатная до 600€ Kaltmiete</i>`,
                    apt.href,
                    newCount === 1 // закрепляем только первую новую за запуск
                );
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (newCount > 0) {
            console.log(`✅ Найдено и отправлено ${newCount} новых квартир`);
        }

        saveSeen();

    } catch (e) {
        console.error('Ошибка проверки:', e.message);
    } finally {
        await browser.close();
    }
}

async function main() {
    loadSeen();
    console.log('🤖 Бот запущен в тихом режиме...');

    // Стартовое сообщение (один раз)
    if (!botStartedMessageId) {
        botStartedMessageId = await sendTelegram(
            `🤖 <b>Бот мониторинга запущен</b>\n\n` +
            `Отслеживаю 3-комнатные квартиры ≤ 600€ Kaltmiete\n` +
            `Уведомления только при новых вариантах.`,
            null,
            true // закрепляем стартовое сообщение
        );
    }

    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
