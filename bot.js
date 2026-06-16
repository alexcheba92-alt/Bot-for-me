const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const CHECK_INTERVAL = 300000; // 5 минут

const SEEN_FILE = './seen_apartments.json';
let seen = new Set();

// Загружаем старые квартиры из файла, чтобы не спамить одним и тем же при перезапусках Railway
if (fs.existsSync(SEEN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        seen = new Set(data);
        console.log(`[База] Загружено из памяти старых ID: ${seen.size}`);
    } catch (e) {
        console.log('[База] Ошибка чтения памяти, создаем чистую.');
    }
}

function saveCache() {
    try {
        fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), 'utf8');
    } catch (e) {
        console.error('[База] Ошибка сохранения:', e.message);
    }
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Сообщение отправлено в Telegram');
    } catch (e) {
        console.error('❌ Ошибка Telegram (Проверь ID чата и Токен!):', e.message);
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

        // Кликаем куки
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        if (await page.isVisible('input[name="email"]', { timeout: 10000 })) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);
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
        const mieteSelectors = ['input[name*="miete_bis"]', 'input[id*="miete_bis"]', 'input[placeholder*="Kaltmiete"]'];
        for (const sel of mieteSelectors) {
            const input = page.locator(sel).last();
            if (await input.isVisible({ timeout: 4000 })) {
                await input.fill('600');
                break;
            }
        }

        const zimmerSelectors = ['input[name*="zimmer_von"]', 'input[name*="zimmer_bis"]'];
        for (const sel of zimmerSelectors) {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 4000 })) await input.fill('3');
        }

        const searchBtn = page.locator('button:has-text("Wohnung suchen"), button[type="submit"]');
        await searchBtn.click().catch(() => {});

        await page.waitForTimeout(8000);

        // === ОБРАБОТКА КАПЧИ ===
        const captchaVisible = await page.locator('iframe[src*="captcha"], div[id*="captcha"], .g-recaptcha, #challenge-form').isVisible({ timeout: 3000 }).catch(() => false);
        if (captchaVisible) {
            console.log('⚠️ Обнаружена капча! Пропускаем круг.');
            return;
        }

        // Парсинг результатов
        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href ? a.href.trim() : '';
                const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
                if (href && (href.includes('/expose/') || href.includes('detail'))) {
                    results.push({ href, text: text.substring(0, 120) || 'Квартира' });
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        let newFound = false;

        for (const apt of apartments) {
            const match = apt.href.match(/expose\/([^/?#]+)/) || apt.href.match(/(\d{5,}-?\d*)/);
            const id = match ? match[1] : apt.href;

            // ЕСЛИ ЭТОГО ID НЕТ В БАЗЕ — СРАЗУ ШЛЕМ В ТЕЛЕГРАМ
            if (!seen.has(id)) {
                seen.add(id);
                newFound = true;
                
                const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                await sendTelegram(
                    `🏠 <b>Найдена квартира (3 Zimmer ≤ 600€)!</b>\n⏰ Время: ${time}\n📝 Описание: ${apt.text}...`,
                    apt.href
                );
                await new Promise(r => setTimeout(r, 2000)); // Пауза, чтобы ТГ не забанил за спам
            }
        }

        if (newFound) {
            saveCache();
        } else {
            console.log('Новых квартир с момента последней проверки нет.');
        }

    } catch (e) {
        console.error('❌ Ошибка в цикле:', e.message);
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🤖 Бот стартует (Браузерный режим)...');
    
    // Сразу проверяем, доходят ли вообще сообщения до твоего ТГ
    await sendTelegram('🚀 <b>Бот запущен на Railway!</b>\nПроверяю связь. Если ты видишь это сообщение, значит ТГ-канал подключен правильно. Начинаю первый сбор квартир...');
    
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
