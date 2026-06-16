'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL || '',
  password: process.env.INBERLIN_PASSWORD || '',
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',
  intervalMs: 300000,

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/* ================= TELEGRAM SAFE ================= */

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: String(CONFIG.tgChatId),
      text: String(text).slice(0, 3900),
    });
  } catch (e) {
    log('TG ERROR', e.response?.data || e.message);
  }
}

/* ================= STEALTH BROWSER ================= */

async function createBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  return browser;
}

/* ================= FIX NAV (DOWNLOAD BUG) ================= */

async function safeGoto(page, url) {
  log('NAVIGATE:', url);

  try {
    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    if (!res) throw new Error('NO RESPONSE');

    const ct = res.headers()['content-type'] || '';

    // 🔥 CRITICAL FIX
    if (!ct.includes('text/html')) {
      log('NON HTML DETECTED → forcing reload');
      await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    }

    await page.waitForTimeout(5000);
  } catch (e) {
    if (e.message.includes('Download is starting')) {
      log('DOWNLOAD BLOCK → retry hard reload');

      await page.evaluate((u) => (location.href = u), url);
      await page.waitForTimeout(8000);
      return;
    }

    throw e;
  }
}

/* ================= ANTI BOT MASK ================= */

async function stealth(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });
}

/* ================= LOGIN ================= */

async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);

  await page.waitForTimeout(6000);

  const email = await page.$('input[type="email"], input[name*="mail"], input[name*="user"]');
  const pass = await page.$('input[type="password"]');

  if (!email || !pass) {
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_fail.png') });
    throw new Error('LOGIN FORM NOT FOUND');
  }

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  await page.keyboard.press('Enter');

  await page.waitForTimeout(8000);

  log('LOGIN DONE:', page.url());
}

/* ================= SCRAPER ================= */

async function scrape(page) {
  log('OPEN FINDER');

  await safeGoto(page, CONFIG.finderUrl);

  await page.waitForTimeout(8000);

  const data = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div, article, li')];

    return els
      .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(t =>
        t.length > 80 &&
        /\d+\s*Zimmer/i.test(t) &&
        /\d+\s*m²/i.test(t)
      )
      .slice(0, 30);
  });

  log('FOUND:', data.length);

  return data;
}

/* ================= MAIN ================= */

let browser;

async function run() {
  try {
    if (!browser) browser = await createBrowser();

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      locale: 'de-DE',
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();

    await stealth(page);

    await login(page);

    const data = await scrape(page);

    await tgSend(
      data.length
        ? `🏠 FOUND: ${data.length}`
        : `⚠️ No apartments (blocked or empty DOM)`
    );

    await page.close();
  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
  }
}

/* ================= LOOP ================= */

(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    throw new Error('Missing credentials');
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
