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
  maxRent: Number(process.env.MAX_RENT || 600),
  rooms: Number(process.env.ROOMS || 3),
  intervalMs: Number(process.env.INTERVAL_MS || 300000),

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
};

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3500),
      parse_mode: 'HTML'
    });
  } catch (e) {
    log('TG ERROR', e.message);
  }
}

/**
 * FIX 1: нормальный goto (убирает "download is starting")
 */
async function safeGoto(page, url) {
  log('NAV:', url);

  const response = await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: 60000
  }).catch(e => {
    throw new Error('NAV FAIL: ' + e.message);
  });

  if (!response) throw new Error('NO RESPONSE');

  const ct = response.headers()['content-type'] || '';

  // ❗ КЛЮЧЕВОЙ ФИКС
  if (!ct.includes('text/html')) {
    const body = await response.text().catch(() => '');
    fs.writeFileSync(path.join(CONFIG.outDir, 'blocked.html'), body);
    throw new Error('BLOCKED OR DOWNLOAD RESPONSE: ' + ct);
  }

  return response;
}

/**
 * FIX 2: stealth режим
 */
async function makeBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

async function makeContext(browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
    locale: 'de-DE',
    viewport: { width: 1366, height: 768 }
  });
}

/**
 * FIX 3: login (устойчивый)
 */
async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);

  const email = await page.locator('input[type="email"], input[name*="mail"]').first();
  const pass = await page.locator('input[type="password"]').first();

  // fallback если DOM сломан
  const emailCount = await email.count();
  const passCount = await pass.count();

  if (!emailCount || !passCount) {
    fs.writeFileSync(path.join(CONFIG.outDir, 'login_debug.html'), await page.content());
    throw new Error('LOGIN FIELDS NOT FOUND (site blocked or changed)');
  }

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
    page.click('button[type="submit"], input[type="submit"]').catch(() => {})
  ]);

  log('LOGIN OK:', page.url());
}

/**
 * FIX 4: scrape (более мягкий парсер)
 */
async function scrape(page) {
  await safeGoto(page, CONFIG.finderUrl);

  await page.waitForTimeout(5000);

  const html = await page.content();
  fs.writeFileSync(path.join(CONFIG.outDir, 'finder.html'), html);

  const text = await page.evaluate(() => document.body.innerText);

  const matches = text.match(/\d+\s*Zimmer[\s\S]{0,200}?€/gi) || [];

  const results = matches.slice(0, 10).map(m => ({
    text: m
  }));

  return results;
}

async function run() {
  let browser;

  try {
    browser = await makeBrowser();
    const ctx = await makeContext(browser);
    const page = await ctx.newPage();

    await login(page);

    const data = await scrape(page);

    if (!data.length) {
      await tgSend('⚠️ No apartments (blocked or DOM changed)');
      log('EMPTY RESULT');
      return;
    }

    await tgSend(
      `🏠 Found: ${data.length}\n\n` +
      data.map(d => `• ${d.text}`).join('\n')
    );

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('NO LOGIN/PASSWORD');
    return;
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
