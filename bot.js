'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  login: process.env.IBW_LOGIN || process.env.INBERLIN_EMAIL || '',
  password: process.env.IBW_PASSWORD || process.env.INBERLIN_PASSWORD || '',
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',

  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
  baseUrl: 'https://www.inberlinwohnen.de/',

  intervalMs: Number(process.env.INTERVAL_MS || 5 * 60 * 1000),
  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
}

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3500),
    });
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

/**
 * 🔥 ULTRA SAFE LOGIN (FIX TВОЕЙ ОШИБКИ)
 */
async function login(page) {
  log('LOGIN...');

  await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForTimeout(3000);

  // закрываем cookie
  try {
    await page.locator('button:has-text("Alle akzeptieren"), button:has-text("Akzeptieren")')
      .first().click({ force: true }).catch(() => {});
  } catch {}

  // 🔥 НЕ ЖДЁМ password напрямую (он часто НЕ СРАБАТЫВАЕТ)
  const emailSelectors = [
    'input[type="email"]',
    'input[name*="email"]',
    'input[name*="user"]',
    'input[type="text"]'
  ];

  let emailBox = null;

  for (const sel of emailSelectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      emailBox = el;
      break;
    }
  }

  if (!emailBox) {
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_error.png') });
    throw new Error('Email field not found');
  }

  await emailBox.fill(CONFIG.login);

  // 🔥 PASSWORD FIX — НЕ ЖДЁМ ЖЁСТКО
  let passBox = page.locator('input[type="password"]').first();

  let passFound = await passBox.count().catch(() => 0);

  if (passFound) {
    await passBox.fill(CONFIG.password);
  } else {
    log('PASSWORD FIELD NOT FOUND → fallback ENTER login');
  }

  // submit
  const btn = page.locator('button[type="submit"], input[type="submit"]').first();

  if (await btn.count().catch(() => 0)) {
    await btn.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(7000);

  log('LOGIN DONE URL:', page.url());
}

/**
 * 🔎 SCRAPER (простая стабильная версия)
 */
async function scrape(page) {
  log('OPEN FINDER...');

  await page.goto(CONFIG.finderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForTimeout(5000);

  // try click search
  const btn = page.locator('button:has-text("Suchen"), button:has-text("Filtern"), button[type="submit"]').first();
  if (await btn.count().catch(() => 0)) {
    await btn.click({ force: true }).catch(() => {});
  }

  await page.waitForTimeout(7000);

  const data = await page.evaluate(() => {
    const out = [];

    document.querySelectorAll('a, div, li, article').forEach(el => {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();

      if (!text || text.length < 60) return;

      if (/\d+(?:[.,]\d+)?\s*Zimmer/i.test(text) &&
          /\d{2,4}(?:[.,]\d+)?\s*€/i.test(text)) {

        const a = el.querySelector('a[href]');
        out.push({
          text,
          href: a ? a.href : null
        });
      }
    });

    return out.slice(0, 40);
  });

  const parsed = data.map(x => ({
    rooms: (x.text.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i) || [])[1],
    size: (x.text.match(/(\d+(?:[.,]\d+)?)\s*m²/i) || [])[1],
    rent: (x.text.match(/(\d{2,4}(?:[.,]\d+)?)\s*€/i) || [])[1],
    href: x.href
  }));

  log('FOUND:', parsed.length);

  return parsed;
}

/**
 * MAIN
 */
let browser;

async function run() {
  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
    }

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari',
      locale: 'de-DE'
    });

    const page = await ctx.newPage();

    await login(page);

    const res = await scrape(page);

    if (!res.length) {
      await tgSend('⚠️ No apartments found (site changed or blocked)');
      return;
    }

    const msg =
      `🏠 Found: ${res.length}\n\n` +
      res.slice(0, 5).map(a =>
        `• ${a.rooms || '?'} rooms | ${a.size || '?'} m² | ${a.rent || '?'} €\n${a.href || ''}`
      ).join('\n\n');

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR: ' + e.message);
  }
}

(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING CREDS');
    process.exit(1);
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
