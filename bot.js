'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================

const CONFIG = {
  login:
    process.env.IBW_LOGIN ||
    process.env.INBERLIN_EMAIL ||
    '',

  password:
    process.env.IBW_PASSWORD ||
    process.env.INBERLIN_PASSWORD ||
    '',

  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',

  maxRent: 600,
  rooms: 3,

  intervalMs: 5 * 60 * 1000,

  loginUrl: 'https://www.inberlinwohnen.de/mein-bereich/',
  finderUrl: 'https://www.inberlinwohnen.de/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

// ================= LOG =================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ================= TELEGRAM =================

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,
      {
        chat_id: CONFIG.tgChatId,
        text,
        parse_mode: 'HTML',
      }
    );
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

// ================= BROWSER =================

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ],
    });
  }
  return browser;
}

// ================= SAFE GOTO (ВАЖНО FIX) =================

async function safeGoto(page, url) {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  if (!response) {
    throw new Error('No response from server');
  }

  const headers = response.headers();

  log('STATUS:', response.status());
  log('CONTENT-TYPE:', headers['content-type'] || 'unknown');

  if (headers['content-disposition']) {
    throw new Error('Server returned download instead of page');
  }

  return response;
}

// ================= LOGIN =================

async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);

  await page.waitForTimeout(4000);

  const email = await page.$('input[type="email"], input[name*="log"], input[name*="user"]');
  const pass = await page.$('input[type="password"]');

  if (!email || !pass) {
    throw new Error('Login fields not found');
  }

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  const btn = await page.$('button[type="submit"], input[type="submit"]');

  if (btn) await btn.click();
  else await page.keyboard.press('Enter');

  await page.waitForTimeout(5000);

  const html = await page.content();

  if (!html.includes('Wohn') && !html.includes('Mein')) {
    throw new Error('Login failed');
  }

  log('LOGIN OK');
}

// ================= SCRAPE =================

async function scrape(page) {
  log('OPEN FINDER');

  await safeGoto(page, CONFIG.finderUrl);

  await page.waitForTimeout(6000);

  const html = await page.content();

  const regex =
    /(\d{1,2})\s*Zimmer.*?(\d{2,3}[.,]\d{0,2})\s*m².*?(\d{3,4}[.,]\d{0,2})\s*€/gms;

  const list = [];
  let m;

  while ((m = regex.exec(html)) !== null) {
    list.push({
      id: m[0],
      rooms: m[1],
      size: m[2],
      rent: m[3],
    });
  }

  log('FOUND APARTMENTS:', list.length);

  return list;
}

// ================= RUN =================

async function run() {
  let page;

  try {
    const b = await getBrowser();
    const ctx = await b.newContext();
    page = await ctx.newPage();

    await login(page);

    const apartments = await scrape(page);

    if (apartments.length === 0) {
      await tgSend('⚠️ No apartments found (parser issue or site change)');
      return;
    }

    const msg =
      `🏠 Found apartments: ${apartments.length}\n` +
      apartments
        .slice(0, 5)
        .map(a => `${a.rooms} rooms | ${a.size} m² | ${a.rent} €`)
        .join('\n');

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend(`⚠️ ERROR:\n${e.message}`);
  } finally {
    if (page) await page.close();
  }
}

// ================= START =================

(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING CREDENTIALS');
    return;
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
