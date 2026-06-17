'use strict';
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');

const CONFIG = {
    loginUrl: 'https://www.inberlinwohnen.de/login/',
    finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
    login: process.env.INBERLIN_EMAIL,
    password: process.env.INBERLIN_PASSWORD,
    tgToken: process.env.TELEGRAM_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID,
    intervalMs: 300000, // 5 минут
    seenPath: './seen.json'
};

let seen = new Set(fs.existsSync(CONFIG.seenPath) ? JSON.parse(fs.readFileSync(CONFIG.seenPath)) : []);

async function tg(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: CONFIG.tgChatId, text, parse_mode: 'HTML'
        });
    } catch (e) { console.error('TG Error:', e.message); }
}

// КРИТИЧЕСКИЙ FIX: Безопасная навигация, которая не крашит бота
async function safeGoto(page, url) {
    try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!resp) return false;
        
        const ct = resp.headers()['content-type'] || '';
        // Если сервер отдал файл вместо страницы — выходим
        if (ct.includes('octet-stream') || ct.includes('pdf') || resp.status() >= 400) return false;
        
        return true;
    } catch (e) {
        console.log('Nav failed:', e.message);
        return false;
    }
}

async function runCycle() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 1. Логин
        if (!(await safeGoto(page, CONFIG.loginUrl))) return;
        
        await page.fill('input[name="email"]', CONFIG.login);
        await page.fill('input[name="password"]', CONFIG.password);
        await page.click('button[type="submit"]');
        await page.waitForTimeout(5000);

        // 2. Поиск
        if (!(await safeGoto(page, CONFIG.finderUrl))) return;
        await page.waitForSelector('a[href*="/expose/"]', { timeout: 20000 }).catch(() => {});

        const links = await page.$$eval('a[href*="/expose/"]', els => els.map(e => e.href));
        
        for (const url of [...new Set(links)]) {
            if (!seen.has(url)) {
                seen.add(url);
                fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));
                await tg(`🏠 <b>New flat:</b>\n${url}`);
            }
        }
    } catch (e) {
        console.error('Cycle error:', e.message);
    } finally {
        await browser.close();
    }
}

// Бесконечный цикл с ожиданием
async function startService() {
    while (true) {
        await runCycle();
        await new Promise(r => setTimeout(r, CONFIG.intervalMs));
    }
}

startService();
