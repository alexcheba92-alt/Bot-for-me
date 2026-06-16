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

  loginUrl: 'https://www.inberlinwohnen.de/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
}

// ---------------- TELEGRAM ----------------
async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3500),
      parse_mode: 'HTML',
    });
  } catch (e) {
    log('TG ERROR', e.message);
  }
}

// ---------------- SAFE LOAD (NO goto CRASH) ----------------
async function safeLoad(page, url) {
  log('LOAD (safe):', url);

  const res = await page.evaluate(async (u) => {
    const r = await fetch(u, {
      credentials: 'include',
      headers: {
        'user-agent': navigator.userAgent
      }
    });
    return await r.text();
  }, url);

  if (!res || res.length < 1000) {
    throw new Error('BLOCKED OR EMPTY RESPONSE');
  }

  await page.setContent(res, { waitUntil: 'domcontentloaded' });
}

// ---------------- LOGIN ----------------
async function login(page) {
  log('LOGIN...');

  await safeLoad(page, CONFIG.loginUrl);

  const email = page.locator('input[type="email"], input[name*="email"], input[name*="user"], input[name*="log"]').first();
  const pass = page.locator('input[type="password"]').first();

  if (!(await email.isVisible().catch(() => false))) {
    log('LOGIN FORM NOT FOUND → skipping login');
    return;
  }

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  const btn = page.locator('button[type="submit"], input[type="submit"]').first();

  if (await btn.count().catch(() => 0)) {
    await btn.click().catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(4000);
}

// ---------------- SCRAPE ----------------
async function scrape(page) {
  log('SCRAPE...');

  await safeLoad(page, CONFIG.finderUrl);

  await page.waitForTimeout(4000);

  const data = await page.evaluate(() => {
    const out = [];

    document.querySelectorAll('article, li, div').forEach(el => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 60) return;

      if (!/\d+\s*Zimmer/i.test(t) && !/\d+\s*€/i.test(t)) return;

      const a = el.querySelector?.('a[href]');
      out.push({
        text: t,
        href: a ? a.href : ''
      });
    });

    return out;
  });

  return data.map(x => {
    const r = x.text.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i);
    const s = x.text.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    const p = x.text.match(/(\d+(?:[.,]\d+)?)\s*€/i);

    return {
      rooms: r ? r[1] : '',
      size: s ? s[1] : '',
      rent: p ? p[1] : '',
      href: x.href,
    };
  });
}

// ---------------- RUN ----------------
async function run() {
  let browser, page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const ctx = await browser.newContext();
    page = await ctx.newPage();

    await login(page);

    const list = await scrape(page);

    log('FOUND:', list.length);

    if (!list.length) {
      await tgSend('⚠️ No apartments found (site blocked or changed)');
      return;
    }

    const msg =
      `🏠 <b>Found:</b> ${list.length}\n\n` +
      list.slice(0, 5).map(a =>
        `• ${a.rooms} Zimmer | ${a.size} m² | ${a.rent} €\n${a.href}`
      ).join('\n\n');

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

// ---------------- START ----------------
(async () => {
  log('BOT STARTED');
  await run();
  setInterval(run, CONFIG.intervalMs);
})();
