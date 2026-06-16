const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 300000;
const SEEN_FILE = '/tmp/seen.json';
const SEARCH_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkZWejd0ZFlVSEljbWU1Z0hXT0tmMmc9PSIsInZhbHVlIjoia2lIczRQQUt4VWVYOXJ2U0Y5TTlDc2JadDZzTEtRRk1RK3E0QlFkc29ub3NFSk5McWtncHBoOVVRT0txTDNleVVZalMyZ0RFc3dQdHRwQ2kzaVhqdnczTVV3ZWtmT1FoZDRkU09tL0E4QVhTY1ExUEtGZFlkaDFEVkR5RitzVTRpWHBsUmlFMS80SUNsQ25iaEVjR25zNUZNRmVEUkE4aSszNE1kd3hIdVIwSlFuc0ZxaUxFclJPZDVoMTdWR3RpRVp4cmRoZFd1bGxYaUhXVjUxYXV6Rm41amRrazBJRmlEYUpPNmEwZVFsSWFBRkR0b3dpL1MxL2VRWm5MbHczVDNHV25xemV0R3lTalo4SVpoUzJrRk1CTG5vdUdjTldIemFDYkF2OC9NdTU2OFJLbEIvY3NuY2pRbHo2Y01aOW1hQUNGT1NhSy8xV3dEaHdoV3dVeXJVaHBldnRlU0lpRkVuek5SWlpyTHVKMmF6WlA0YXdaUXcvSkFQSldtcWh4ZnJYUWljRDVmdC82a2s4d1htNFpxNkVEWFAwbGNBdjNBSnRENkFFV2k0aXQxbm1YNjZwc1VhREFPb2pLUUpZVCIsIm1hYyI6IjhhZTViZjViMDM2YWNiYWY1YzEwNGIwODQzN2Y0NzZjMGYxNzgxZGRmNTI5OTNiNjg0ZWQ3NDM5NjU2ZTA3MDEiLCJ0YWciOiIifQ%3D%3D';

// Хранилище: Map id -> { href, text }
let knownApartments = new Map();
let isFirstRun = true;

function load() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
            knownApartments = new Map(data);
            isFirstRun = false;
            console.log(`Загружено ${knownApartments.size} квартир из базы`);
        }
    } catch (e) {}
}

function save() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...knownApartments])); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: '📋 Открыть и подать заявку', url }]] };
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
    } catch (e) {
        console.error('Telegram ошибка:', e.message);
    }
}

async function getApartments() {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({
        ...devices['iPhone 13 Pro'],
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
    });
    const page = await context.newPage();

    try {
        // Логин
        await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});
        await page.waitForTimeout(1500);

        if (await page.isVisible('input[name="email"]')) {
            await page.fill('input[name="email"]', INBERLIN_EMAIL);
            await page.fill('input[name="password"]', INBERLIN_PASSWORD);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
        }

        // Открываем страницу с твоими фильтрами
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(8000);

        // Делаем скриншот для отладки (первые запуски)
        // await page.screenshot({ path: '/tmp/debug.png' });

        // Читаем квартиры
        const apartments = await page.evaluate(() => {
            const results = [];

            // Метод 1: ищем строки с текстом "X Zimmer" и ссылками
            document.querySelectorAll('li').forEach(li => {
                const text = li.innerText || '';
                if (!text.includes('Zimmer') || !text.includes('€')) return;

                const link = li.querySelector('a[href]');
                let href = link ? link.href : '';
                if (!href || href.includes('ueber-uns') || href.includes('/unternehmen/')) return;

                const idMatch = href.match(/\/expose\/(\d+)/);
                const id = idMatch ? idMatch[1] : null;
                if (!id) return;

                results.push({
                    id,
                    href,
                    text: text.trim().replace(/\s+/g, ' ').substring(0, 200)
                });
            });

            // Метод 2: если ничего не нашли через li — ищем напрямую по expose ссылкам
            if (results.length === 0) {
                document.querySelectorAll('a[href*="/expose/"]').forEach(a => {
                    const href = a.href;
                    const idMatch = href.match(/\/expose\/(\d+)/);
                    const id = idMatch ? idMatch[1] : null;
                    if (!id) return;

                    // Берём текст из ближайшего родителя
                    const parent = a.closest('li, div, article') || a;
                    const text = (parent.innerText || a.innerText || '').trim().replace(/\s+/g, ' ').substring(0, 200);

                    results.push({ id, href, text });
                });
            }

            return results;
        });

        // Дедупликация по id
        const unique = new Map();
        for (const apt of apartments) {
            if (!unique.has(apt.id)) unique.set(apt.id, apt);
        }

        console.log(`Прочитано квартир: ${unique.size}`);
        return unique;

    } catch (e) {
        console.error('Ошибка парсинга:', e.message);
        return new Map();
    } finally {
        await browser.close();
    }
}

async function check() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Проверка...`);

    const current = await getApartments();
    if (current.size === 0) {
        console.log('Сайт не вернул квартир, пропускаем');
        return;
    }

    if (isFirstRun) {
        // Первый запуск — просто запоминаем всё что есть, молчим
        knownApartments = current;
        isFirstRun = false;
        save();
        console.log(`Первый запуск: запомнили ${knownApartments.size} квартир, следим за изменениями`);
        return;
    }

    // Новые квартиры (появились)
    for (const [id, apt] of current) {
        if (!knownApartments.has(id)) {
            console.log(`НОВАЯ: ${id}`);
            await sendTelegram(
                `🏠 <b>Новая квартира!</b>\n\n📍 ${apt.text}`,
                apt.href
            );
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // Исчезнувшие квартиры
    const disappeared = [];
    for (const [id] of knownApartments) {
        if (!current.has(id)) disappeared.push(id);
    }
    if (disappeared.length > 0) {
        const prevCount = knownApartments.size;
        const newCount = current.size;
        await sendTelegram(
            `📉 Квартир стало меньше: было <b>${prevCount}</b>, стало <b>${newCount}</b>`
        );
    }

    knownApartments = current;
    save();
}

async function main() {
    load();
    console.log('🤖 Бот запущен');
    await check();
    setInterval(check, CHECK_INTERVAL);
}

main().catch(console.error);
