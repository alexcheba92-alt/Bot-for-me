const { chromium, devices } = require('playwright');
const axios = require('axios');

// ==========================================
// НАСТРОЙКИ (Берутся из переменных Railway)
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;
const CHECK_INTERVAL = 300000; // 5 минут

const BASE_URL = 'https://www.inberlinwohnen.de';

// Твоя зашифрованная ссылка с жесткими фильтрами (цена до 600, 3 комнаты)
const SEARCH_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkZWejd0ZFlVSEljbWU1Z0hXT0tmMmc9PSIsInZhbHVlIjoia2lIczRQQUt4VWVYOXJ2U0Y5TTlDc2JadDZzTEtRRk1RK3E0QlFkc29ub3NFSk5McWtncHBoOVVRT0txTDNleVVZalMyZ0RFc3dQdHRwQ2kzaVhqdnczTVV3ZWtmT1FoZDRkU09tL0E4QVhTY1ExUEtGZFlkaDFEVkR5RitzVTRpWHBsUmlFMS80SUNsQ25iaEVjR25zNUZNRmVEUkE4aSszNE1kd3hIdVIwSlFuc0ZxaUxFclJPZDVoMTdWR3RpRVp4cmRoZFd1bGxYaUhXVjUxYXV6Rm41amRrazBJRmlEYUpPNmEwZVFsSWFBRkR0b3dpL1MxL2VRWm5MbHczVDNHV25xemV0R3lTalo4SVpoUzJrRk1CTG5vdUdjTldIemFDYkF2OC9NdTU2OFJLbEIvY3NuY2pRbHo2Y01aOW1hQUNGT1NhSy8xV3dEaHdoV3dVeXJVaHBldnRlU0lpRkVuek5SWlpyTHVKMmF6WlA0YXdaUXcvSkFQSldtcWh4ZnJYUWljRDVmdC82a2s4d1htNFpxNkVEWFAwbGNBdjNBSnRENkFFV2k0aXQxbm1YNjZwc1VhREFPb2pLUUpZVCIsIm1hYyI6IjhhZTViZjViMDM2YWNiYWY1YzEwNGIwODQzN2Y0NzZjMGYxTzgxZGRmNTI5OTNiNjg0ZWQ3NDM5NjU2ZTA3MDEiLCJ0YWciOiIifQ%3D%3D';

const seen = new Set();

// Отправка уведомлений в Telegram
async function sendTelegram(text, url = null) {
    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
    };
    if (url) {
        payload.reply_markup = {
            inline_keyboard: [[{ text: '🔗 Открыть квартиру', url: url }]]
        };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload, { timeout: 10000 });
        console.log('Telegram: сообщение успешно отправлено');
    } catch (e) {
        console.error('Telegram ошибка отправки:', e.message);
    }
}

// Главная функция проверки
async function checkApartments() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Запуск сессии проверки квартир...`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Эмуляция Айфона для обхода десктопных блокировок и пустых экранов
    const iPhone = devices['iPhone 13 Pro'];
    const context = await browser.newContext({
        ...iPhone,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    const page = await context.newPage();

    try {
        // Шаг 1: Авторизация на сайте
        console.log('Открываю страницу авторизации...');
        await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Кликаем куки, если они перекрывают экран
        for (const sel of ['#uc-btn-accept-banner', 'button:has-text("Alle akzeptieren")', 'button:has-text("Auswahl erlauben")']) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 2000 })) {
                    await btn.click();
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (_) {}
        }

        // Заполнение формы логина
        try {
            await page.fill('input[name="email"]', INBERLIN_EMAIL, { timeout: 10000 });
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
            console.log('Авторизация выполнена успешно.');
        } catch (e) {
            console.log('Форма логина не найдена (возможно, сессия уже была активна). Иду дальше.');
        }

        // Шаг 2: Открываем Wohnungsfinder по твоей ссылке с фильтрами
        console.log('Загружаю Wohnungsfinder с зашифрованными фильтрами...');
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 50000 });
        
        // Даем 5 секунд внутренним AJAX-скриптам сайта подгрузить карту и результаты
        await page.waitForTimeout(5000);

        // Ждем появления индикаторов того, что поиск завершился (карта, список или маркеры)
        console.log('Ожидаю рендеринг результатов поиска на экране...');
        try {
            await page.waitForSelector('.tb-housing-finder-results, #tb-housing-finder-map, .leaflet-marker-icon', { timeout: 20000 });
        } catch (_) {
            console.log('Компоненты выдачи не появились за 20 сек. Пробую парсить текущее состояние.');
        }

        // Шаг 3: Сбор ссылок на квартиры (Многоуровневый поиск)
        
        // Метод А: Ищем стандартные ссылки на экспoзе в тегах <a>
        let links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => a.href)
                .filter(href => href && href.includes('/expose/'));
        });

        // Метод Б: Если открыта карта, вытаскиваем ID прямо из атрибутов меток или кода элементов
        const extraIds = await page.evaluate(() => {
            const ids = [];
            document.querySelectorAll('[data-id], [id*="expose"], .leaflet-marker-icon, .tb-wfinder__result-item').forEach(el => {
                if (el.dataset && el.dataset.id) {
                    ids.push(el.dataset.id);
                }
                const html = el.outerHTML;
                const m = html.match(/\/expose\/(\d+)/);
                if (m) ids.push(m[1]);
            });
            return ids;
        });

        // Объединяем все найденные ссылки и ID в один чистый массив
        const fullLinks = [
            ...links,
            ...extraIds.map(id => id.startsWith('http') ? id : `${BASE_URL}/expose/${id}/`)
        ];

        let unique = [...new Set(fullLinks)].filter(href => href && href.includes('/expose/'));
        console.log(`Первичный сбор: найдено уникальных ссылок: ${unique.length}`);

        // Шаг 4: Экстренное переключение, если ссылки равны 0, но сайт выдает текстовый счетчик
        if (unique.length === 0) {
            const pageText = await page.evaluate(() => document.body.innerHTML);
            const match = pageText.match(/(\d+)\s*Wohnungen/i);
            
            if (match && parseInt(match[1]) > 0) {
                console.log(`Сайт пишет, что найдено ${match[1]} квартир, но мы в режиме карты. Пробую переключить в режим списка...`);
                try {
                    // Ищем кнопку переключения в вид списка (иконка с полосками/списком)
                    const listBtn = page.locator('button:has(.fa-list), .view-switch-list, [class*="list"], .tb-wfinder__view-toggle').first();
                    if (await listBtn.isVisible()) {
                        await listBtn.click();
                        await page.waitForTimeout(4000);
                        
                        // Собираем ссылки заново после переключения режима отображения
                        const freshLinks = await page.evaluate(() => {
                            return Array.from(document.querySelectorAll('a'))
                                .map(a => a.href)
                                .filter(href => href && href.includes('/expose/'));
                        });
                        unique = [...new Set(freshLinks)];
                        console.log(`После переключения в режим списка найдено ссылок: ${unique.length}`);
                    }
                } catch (err) {
                    console.log('Не удалось автоматически переключить карту в список:', err.message);
                }
            }
        }

        // Если совсем глухо и ссылок ноль — страхуем текстовым уведомлением в ТГ
        if (unique.length === 0) {
            const finalHtml = await page.evaluate(() => document.body.innerText);
            const finalMatch = finalHtml.match(/(\d+)\s*Wohnungen/i);
            if (finalMatch) {
                console.log(`Счетчик нашел ${finalMatch[1]} квартир, но их DOM-структура скрыта.`);
                await sendTelegram(`⚠️ Бот видит счетчик (${finalMatch[1]} шт.), но ссылки не считываются. Проверь сайт вручную.`);
            } else {
                console.log('Квартир на странице действительно не обнаружено и счетчик на нуле.');
            }
        }

        // Шаг 5: Сравнение с базой памяти и отправка новинок в Telegram
        const isFirst = seen.size === 0;

        for (const href of unique) {
            const m = href.match(/\/expose\/(\d+)/);
            const id = m ? m[1] : href;
            
            if (!seen.has(id)) {
                seen.add(id);
                // Шлем в ТГ только если это не самый первый "прогревочный" запуск бота
                if (!isFirst) {
                    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
                    await sendTelegram(`🏠 <b>Новая квартира по твоим фильтрам!</b>\n\n⏰ Найдено в: ${time}`, href);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        if (isFirst) {
            console.log(`Первый запуск: Успешно считали базу. Сохранено в память ${seen.size} квартир.`);
            await sendTelegram(`🤖 <b>Бот успешно запущен и настроен!</b>\nВ базу занесено и поставлено на слежку текущих квартир: ${seen.size}.`);
        } else {
            console.log('Проверка завершена. Новых объявлений с прошлого круга нет.');
        }

    } catch (e) {
        console.error('Критическая ошибка сессии:', e.message);
        await sendTelegram(`⚠️ Ошибка работы бота: ${e.message}`);
    } finally {
        await browser.close();
        console.log(`[${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}] Сессия закрыта. Сплю 5 минут.`);
    }
}

// Стартовая точка приложения
async function main() {
    console.log('🤖 Бот стартует...');
    await checkApartments();
    setInterval(checkApartments, CHECK_INTERVAL);
}

main();
