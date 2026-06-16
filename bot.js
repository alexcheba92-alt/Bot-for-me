const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const CHECK_INTERVAL = 300000;

const SEEN_FILE = './seen_apartments.json';
let seen = new Set();

if (fs.existsSync(SEEN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        seen = new Set(data);
        console.log(`[База] Загружено старых ID: ${seen.size}`);
    } catch (e) {}
}

function saveCache() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), 'utf8'); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] };
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
        console.log('✅ Сообщение отправлено в Telegram');
    } catch (e) {
        console.error('❌ Ошибка Telegram:', e.message);
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
        // 1. Логин
        console.log('Авторизация...');
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner').click().catch(() => {});

        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(6000);
        }

        // 2. Поисковик
        console.log('Открываю Wohnungsfinder...');
        await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(4000);

        // 3. Выставляем фильтры
        console.log('Применяю фильтры...');
        const mieteInput = page.locator('input[name*="miete_bis"], input[id*="miete_bis"], input[placeholder*="Kaltmiete"]').last();
        if (await mieteInput.isVisible({ timeout: 4000 })) {
            await mieteInput.fill('600');
        }

        const zimmerSelectors = ['input[name*="zimmer_von"]', 'input[name*="zimmer_bis"]'];
        for (const sel of zimmerSelectors) {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 4000 })) await input.fill('3');
        }

        await page.locator('button:has-text("Wohnung suchen"), button[type="submit"]').click().catch(() => {});
        await page.waitForTimeout(6000);

        // 4. ЖЕСТКОЕ ПЕРЕКЛЮЧЕНИЕ НА РЕЖИМ СПИСКА (Listview)
        // Ищем кнопку по классам и атрибутам и кликаем, чтобы убрать карту и показать карточки
        console.log('Переключаюсь с карты на список квартир...');
        const listButton = page.locator('.aria-icon-list, [class*="list"], button:has-text("Liste"), .list-view-button').first();
        if (await listButton.isVisible({ timeout: 3000 })) {
            await listButton.click();
            await page.waitForTimeout(3000);
        } else {
            // Альтернативный клик по иконке списка, если классы другие
            await page.click('ul.view-modes li:nth-child(2), .view-mode-list').catch(() => {});
            await page.waitForTimeout(2000);
        }

        // === ОБРАБОТКА КАПЧИ ===
        const captchaVisible = await page.locator('iframe[src*="captcha"], #challenge-form').isVisible({ timeout: 2000 }).catch(() => false);
        if (captchaVisible) {
            console.log('⚠️ Капча на странице. Пропускаем.');
            return;
        }

        // 5. Парсинг
        console.log('Парсим карточки товаров...');
        const apartments = await page.evaluate(() => {
            const results = [];
            // Собираем вообще все ссылки на странице, содержащие /expose/
            document.querySelectorAll('a[href*="/expose/"]').forEach(a => {
                const href = a.href ? a.href.trim() : '';
                // Берем текст самой ссылки или текст родительского блока карточки
                const parent = a.closest('div, li, article') || a;
                const text = (parent.textContent || a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 100);
                if (href) {
                    results.push({ href, text });
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        let newFound = false;

        for (const apt of apartments) {
            const match = apt.href.match(/expose\/([^/?#]+)/) || apt.href.match(/(\d{5,}-?\d*)/);
            const id = match ? match[1] : apt.href;

            if (!seen.has(id)) {
                seen.add(id);
                newFound = true;
                
                const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                await sendTelegram(
                    `🏠 <b>Найдена квартира!</b>\n⏰ Время: ${time}\n📝 Данные: ${apt.text}...`,
                    apt.href
                );
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (newFound) {
            saveCache();
        } else {
            console.log('Новых объектов с момента последней проверки не появилось.');
        }

    } catch (e) {
        console.error('❌ Ошибка:', e.message);
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🤖 Бот перезапущен с фиксом отображения списка...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
