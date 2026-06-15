const axios = require('axios');
const { chromium, devices } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = 300000; // 5 минут

const seen = new Set();

async function sendTelegram(text, url = null) {
    const payload = { 
        chat_id: TELEGRAM_CHAT_ID, 
        text, 
        parse_mode: 'HTML' 
    };
    if (url) {
        payload.reply_markup = { 
            inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]] 
        };
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

    const iPhone = devices['iPhone 13 Pro'];
    const context = await browser.newContext({
        ...iPhone,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    const page = await context.newPage();

    try {
        // Переходим на Wohnungsfinder
        console.log('Открываю Wohnungsfinder...');
        await page.goto('https://www.inberlinwohnen.de/wohnungsfinder/', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });

        // Принимаем куки
        await page.locator('button:has-text("Alle akzeptieren"), #uc-btn-accept-banner, button:has-text("Akzeptieren")')
            .click({ timeout: 10000 }).catch(() => console.log('Куки уже приняты'));

        await page.waitForTimeout(3000);

        // === ФИЛЬТРЫ ===
        console.log('Применяю фильтры: 3 комнаты, Kaltmiete ≤ 600€');

        // Kaltmiete bis 600
        const mieteInput = page.locator('input[name*="miete"], input[placeholder*="Kaltmiete"], input[id*="miete"]').last();
        if (await mieteInput.isVisible({ timeout: 5000 })) {
            await mieteInput.fill('600');
        }

        // Zimmer = 3
        const zimmerInput = page.locator('input[name*="zimmer"], select[name*="zimmer"], input[id*="zimmer"]').first();
        if (await zimmerInput.isVisible({ timeout: 5000 })) {
            await zimmerInput.fill('3');
        } else {
            // Альтернатива — клик по 3 Zimmer
            await page.locator('label:has-text("3"), button:has-text("3 Zimmer"), input[value="3"]').click().catch(() => {});
        }

        // Применяем поиск
        const searchBtn = page.locator('button:has-text("Wohnung suchen"), button[type="submit"], .search-button');
        await searchBtn.click({ timeout: 10000 }).catch(() => {});

        await page.waitForTimeout(8000); // Ждём загрузку результатов

        // Собираем все ссылки на квартиры
        const apartments = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href;
                const text = (a.textContent || '').trim();
                if (href && (href.includes('howoge') || href.includes('gewobag') || href.includes('degewo') || 
                             href.includes('stadtundland') || href.includes('detail') || href.includes('wohnungssuche'))) {
                    results.push({ href, text });
                }
            });
            return results;
        });

        console.log(`Найдено потенциальных ссылок: ${apartments.length}`);

        const isFirst = seen.size === 0;

        for (const apt of apartments) {
            const id = apt.href; // используем полную ссылку как уникальный ID
            if (!seen.has(id)) {
                seen.add(id);
                if (!isFirst) {
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    await sendTelegram(
                        `🏠 <b>Новая 3-комнатная квартира до 600€ Kaltmiete!</b>\n\n` +
                        `⏰ ${time}\n\n` +
                        `${apt.text.substring(0, 150)}...`,
                        apt.href
                    );
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }

        if (isFirst) {
            await sendTelegram(`🤖 Бот запущен!\nОтслеживаю **3-комнатные квартиры ≤ 600€ Kaltmiete**.\nНайдено на старте: ${seen.size}`);
        } else if (apartments.length === 0) {
            console.log('Пока ничего подходящего не найдено.');
        }

    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        await sendTelegram(`⚠️ Ошибка бота: ${e.message}`);
    } finally {
        await browser.close();
        console.log(`[${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}] Сессия завершена.`);
    }
}

async function main() {
    console.log('🤖 Бот стартует (3 Zimmer ≤ 600€ Kalt)...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main().catch(console.error);
