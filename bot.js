'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// ======================= CONFIG =======================

const CONFIG = {
  login:
    process.env.IBW_LOGIN ||
    process.env.INBERLIN_EMAIL ||
    'EMPTY',

  password:
    process.env.IBW_PASSWORD ||
    process.env.INBERLIN_PASSWORD ||
    'EMPTY',

  tgToken:
    process.env.TELEGRAM_TOKEN ||
    'EMPTY',

  tgChatId:
    process.env.TELEGRAM_CHAT_ID ||
    'EMPTY',

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

// ======================= STATE =======================

const STATE_FILE = path.join(CONFIG.outDir, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { apartments: {}, lastCount: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ======================= LOG =======================

const LOG_FILE = path.join(CONFIG.outDir, 'bot.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ======================= TELEGRAM =======================

async function tgSend(text, extra = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    log('TG error:', e.message);
  }
}

// ======================= BROWSER =======================

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

// ======================= LOGIN =======================

async function login(page) {
  log('Login...');

  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(2000);

  // cookies accept
  try {
    await page.click('#onetrust-accept-btn-handler', { timeout: 2000 });
  } catch {}

  // email
  const emailInput = await page.$('input[type="email"], input[name*="log"], input[name*="user"]');
  if (!emailInput) throw new Error('Email field not found');

  await emailInput.fill(CONFIG.login);

  // password
  const passInput = await page.$('input[type="password"]');
  if (!passInput) throw new Error('Password field not found');

  await passInput.fill(CONFIG.password);

  // submit
  const btn = await page.$('button[type="submit"], input[type="submit"]');
  if (btn) await btn.click();
  else await page.keyboard.press('Enter');

  await page.waitForTimeout(4000);

  const ok = await page.content();

  if (!ok.includes('Mein') && !ok.includes('Wohn')) {
    throw new Error('Login failed');
  }

  log('Login OK');
}

// ======================= SCRAPE =======================

async function scrape(page) {
  log('Opening finder...');

  await page.goto(CONFIG.finderUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(5000);

  const html = await page.content();

  const blocks = html.split('\n');

  const apartments = [];

  const regex =
    /(\d{1,2})\s*Zimmer.*?(\d{2,3}[.,]\d{0,2})\s*m².*?(\d{3,4}[.,]\d{0,2})\s*€/gms;

  let m;

  while ((m = regex.exec(html)) !== null) {
    apartments.push({
      id: m[0],
      rooms: m[1],
      size: m[2],
      rent: m[3],
      ibwUrl: CONFIG.finderUrl,
    });
  }

  log('Found apartments:', apartments.length);

  return apartments;
}

// ======================= RUN =======================

let firstRun = true;

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
    const currIds = new Set(apartments.map(a => a.id));

    const added = apartments.filter(a => !prevIds.has(a.id));

    if (firstRun) {
      firstRun = false;
      await tgSend(`🤖 Bot started. Found: ${apartments.length}`);
    }

    for (const a of added) {
      await tgSend(
        `🏠 NEW:\n${a.rooms} rooms | ${a.size} m² | ${a.rent} €`
      );
    }

    state.apartments = Object.fromEntries(
      apartments.map(a => [a.id, a])
    );

    saveState(state);

  } catch (e) {
    log('ERROR:', e.message);

    await tgSend(`⚠️ Error:\n${e.message}`);
  } finally {
    if (page) await page.close();
  }
}

// ======================= START =======================

(async () => {
  log('BOT STARTED');

  await run();

  setInterval(run, CONFIG.intervalMs);
})();
