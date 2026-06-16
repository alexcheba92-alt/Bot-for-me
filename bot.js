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

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

const logFile = path.join(CONFIG.outDir, 'bot.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ');
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

/* ================= TELEGRAM FIX ================= */

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) {
    log('TG SKIP: missing token/chatId');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,
      {
        chat_id: String(CONFIG.tgChatId),
        text: String(text).slice(0, 3800),
      },
      { timeout: 20000 }
    );
  } catch (e) {
    log('TG ERROR:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
  }
}

/* ================= FIX: DOWNLOAD BLOCK ================= */

async function createContext(browser) {
  const context = await browser.newContext();

  // 🔥 КЛЮЧЕВОЙ ФИКС: убирает "Download is starting"
  await context.route('**/*', (route) => {
    const req = route.request();
    const resource = req.resourceType();

    // блокируем странные download/attachment ответы
    if (resource === 'document' && req.headers()['content-disposition']) {
      return route.abort();
    }

    route.continue();
  });

  return context;
}

/* ================= SAFE NAV ================= */

async function safeGoto(page, url) {
  log('NAVIGATE:', url);

  try {
    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (!res) throw new Error('NO RESPONSE');

    const headers = res.headers();
    if (headers['content-disposition']) {
      throw new Error('BLOCKED DOWNLOAD RESPONSE');
    }

    await page.waitForTimeout(3000);
  } catch (e) {
    log('NAV FAIL:', e.message);
    throw e;
  }
}

/* ================= LOGIN (ROBUST) ================= */

async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);

  await page.waitForTimeout(3000);

  const emailSelectors = [
    'input[type="email"]',
    'input[name*="email"]',
    'input[name*="user"]',
    'input[name*="login"]',
  ];

  const passSelectors = [
    'input[type="password"]',
    'input[name*="pass"]',
  ];

  let emailInput, passInput;

  for (const s of emailSelectors) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) {
      emailInput = el;
      break;
    }
  }

  for (const s of passSelectors) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) {
      passInput = el;
      break;
    }
  }

  if (!emailInput || !passInput) {
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_error.png') });
    throw new Error('LOGIN FIELDS NOT FOUND (site changed or iframe)');
  }

  await emailInput.fill(CONFIG.login);
  await passInput.fill(CONFIG.password);

  const btn = page.locator('button[type="submit"], input[type="submit"]').first();

  if (await btn.count()) {
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      btn.click({ force: true }),
    ]);
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(4000);

  log('LOGIN DONE URL:', page.url());
}

/* ================= SCRAPE FIX ================= */

async function scrape(page) {
  log('OPEN FINDER...');

  await safeGoto(page, CONFIG.finderUrl);

  await page.waitForTimeout(5000);

  const cards = await page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll('a, article, li, div'))
      .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 60);

    return texts.filter(t =>
      /\d+\s*Zimmer/i.test(t) &&
      /\d+\s*m²/i.test(t)
    ).slice(0, 20);
  });

  const parsed = cards.map(t => ({ text: t }));

  log('FOUND:', parsed.length);

  return parsed;
}

/* ================= MAIN ================= */

let browser;

async function run() {
  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
    }

    const ctx = await createContext(browser);
    const page = await ctx.newPage();

    await login(page);
    const data = await scrape(page);

    const msg = data.length
      ? `🏠 Found: ${data.length}`
      : `⚠️ No apartments found`;

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
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
