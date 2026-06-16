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
  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  const line = `${ts()} ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
}

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    const safeText = String(text || 'empty message').slice(0, 3500);
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: safeText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 20000 });
  } catch (e) {
    log('TG ERROR:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
  }
}

async function safeGoto(page, url) {
  const res = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  if (!res) throw new Error(`No response for ${url}`);
  const headers = res.headers() || {};
  if (headers['content-disposition']) {
    throw new Error(`Blocked download response at ${url}`);
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  return res;
}

async function closePopups(page) {
  const selectors = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("I agree")',
    '#acceptAll',
    '#uc-btn-accept-banner',
    '[aria-label*="accept" i]',
    '[class*="cookie" i] button',
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          await loc.click({ force: true }).catch(() => {});
          log('COOKIE CLOSED:', sel);
          await page.waitForTimeout(1200);
          return;
        }
      }
    } catch {}
  }

  try {
    await page.evaluate(() => {
      document.querySelectorAll('div, section, aside').forEach(el => {
        const t = (el.innerText || '').toLowerCase();
        if (t.includes('cookie') || t.includes('privacy') || t.includes('datenschutz')) {
          el.remove();
        }
      });
    });
  } catch {}
}

async function dumpState(page, name, extra = {}) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  const data = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    ...extra,
    bodyTextPreview: bodyText.slice(0, 8000),
    htmlLength: html.length,
  };

  fs.writeFileSync(path.join(CONFIG.outDir, `${name}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(CONFIG.outDir, `${name}.html`), html);
  fs.writeFileSync(path.join(CONFIG.outDir, `${name}.txt`), bodyText);
  await page.screenshot({ path: path.join(CONFIG.outDir, `${name}.png`), fullPage: true }).catch(() => {});
}

async function login(page) {
  log('LOGIN...');
  await safeGoto(page, CONFIG.loginUrl);
  await closePopups(page);

  const email = page.locator('input[type="email"], input[name*="email"], input[name*="log"], input[name*="user"]').first();
  const pass = page.locator('input[type="password"]').first();

  await email.waitFor({ state: 'visible', timeout: 20000 });
  await pass.waitFor({ state: 'visible', timeout: 20000 });

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.count()) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      submit.click({ force: true }),
    ]);
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  const url = page.url();
  if (!/mein-bereich|wohnungsfinder/i.test(url)) {
    log('POST-LOGIN URL:', url);
  }

  await dumpState(page, 'after_login', { phase: 'after_login' });
  log('LOGIN OK');
}

function parseCardText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const roomsMatch = cleaned.match(/(\d+(?:[.,]\d+)?)\s*Zimmer/i);
  const sizeMatch = cleaned.match(/(\d{1,3}(?:[.,]\d+)?)\s*m²/i);
  const rentMatch = cleaned.match(/(\d{2,4}(?:[.,]\d+)?)\s*€/i);

  return {
    rooms: roomsMatch ? roomsMatch[1] : null,
    size: sizeMatch ? sizeMatch[1] : null,
    rent: rentMatch ? rentMatch[1] : null,
    text: cleaned,
  };
}

async function scrape(page) {
  log('OPEN FINDER...');
  await safeGoto(page, CONFIG.finderUrl);
  await closePopups(page);

  await page.waitForTimeout(2500);
  await dumpState(page, 'finder_page', { phase: 'finder_opened' });

  const candidates = await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    const nodes = Array.from(document.querySelectorAll('a, article, li, div'));
    for (const el of nodes) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 40) continue;

      const hasRooms = /\d+(?:[.,]\d+)?\s*Zimmer/i.test(text);
      const hasArea = /\d{1,3}(?:[.,]\d+)?\s*m²/i.test(text);
      const hasPrice = /\d{2,4}(?:[.,]\d+)?\s*€/i.test(text);

      if ((hasRooms && hasArea) || (hasRooms && hasPrice)) {
        const a = el.querySelector?.('a[href]');
        const href = a ? a.href : (el.href || '');
        const key = `${text.slice(0, 220)}|${href}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ text, href });
        }
      }
    }

    return out;
  });

  const list = candidates.map(c => {
    const parsed = parseCardText(c.text);
    return { ...parsed, href: c.href };
  }).filter(x => x.rooms || x.size || x.rent);

  log('FOUND:', list.length);
  return list;
}

let browser = null;
let running = false;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browser;
}

async function run() {
  if (running) {
    log('SKIP: previous run still running');
    return;
  }

  running = true;
  let page;

  try {
    const b = await getBrowser();
    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      locale: 'de-DE',
      viewport: { width: 1440, height: 900 },
    });

    page = await ctx.newPage();
    page.setDefaultTimeout(20000);

    await login(page);
    const apartments = await scrape(page);

    const msg = apartments.length
      ? `🏠 <b>Found:</b> ${apartments.length}\n\n` + apartments.slice(0, 5).map(a => {
          const parts = [];
          if (a.rooms) parts.push(`${a.rooms} rooms`);
          if (a.size) parts.push(`${a.size} m²`);
          if (a.rent) parts.push(`${a.rent} €`);
          return `• ${parts.join(' | ')}${a.href ? `\n${a.href}` : ''}`;
        }).join('\n\n')
      : `⚠️ No apartments parsed.\nCheck <code>out/finder_page.html</code> and <code>out/finder_page.txt</code>.`;

    await tgSend(msg);
    log('RUN DONE');
  } catch (e) {
    log('ERROR:', e.stack || e.message);
    await tgSend(`⚠️ ERROR:\n${String(e.message).slice(0, 3000)}`);
  } finally {
    if (page) await page.close().catch(() => {});
    running = false;
  }
}

(async () => {
  log('BOT STARTED');
  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING LOGIN OR PASSWORD');
    process.exitCode = 1;
    return;
  }

  await run();
  setInterval(() => {
    run().catch(err => log('INTERVAL ERROR:', err.stack || err.message));
  }, CONFIG.intervalMs);
})();
