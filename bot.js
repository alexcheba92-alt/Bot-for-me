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

  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
  loginUrl: 'https://www.inberlinwohnen.de/mein-bereich/',

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
    }, { timeout: 20000 });
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

async function safeGoto(page, url) {
  try {
    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (!res) throw new Error('No response');
    return res;
  } catch (e) {
    log('NAV ERROR:', e.message);
    throw e;
  }
}

async function closePopups(page) {
  try {
    const btn = page.locator('button:has-text("Alle akzeptieren"), button:has-text("Akzeptieren")').first();
    if (await btn.count()) {
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch {}
}

async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);
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

  await page.waitForTimeout(5000);

  log('LOGIN OK');
}

async function scrape(page) {
  log('OPEN FINDER...');

  await safeGoto(page, CONFIG.finderUrl);
  await closePopups(page);

  await page.waitForTimeout(3000);

  // 🔥 ВАЖНО: запускаем поиск
  const searchBtn = page.locator('button:has-text("Suchen"), button:has-text("Filtern"), button[type="submit"]').first();

  if (await searchBtn.count()) {
    await searchBtn.click({ force: true }).catch(() => {});
    log('SEARCH CLICKED');
  }

  await page.waitForTimeout(7000);

  const cards = await page.evaluate(() => {
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

  const parsed = cards.map(c => ({
    rooms: (c.text.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i) || [])[1],
    size: (c.text.match(/(\d+(?:[.,]\d+)?)\s*m²/i) || [])[1],
    rent: (c.text.match(/(\d{2,4}(?:[.,]\d+)?)\s*€/i) || [])[1],
    href: c.href
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
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
    }

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await login(page);

    const apartments = await scrape(page);

    if (!apartments.length) {
      await tgSend('⚠️ No apartments found (check site structure)');
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
