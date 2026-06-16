'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

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

  tgToken:
    process.env.TELEGRAM_TOKEN ||
    '',

  tgChatId:
    process.env.TELEGRAM_CHAT_ID ||
    '',

  maxRent: 600,
  rooms: 3,

  intervalMs: 5 * 60 * 1000,

  baseUrl: 'https://www.inberlinwohnen.de',
  loginUrl: 'https://www.inberlinwohnen.de/mein-bereich/',
  finderUrl: 'https://www.inberlinwohnen.de/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

// ================= STATE =================

const STATE_FILE = path.join(CONFIG.outDir, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { apartments: {}, lastCount: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

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
    log('TG error', e.message);
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

// ================= LOGIN =================

async function login(page) {
  log('LOGIN...');

  await page.goto(CONFIG.loginUrl, {
    waitUntil: 'commit',
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  // cookies
  try {
    await page.click('#onetrust-accept-btn-handler', { timeout: 2000 });
  } catch {}

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

// ================= SCRAPER =================

async function scrape(page) {
  log('OPEN FINDER');

  await page.goto(CONFIG.finderUrl, {
    waitUntil: 'commit',
    timeout: 60000,
  });

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

  log('FOUND:', list.length);

  return list;
}

// ================= RUN =================

let first = true;

async function run() {
  let page;

  try {
    const b = await getBrowser();
    const ctx = await b.newContext();
    page = await ctx.newPage();

    await login(page);

    const apartments = await scrape(page);

    const prev = state.apartments || {};
    const prevIds = new Set(Object.keys(prev));

    const added = apartments.filter(a => !prevIds.has(a.id));

    if (first) {
      first = false;
      await tgSend(`🤖 Bot started\nFound: ${apartments.length}`);
    }

    for (const a of added) {
      await tgSend(
        `🏠 NEW APARTMENT\n${a.rooms} rooms | ${a.size} m² | ${a.rent} €`
      );
    }

    state.apartments = Object.fromEntries(
      apartments.map(a => [a.id, a])
    );

    saveState(state);

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
