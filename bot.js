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
    intervalMs: 300000,
    seenPath: './out/seen.json'
};

let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
    try {
        seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath)));
    } catch {}
}

async function tg(text) {
    if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
            chat_id: CONFIG.tgChatId,
            text
        });
    } catch (e) {
        console.log('[TG ERROR]', e.message);
    }
}

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

async function safeGoto(page, url) {
    try {
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });

        if (!response) return { ok: false, reason: 'NO_RESPONSE' };

        const headers = response.headers();
        const ct = headers['content-type'] || '';
        const cd = headers['content-disposition'] || '';

        if (
            ct.includes('octet-stream') ||
            ct.includes('application/pdf') ||
            cd.includes('attachment')
        ) {
            return { ok: false, reason: 'FILE_RESPONSE' };
        }

        return { ok: true };

    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function runCycle() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        log('START CYCLE');

        // LOGIN PAGE
        const loginNav = await safeGoto(page, CONFIG.loginUrl);
        if (!loginNav.ok) {
            log('LOGIN NAV FAILED:', loginNav.reason);
            await tg(`⚠️ LOGIN FAILED: ${loginNav.reason}`);
            return;
        }

        await page.fill('input[type="email"], input[name="email"]', CONFIG.login);
        await page.fill('input[type="password"]', CONFIG.password);
        await page.click('button[type="submit"]');

        await page.waitForTimeout(5000);

        // FINDER PAGE
        const finderNav = await safeGoto(page, CONFIG.finderUrl);
        if (!finderNav.ok) {
            log('FINDER NAV FAILED:', finderNav.reason);
            await tg(`⚠️ FINDER FAILED: ${finderNav.reason}`);
            return;
        }

        await page.waitForSelector('a[href*="/expose/"]', { timeout: 20000 });

        const links = await page.$$eval('a[href*="/expose/"]', els =>
            [...new Set(els.map(e => e.href))]
        );

        log('FOUND:', links.length);

        for (const url of links) {
            if (seen.has(url)) continue;

            seen.add(url);
            fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));

            await tg(`🏠 New flat:\n${url}`);
        }

    } catch (e) {
        log('CYCLE ERROR:', e.message);
    } finally {
        await browser.close();
    }
}

async function startService() {
    log('SERVICE STARTED');

    while (true) {
        await runCycle().catch(e => log('FATAL:', e.message));

        await new Promise(r => setTimeout(r, CONFIG.intervalMs));
    }
}

startService();
