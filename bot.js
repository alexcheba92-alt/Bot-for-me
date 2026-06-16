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

  maxRent: Number(process.env.MAX_RENT || 600),
  rooms: Number(process.env.ROOMS || 3),
  intervalMs: Number(process.env.INTERVAL_MS || 5 * 60 * 1000),

  baseUrl: 'https://www.inberlinwohnen.de/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
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
 * 🔥 FIX: убирает "Download is starting"
 */
async function safeGoto(page, url) {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (!response) return;

  const headers = response.headers?.() || {};
  const ct = headers['content-type'] || '';

  if (
    ct.includes('octet-stream') ||
    headers['content-disposition']
  ) {
    throw new Error('BLOCKED DOWNLOAD RESPONSE (site protection)');
  }

  await page.waitForTimeout(1500);
}

async function closePopups(page) {
  try {
    await page.locator('button:has-text("Alle akzeptieren"), button:has-text("Akzeptieren")')
      .first()
      .click({ force: true })
      .catch(() => {});
  } catch {}
}

/**
 * 🔐 LOGIN FIXED (не через /mein-bereich)
 */
async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.baseUrl);

  await closePopups(page);

  const email = page.locator('input[type="email"], input[name*="email"], input[name*="user"], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();

  await email.waitFor({ timeout: 20000 }).catch(() => {});
  await pass.waitFor({ timeout: 20000 }).catch(() => {});

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  const btn = page.locator('button[type="submit"], input[type="submit"]').first();

  if (await btn.count()) {
    await btn.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(6000);

  log('LOGIN DONE:', page.url());
}

/**
 * 🔎 FINDER FIX
 */
async function scrape(page) {
  log('OPEN FINDER...');

  await safeGoto(page, CONFIG.finderUrl);
  await closePopups(page);

  await page.waitForTimeout(4000);

  // 🔥 обязательно запускаем поиск
  const btn = page.locator('button:has-text("Suchen"), button:has-text("Filtern"), button[type="submit"]').first();

  if (await btn.count()) {
    await btn.click({ force: true }).catch(() => {});
    log('SEARCH CLICKED');
  }

  await page.waitForTimeout(7000);

  const results = await page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('a, div, li, article');

    for (const el of nodes) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();

      if (!text || text.length < 60) continue;

      const hasRoom = /\d+(?:[.,]\d+)?\s*Zimmer/i.test(text);
      const hasPrice = /\d{2,4}(?:[.,]\d+)?\s*€/i.test(text);

      if (hasRoom && hasPrice) {
        const a = el.querySelector('a[href]');
        out.push({
          text,
          href: a ? a.href : null
        });
      }
    }

    return out.slice(0, 50);
  });

  const parsed = results.map(r => ({
    rooms: (r.text.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i) || [])[1],
    size: (r.text.match(/(\d+(?:[.,]\d+)?)\s*m²/i) || [])[1],
    rent: (r.text.match(/(\d{2,4}(?:[.,]\d+)?)\s*€/i) || [])[1],
    href: r.href
  }));

  const filtered = parsed.filter(x => x.rooms || x.rent || x.size);

  log('FOUND:', filtered.length);

  return filtered;
}

let browser;

async function run() {
  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ]
      });
    }

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      locale: 'de-DE',
      viewport: { width: 1280, height: 800 }
    });

    const page = await ctx.newPage();

    await login(page);
    const apartments = await scrape(page);

    if (!apartments.length) {
      await tgSend('⚠️ No apartments found (site structure changed or blocked)');
      return;
    }

    const msg =
      `🏠 Found: ${apartments.length}\n\n` +
      apartments.slice(0, 5).map(a =>
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
    log('MISSING CREDENTIALS');
    process.exit(1);
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
