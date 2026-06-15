const axios = require('axios');
const { chromium, devices } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const CHECK_INTERVAL = 300000;

const seen = new Set();

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
    console.log(`[${now}] Запуск проверки (3 комнаты ≤ 600€ Kaltmiete)...`);

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
        // Авторизация
        console.log('Авторизация...');
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        if (await page.isVisible('input[name="email"]', { timeout: 10000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(5000);
        }

        // Переход на поисковик
        console.log('Открываю Wohnungsfinder...');
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });
        await page.waitForTimeout(4000);

        // === ФИЛЬТРЫ ===
        console.log('Применяю фильтры...');

        const mieteSelectors = ['input[name*="miete_bis"], input[id*="miete_bis"], input[placeholder*="Kaltmiete"]'];
        for (const sel of mieteSelectors) {
            const input = page.locator(sel).last();
            if (await input.isVisible({ timeout: 4000 })) {
                await input.fill('600');
                break;
            }
        }

        const zimmerSelectors = ['input[name*="zimmer_von"], input[name*="zimmer_bis"]'];
        for (const sel of zimmerSelectors) {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 4000 })) await input.fill('3');
        }

        const searchBtn = page.locator('button:has-text("Wohnung suchen"), button[type="submit"]');
        await searchBtn.click().catch(() => {});

        await page.waitForTimeout(10000);

        // === ОБРАБОТКА КАПЧИ ===
        console.log('Проверяем наличие капчи...');
        const captchaVisible = await page.locator('iframe[src*="captcha"], div[id*="captcha"], .g-recaptcha, #challenge-form').isVisible({ timeout: 5000 }).catch(() => false);
        
        if (captchaVisible) {
            console.log('⚠️ Обнаружена капча!');
            await page.screenshot({ path: '/tmp/captcha.png' });
            await sendTelegram('🚨 **Капча на сайте!** Бот остановлен до ручного решения. Проверь Railway (скриншот сохранён).');
            // Можно добавить await page.pause(); но в headless лучше уведомить
            return; // прерываем текущую итерацию
        }

        // Парсинг результатов
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

        console.log(`Найдено квартир: ${apartments.length}`);

        const isFirst = seen.size === 0;

        for (const apt of apartments) {
            const match = apt.href.match(/expose\/([^/?#]+)/) || apt.href.match(/(\d{5,}-?\d*)/);
            const id = match ? match[1] : apt.href;

            if (!seen.has(id)) {
                seen.add(id);
                if (!isFirst) {
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    await sendTelegram(
                        `🏠 <b>Новая 3-комнатная до 600€!</b>\n⏰ ${time}\n📝 ${apt.text}...`,
                        apt.href
                    );
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }

        if (isFirst) {
            await sendTelegram(`🤖 Бот запущен!\nФильтры: 3 Zimmer ≤ 600€\nНайдено: ${seen.size}`);
        }

    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        await sendTelegram(`⚠️ Ошибка бота: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🤖 Бот стартует (3 Zimmer ≤ 600€ Kalt)...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
