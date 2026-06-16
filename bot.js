'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL || process.env.IBW_LOGIN || '',
  password: process.env.INBERLIN_PASSWORD || process.env.IBW_PASSWORD || '',
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',

  maxRent: Number(process.env.MAX_RENT || 600),
  rooms: Number(process.env.ROOMS || 3),
  intervalMs: Number(process.env.INTERVAL_MS || 5 * 60 * 1000),

  loginUrl: 'https://www.inberlinwohnen.de/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
}

// ---------------- TELEGRAM ----------------
async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3500),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 20000 });
  } catch (e) {
    log('TG ERROR', e.message);
  }
}

// ---------------- SAFE NAV ----------------
async function safeGoto(page, url) {
  log('NAVIGATE:', url);

  const res = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(e => {
    throw new Error('NAV FAIL: ' + e.message);
  });

  // если сайт отдает "download response"
  const headers = res?.headers?.() || {};
  if (headers['content-disposition']) {
    throw new Error('BLOCKED DOWNLOAD RESPONSE');
  }

  await page.waitForTimeout(3000);
  return res;
}

// ---------------- POPUPS ----------------
async function closePopups(page) {
  const btns = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Zustimmen")',
    '#uc-btn-accept-banner',
  ];

  for (const b of btns) {
    const el = page.locator(b).first();
    if (await el.count().catch(() => 0)) {
      try {
        await el.click({ timeout: 2000 });
        log('COOKIE CLOSED');
        await page.waitForTimeout(1500);
        return;
      } catch {}
    }
  }

  // remove overlay fallback
  await page.evaluate(() => {
    document.querySelectorAll('div').forEach(d => {
      const t = (d.innerText || '').toLowerCase();
      if (t.includes('cookie') || t.includes('privacy')) d.remove();
    });
  }).catch(() => {});
}

// ---------------- LOGIN (ROBUST) ----------------
async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);
  await closePopups(page);

  // иногда сайт уже логин-редиректит → пропускаем
  const body = await page.content();
  if (body.includes('Wohnungsfinder') || page.url().includes('mein-bereich')) {
    log('ALREADY LOGGED IN');
    return;
  }

  // ищем поля (очень широкий поиск)
  const email = page.locator('input[type="email"], input[name*="email"], input[name*="user"], input[name*="log"]').first();
  const pass = page.locator('input[type="password"]').first();

  const emailVisible = await email.isVisible().catch(() => false);
  const passVisible = await pass.isVisible().catch(() => false);

  if (!emailVisible || !passVisible) {
    log('LOGIN FORM NOT FOUND → fallback mode');

    // иногда login через cookie session → просто идем дальше
    return;
  }

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Anmelden")').first();

  if (await submit.count().catch(() => 0)) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      submit.click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(4000);

  log('LOGIN DONE URL:', page.url());
}

// ---------------- SCRAPE ----------------
async function scrape(page) {
  log('OPEN FINDER');

  await safeGoto(page, CONFIG.finderUrl);
  await closePopups(page);

  await page.waitForTimeout(5000);

  // ждём JS загрузку (ВАЖНО!)
  await page.waitForLoadState('networkidle').catch(() => {});

  const data = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('article, li, div, a');

    for (const el of els) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 60) continue;

      const hasRooms = /\d+\s*Zimmer/i.test(text);
      const hasPrice = /\d+\s*€/i.test(text);
      const hasArea = /\d+\s*m²/i.test(text);

      if (!hasRooms && !hasPrice && !hasArea) continue;

      const a = el.querySelector?.('a[href]');
      const href = a ? a.href : el.href || '';

      out.push({ text, href });
    }

    return out;
  });

  log('RAW FOUND:', data.length);

  return data.map(x => {
    const r = x.text.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i);
    const s = x.text.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    const p = x.text.match(/(\d+(?:[.,]\d+)?)\s*€/i);

    return {
      rooms: r ? r[1] : '',
      size: s ? s[1] : '',
      rent: p ? p[1] : '',
      href: x.href,
      text: x.text.slice(0, 200),
    };
  });
}

// ---------------- RUN ----------------
let running = false;

async function run() {
  if (running) return;
  running = true;

  let browser, page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const ctx = await browser.newContext({
      locale: 'de-DE',
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();

    await login(page);

    const list = await scrape(page);

    const filtered = list.filter(a => {
      const r = parseFloat(a.rent || 0);
      const rm = parseFloat(a.rooms || 0);
      return (!r || r <= CONFIG.maxRent) && (!rm || rm >= CONFIG.rooms);
    });

    if (!filtered.length) {
      await tgSend('⚠️ No apartments found (site changed or blocked)');
      log('EMPTY RESULT');
      return;
    }

    const msg =
      `🏠 <b>Found:</b> ${filtered.length}\n\n` +
      filtered.slice(0, 5).map(a =>
        `• ${a.rooms} Zimmer | ${a.size} m² | ${a.rent} €\n${a.href}`
      ).join('\n\n');

    await tgSend(msg);
    log('DONE');

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
    running = false;
  }
}

// ---------------- START ----------------
(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING ENV VARS');
    process.exit(1);
  }

  await run();

  setInterval(run, CONFIG.intervalMs);
})();
