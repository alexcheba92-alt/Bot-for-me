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

let knownApartments = new Map();
let isFirstRun = true;
let diagDone = false;

function load() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
            knownApartments = new Map(data);
            isFirstRun = false;
        }
    } catch (e) {}
}

function save() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...knownApartments])); } catch (e) {}
}

async function sendTelegram(text, url = null) {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: '📋 Открыть и подать заявку', url }]] };
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
    } catch (e) { console.error('TG:', e.message); }
}

async function login(page) {
    console.log('Открываю страницу логина...');
    await page.goto('https://www.inberlinwohnen.de/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Закрываем cookie если есть
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

    // Ждём поля email
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    console.log('Поле email найдено, вводим данные...');

    // Очищаем и вводим email
    await page.click('input[name="email"]');
    await page.keyboard.selectAll();
    await page.keyboard.type(INBERLIN_EMAIL, { delay: 50 });

    // Очищаем и вводим пароль
    await page.click('input[name="password"]');
    await page.keyboard.selectAll();
    await page.keyboard.type(INBERLIN_PASSWORD, { delay: 50 });

    console.log('Данные введены, нажимаю Enter...');

    // Нажимаем Enter вместо кнопки — надёжнее
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    const url = page.url();
    console.log('URL после логина:', url);

    if (url.includes('/login')) {
        // Попробуем ещё раз через кнопку
        console.log('Всё ещё на логине, пробую кнопку...');
        try {
            await page.click('button[type="submit"]');
            await page.waitForTimeout(5000);
        } catch(e) {}
        console.log('URL после кнопки:', page.url());
    }

    return !page.url().includes('/login');
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
        const loggedIn = await login(page);
        
        if (!loggedIn) {
            console.log('ОШИБКА: Не удалось войти!');
            // Диагностика — что на странице?
            if (!diagDone) {
                diagDone = true;
                const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
                await sendTelegram(`❌ <b>Не могу войти на сайт!</b>\n\nСтраница показывает:\n${bodyText}\n\nПроверь email и пароль в переменных Railway.`);
            }
            return new Map();
        }

        console.log('Успешно вошёл! Открываю страницу с квартирами...');
        await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });

        // Ждём Zimmer на странице
        try {
            await page.waitForFunction(() => document.body.innerText.includes('Zimmer'), { timeout: 30000 });
            console.log('Квартиры загружены!');
        } catch(e) {
            console.log('Zimmer не появился за 30 сек');
        }

        await page.waitForTimeout(3000);

        // Диагностика после успешного входа
        if (!diagDone) {
            diagDone = true;
            const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 600));
            await sendTelegram(`✅ <b>Вход выполнен!</b>\n\nВот что видит бот:\n${bodyText}`);
        }

        // Читаем квартиры
        const apartments = await page.evaluate(() => {
            const results = [];
            const seen = new Set();

            document.querySelectorAll('li').forEach(el => {
                const text = el.innerText || '';
                if (!text.includes('Zimmer') || !text.includes('€')) return;
                const link = el.querySelector('a[href]');
                const href = link ? link.href : '';
                const idMatch = href.match(/\/expose\/(\d+)/);
                const id = idMatch ? idMatch[1] : ('li_' + text.substring(0, 40).replace(/\s/g,''));
                if (!seen.has(id)) {
                    seen.add(id);
                    results.push({ id, href, text: text.trim().replace(/\s+/g, ' ').substring(0, 200) });
                }
            });

            document.querySelectorAll('a[href*="/expose/"]').forEach(a => {
                const href = a.href;
                const idMatch = href.match(/\/expose\/(\d+)/);
                const id = idMatch ? idMatch[1] : null;
                if (id && !seen.has(id)) {
                    seen.add(id);
                    const parent = a.closest('li, article, div') || a;
                    results.push({ id, href, text: (parent.innerText || '').trim().replace(/\s+/g, ' ').substring(0, 200) });
                }
            });

            return results;
        });

        const unique = new Map();
        for (const apt of apartments) if (!unique.has(apt.id)) unique.set(apt.id, apt);
        console.log(`Квартир найдено: ${unique.size}`);
        return unique;

    } catch (e) {
        console.error('Ошибка:', e.message);
        return new Map();
    } finally {
        await browser.close();
    }
}

async function check() {
    const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${now}] Проверка...`);

    const current = await getApartments();
    if (current.size === 0) { console.log('0 квартир'); return; }

    if (isFirstRun) {
        knownApartments = current;
        isFirstRun = false;
        save();
        await sendTelegram(`✅ Бот видит <b>${knownApartments.size} квартир</b>. Молчу пока ничего не меняется.`);
        return;
    }

    for (const [id, apt] of current) {
        if (!knownApartments.has(id)) {
            await sendTelegram(`🏠 <b>Новая квартира!</b>\n\n📍 ${apt.text}`, apt.href || SEARCH_URL);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    let gone = 0;
    for (const [id] of knownApartments) if (!current.has(id)) gone++;
    if (gone > 0) await sendTelegram(`📉 Было <b>${knownApartments.size}</b>, стало <b>${current.size}</b>`);

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
