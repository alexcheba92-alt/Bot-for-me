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

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
}

async function tg(text) {
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
 * FIXED NAVIGATION (убирает Download is starting)
 */
async function gotoSafe(page, url) {
  log('NAV:', url);

  const res = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  }).catch(e => {
    throw new Error('NAV FAIL: ' + e.message);
  });

  if (!res) throw new Error('NO RESPONSE');

  const ct = res.headers()['content-type'] || '';

  if (!ct.includes('text/html')) {
    const txt = await res.text().catch(() => '');
    fs.writeFileSync(path.join(CONFIG.outDir, 'blocked.html'), txt);
    throw new Error('BLOCKED OR NON-HTML RESPONSE: ' + ct);
  }

  return res;
}

async function launch() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

async function context(browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
    locale: 'de-DE',
    viewport: { width: 1366, height: 768 }
  });
}

async function login(page) {
  log('LOGIN...');

  await gotoSafe(page, CONFIG.loginUrl);

  const email = page.locator('input[type="email"], input[name*="mail"]').first();
  const pass = page.locator('input[type="password"]').first();

  if (await email.count() === 0 || await pass.count() === 0) {
    fs.writeFileSync(path.join(CONFIG.outDir, 'login_fail.html'), await page.content());
    throw new Error('LOGIN FIELDS NOT FOUND (blocked or changed DOM)');
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
 * FIXED SCRAPER (WAIT + API + DOM fallback)
 */
async function scrape(page) {
  log('OPEN FINDER...');

  let apiData = [];

  page.on('response', async (res) => {
    try {
      const url = res.url();

      if (
        url.includes('wohnung') ||
        url.includes('api') ||
        url.includes('listing') ||
        url.includes('search')
      ) {
        const json = await res.json().catch(() => null);
        if (json) apiData.push(json);
      }
    } catch {}
  });

  await gotoSafe(page, CONFIG.finderUrl);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(8000);

  fs.writeFileSync(
    path.join(CONFIG.outDir, 'finder.html'),
    await page.content()
  );

  log('API FOUND:', apiData.length);

  let apartments = [];

  // 🔥 API PARSE
  for (const d of apiData) {
    const items =
      d?.items ||
      d?.data ||
      d?.results ||
      d?.apartments ||
      [];

    for (const i of items) {
      apartments.push({
        rooms: i.rooms || i.zimmer,
        size: i.size || i.area,
        rent: i.rent || i.kaltmiete,
        title: i.title || i.name,
        href: i.url || i.link
      });
    }
  }

  // 🔥 DOM fallback (если API пустой)
  if (!apartments.length) {
    const text = await page.evaluate(() => document.body.innerText);

    const matches = text.match(/\d+\s*Zimmer[\s\S]{0,200}?€/gi) || [];

    apartments = matches.map(m => ({ text: m }));
  }

  log('FOUND:', apartments.length);

  return apartments;
}

async function run() {
  let browser;

  try {
    browser = await launch();
    const ctx = await context(browser);
    const page = await ctx.newPage();

    await login(page);

    const data = await scrape(page);

    if (!data.length) {
      await tg('⚠️ No apartments (blocked or API changed)');
      return;
    }

    await tg(
      `🏠 <b>Found:</b> ${data.length}\n\n` +
      data.slice(0, 8).map(d =>
        d.text
          ? `• ${d.text}`
          : `• ${d.rooms || '?'} rooms | ${d.size || '?'} m² | ${d.rent || '?'}€`
      ).join('\n')
    );

  } catch (e) {
    log('ERROR:', e.message);
    await tg('⚠️ ERROR:\n' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING ENV');
    return;
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
